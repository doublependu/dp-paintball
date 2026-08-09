# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser paintball game: Three.js + Rapier3D, third-person, single-player against
NPC bots, set in a stylised Central Park. Hand-drawn look — Borderlands linework
over Ghibli colour and light. Nobody dies; hits are counters. Everything is
generated at runtime except one small GLB of park props, which is how it boots in
~1.4s.

`PROMPT.md` is the original brief. `PLAN.md` is the design of record and explains
*why* the big decisions went the way they did — read the relevant section before
changing a subsystem, and update it when a decision changes (§6 and §1/§3 already
carry mid-build revisions).

## Commands

```bash
npm run dev          # Vite dev server — the primary way to look at the game
npm run typecheck    # tsc --noEmit; strict, noUnusedLocals, noUnusedParameters
npm run build        # typecheck + vite build
npm run preview      # serves dist/ on :4173 — REQUIRED before any tools/ harness
```

Tests are headless-browser suites in `tools/`, not unit tests. **They all need a
server running at `http://localhost:4173/dp-paintball/`**, so `npm run build &&
npm run preview` first (or pass a dev-server URL as argv[2]).

```bash
npm test             # all 7 suites, sequential
npm run test:movement    # or :ballistics :paint :arena :character :bots :ui
node tools/bot-test.mjs http://localhost:5173/dp-paintball/   # single suite, custom URL

npm run capture      # 7 pinned viewpoints + rubric metrics -> captures/
npm run perf         # real-GPU frame times (needs a GPU; uses ANGLE/Vulkan)
npm run shoot        # one screenshot + diagnostics dump
```

`movement`, `ballistics` and `paint` run against `?scene=course` — a purpose-built
geometry gym whose coordinates those suites assert against by hand. Never change
`src/world/TestCourse.ts` geometry without re-checking them.

`captures/` is gitignored and holds ~93MB of development screenshots with an
annotated `captures/INDEX.md`.

Standalone dev pages, opened directly through the dev server: `rig-preview.html`
(character rig poses), `splat-preview.html` (procedural splat atlas).

**The user performs all git commits and pushes.** Do not commit.

## Architecture

### The system contract

`Game` (`src/core/Game.ts`) owns physics, renderer, input, event bus and RNG, and
steps a list of `System`s (`src/core/System.ts`) from a fixed-timestep loop.

- **Systems never reference each other.** Everything crossing a boundary goes
  through the typed `EventBus` (`src/core/Events.ts` — `GameEventMap` is the
  complete list of signals). The deliberate exceptions are shared-state objects
  passed explicitly at construction, e.g. `PlayerState`.
- **Registration order is execution order** and load-bearing. See the comment in
  `src/main.ts`: player writes `renderPosition` → camera reads it and writes
  `avatarOpacity` → the avatar reads both.
- `fixedUpdate(dt)` is simulation at exactly 60Hz. `update(dt, alpha)` is
  per-frame work only — interpolation, camera, animation sampling.

### `Loop.elapsed` vs `Loop.simElapsed`

`src/core/Loop.ts` clamps to `MAX_SUB_STEPS` and *drops* the backlog rather than
paying it off, so at low frame rates the game runs in slow motion. Wall clock and
simulated time then diverge.

**Anything gameplay-timed or test-asserted must use `simElapsed`**, exposed as
`window.__paintball.simTime()`. Every harness waits on it via a `waitSim()` helper
rather than `waitForTimeout`. A suite that regresses right after a rendering
change is usually hitting the substep ceiling, not a logic bug.

### Test hook

`window.__paintball` (declared at the bottom of `src/main.ts`) exposes the game,
player state, systems, `simTime()`, `bootTimings()` and a rolling `impacts` array.
Harnesses drive the game through it, not through synthetic input. Extend it rather
than inventing a second backdoor.

### Rendering — the NPR pipeline

`src/render/NprPipeline.ts`: scene → normal/depth prepass → bloom (half res) →
Sobel outline pass (AO folded in) → grade → output.

- Cool shadows come from a warm directional key against a cool hemisphere fill —
  zero shader work. Don't reach for a custom lighting model.
- Objects on `NO_OUTLINE_LAYER` (2) are skipped by the prepass. The sky lives
  there; so does the character hull.
- **The prepass swaps materials per mesh, not via `scene.overrideMaterial`.** An
  override replaces the vertex shader too, so skinned characters render into the
  normal buffer in bind pose — the visible symptom is no outline on the body, a
  phantom outline at the feet, and scenery outlines drawn *through* the character.
  A mesh needing a custom prepass shader publishes it as
  `mesh.userData.normalMaterial`. Alpha-tested foliage is excluded outright,
  because `MeshNormalMaterial` ignores `alphaTest` and inks every canopy as a
  rectangle.
- `setPassEnabled('outline'|'bloom'|'grade'|'prepass', …)` exists for profiling.

### Characters

Minecraft-ish boxes, **rigidly skinned**: one merged geometry, a per-vertex
`aJoint` attribute, and a `uniform mat4 uJoints[8]`. One matrix per vertex is
exact (no weight blending needed), so a whole character is a single draw call.

`src/character/RigMaterial.ts` returns three materials that **share one
`jointUniform` array** — colour, prepass normal, and inverted-hull outline. One
`setJoints()` keeps them in lockstep; separate arrays drift a frame and shimmer.
Note the hull vertex shader must use the raw `normal` attribute, not
`objectNormal`, which `MeshBasicMaterial` never declares.

The hull outline exists because screen-space edge detection gives characters a
weak, background-dependent line. Hull ink is geometry, so it reads the same
against sky, grass or stone.

### Paint

Two entirely separate mechanisms:

- **World paint** — batched decals in `src/paint/PaintSystem.ts`, into one shared
  vertex buffer with oldest-first eviction. `PLAN.md` §6 documents why this
  replaced the planned texture-space accumulation (a 130×130m arena in a 4096²
  atlas is ~5 texels/metre). `SurfaceRegistry` maps Rapier collider handles back
  to paintable geometry; instanced props register a per-instance matrix, since an
  `InstancedMesh` has a single `matrixWorld`.
- **Character paint** — a per-character render target stamped in
  `src/character/CharacterPaint.ts`. The hit point is resolved to atlas UVs
  *analytically* (`VoxelRig.resolvePaintFaces`), never by raycast: the CPU-side
  geometry is in bind pose and would answer for the wrong limb.

Both stamp shapes from one shared procedural `SplatAtlas`, which also feeds the
HUD lens splash. Its kernel is Wyvill `(1-t²)³` — finite support. The textbook
`r²/d²` metaball kernel has infinite support and merges every lobe into a plain
disc.

Deliberate design decision, previously raised and settled: **paint does not bleed
onto surfaces the shot didn't reach** (e.g. a chest hit does not appear on the
back). Keep it physically honest.

### Ballistics

Paintballs are hand-integrated (gravity + linear drag) and resolved with a swept
sphere cast — not rigid bodies, which would cost too much at this fire rate and
still tunnel at 42 m/s. The arc is lazy and readable on purpose.

Note the asymmetry: `src/ai/Bot.ts` compensates for drop when aiming; the player's
`src/gameplay/Weapon.ts` fires straight at the crosshair point, so player shots
land progressively low with range.

### Bots

`src/ai/NavGrid.ts` — 2m cells, walkability probed against the *physics* world,
A* with string-pulling, plus a reachability flood fill that prunes islands. Rapier
scene queries only see colliders as of the last step, so the grid build calls
`PhysicsWorld.refreshQueries()` (a 1e-6 step) first — without it the grid is built
against an empty world. It is 2D: bots currently cannot use the terrace or Bow
Bridge.

## Conventions

- Everything procedural and seeded from `WORLD_SEED` via `src/core/Random.ts`.
  Tunables live in `src/core/Config.ts` — prefer adding a named constant there
  over a literal at the use site.
- Comments explain *why*, especially where a shortcut was rejected. There are a
  lot of non-obvious WebGL/Rapier constraints recorded this way; they are worth
  reading before changing nearby code, and worth writing when you hit a new one.
- All audio is Web Audio synthesis (`src/audio/Synth.ts`); no sound files.
- `base: '/dp-paintball/'` is set unconditionally in `vite.config.ts` so dev and
  preview exercise production's paths. Build asset URLs from
  `import.meta.env.BASE_URL`, never root-absolute.
- Vite 8 bundles with rolldown, not rollup — rollup-only plugins won't work. The
  `esnext` target is what makes Rapier's top-level await viable without a plugin.
- `@dimforge/rapier3d` (real `.wasm`), imported dynamically. `rapier3d-compat` is
  still in `package.json` but is not what ships; its base64-inlined wasm costs
  842 KB gz against 592 KB.

## Verifying visual changes

Screenshots from memory are how you convince yourself of improvements that aren't
there. `npm run capture` writes the same 7 framed shots plus `metrics.json`
(`shadowWarmth`, `lumaSpread`, `edgeDensity`, `hueSpread`, draw calls) every time,
so passes are comparable file-by-file and regressions show up as numbers — the
khaki-grass and camera-inside-a-canopy regressions were both caught that way.

When investigating a reported visual bug, reproduce and confirm it in a capture
*before* changing code. Two measurement traps already hit: running `perf` while a
test suite is hammering the GPU inflates frame times ~2×, and vsync pins every
median to 16.67ms (hence the `--disable-gpu-vsync` flags in `tools/perf.mjs`).
