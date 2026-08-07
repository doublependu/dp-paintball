# Plan: Central Park Paintball

A web-based paintball game with a hand-drawn look — Borderlands linework, Ghibli
color and light — set in a slice of Central Park, with Minecraft-style voxel
characters. Playful and relaxing rather than serious. No death, just a hit
counter.

Derived from [PROMPT.md](./PROMPT.md).

## Locked decisions

| Decision | Choice |
|---|---|
| Perspective | **Third-person** over-the-shoulder |
| Opponents | **NPC bots only** — single-player, static site, no netcode |

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Renderer | **Three.js** (WebGL2, custom NPR pipeline) | Required by prompt; full shader control for the hand-drawn look |
| Physics | **Rapier3D** (`@dimforge/rapier3d-compat`, WASM) | Fast, has a proper kinematic character controller; ~500 KB, lazy-loadable |
| Ballistics | **Custom** integrator + swept sphere-cast into Rapier | Paintballs are slow, arcing and numerous — rigidbody-per-pellet is wasteful and tunnels. Custom gives the lob arc *and* correct hits |
| Language | **TypeScript** | Codebase will hit ~8–10k lines; types pay for themselves here |
| Build | Vite (already scaffolded) | Existing setup |
| Framework | **None** | DOM UI is hand-rolled; keeps the bundle small for the load target |

## 2. The look

Ghibli and Borderlands pull in different directions (soft painterly vs. hard
inked). The synthesis: **Borderlands linework, Ghibli color and light.**

- **Cel shading** — 2–3 band lighting ramp with a warm-bounce term, so shadows go
  teal-violet rather than grey (that's the Ghibli tell).
- **Outlines** — inverted-hull for characters and props (variable width by view
  distance, so lines stay ~2px on screen), plus a depth+normal Sobel post-pass
  for terrain and interior creases. Ink color tinted from the surface, never pure
  black.
- **Post stack** — painterly sky gradient with soft cumulus cards → SSAO
  (warm-tinted) → bloom → subtle Kuwahara/edge-preserving smear at low strength →
  paper-grain + slight edge-darkening vignette → warm LUT grade.
- **Foliage** — Ghibli trees read as *soft masses*, not individual leaves.
  Clustered alpha-cutout canopy cards with hand-painted-style textures, gentle
  two-axis wind in the vertex shader, darkened interiors for depth. This is where
  the film comparison is won or lost.
- **Characters** — voxel/Minecraft blocky, which actually helps: hard silhouettes
  take ink lines beautifully.

## 3. Load budget (< 2 s)

A real constraint that shapes everything else. Target **~3.5 MB gzipped, first
playable frame under ~1.2 s**:

- Three.js ~170 KB gz + game code ~120 KB → interactive shell immediately.
- Rapier WASM (~500 KB) streams in behind a hand-drawn loading card.
- **Characters are procedural** — a Minecraft-style rig is boxes; generate in
  code, zero bytes downloaded. Animations are keyframed joint rotations in code
  rather than shipped skinned GLB clips.
- **Splats are procedural** — generated into a canvas atlas at boot.
- Only the terrain mesh and ~10 hero props ship as assets: Draco-compressed GLB,
  KTX2/Basis textures, one atlas. Aggressive decimation and instancing.

## 4. Blender's role

Used where it earns its place.

**Blender for:** the Central Park terrain heightfield, and hero props — Bethesda
Terrace arcade, the fountain/Angel, Bow Bridge, elm trees (3 LODs), Ramble rock
formations, lamp posts, benches. Bake normal+AO to an atlas, decimate, export
Draco GLB.

**Not Blender for:** characters (procedural boxes are better and free), splats,
foliage cards, terrain material.

## 5. The map

The **Bethesda Terrace → The Lake → Bow Bridge → Ramble** slice — the most
recognizable stretch and, conveniently, excellent arena geometry:

- The arcade gives covered flanks
- The terrace gives verticality
- Bow Bridge is a natural chokepoint
- The Ramble is a cover maze
- The Mall's elm allée gives long sightlines

Roughly 130×130 m, walled with hedges and park fencing.

Layout proportions come from OSM/public map data; photo reference informs palette
and massing. Geometry is hand-built — no copyrighted photos baked into textures.

## 6. Paint system

> **Revised during Phase 2.** This section originally specified texture-space
> accumulation for world paint. The arithmetic killed it — see below.

**Batched decals for world paint.** Each impact projects a clipped decal onto
the receiving geometry; all decals merge into one vertex buffer with per-vertex
tint and atlas-tile attributes, so every splat in the world is a single draw
call.

*Why not texture-space:* the original plan unwrapped every surface into a shared
4096² paint atlas and stamped splats at the impact UV. But the arena is 130×130m.
Packing that into a 4096² atlas leaves roughly 5 texels per metre, so a 34cm
splat lands on under two texels. Texture-space accumulation is the right
technique for a corridor shooter, not an open park. Decals make resolution
independent of world size, moving the cost from texture memory to vertex count —
which is cheap and bounded.

*What that costs:* paint is capped rather than unlimited, and the oldest splats
are evicted. Measured capacity is ~9,100 splats within a 150k vertex budget,
at ~17 verts per splat. That is a long match.

**Characters carry a per-character paint render target** — decals are baked
against static geometry and would need reprojecting every frame on an animated
mesh. Implemented in phase 5 alongside the real rig, not in phase 2. Since this
is third-person, paint on your own body is a headline feature: splats should be
visible on your own back.

Splat art: procedurally generated metaball blobs with drip tails, 16 variants
baked into a 1024² atlas at boot (~45ms, zero download). Wyvill (1-t²)³ kernel
with finite support — the textbook r²/d² kernel merges every lobe into a smooth
disc and draws circles instead of splats. On impact — particle burst,
squash-stretch pop ring, bloom pulse, wet *thock*.

## 7. Game rules

No death, no respawn. Track `hitsTaken` / `hitsGiven`.

Getting hit: paint splash across the screen edges that slowly drips off, a brief
woozy camera wobble, a giggle, +1 counter, ~1 s of grace.

Bots have deliberately imperfect aim and idle personality behaviors (peeking,
taunting, sitting down on a bench) so it reads as relaxing rather than tense.

## 8. Build order

0. **Scaffold** — TS, deps, module layout, fixed-timestep loop, perf HUD, and the
   shared interfaces later subsystems build against
1. **Movement feel** — Rapier character controller, third-person spring-arm
   camera with sphere-cast pullback and occluder fade, sprint/crouch/vault
2. **Ballistics** — custom projectile integrator, hit detection, paint
   accumulation system
3. **NPR render pipeline** ← the long pole
4. **Map** — Blender terrain + hero props, arena assembly, LODs, collision
5. **Characters** — procedural voxel rig, code-driven animation set
   (idle/walk/run/strafe/crouch/jump/shoot/flinch/taunt), body paint
6. **NPCs** — navmesh, steering, personalities
7. **Audio + UI** — hand-drawn HUD, scoreboard, splat-styled menus
8. **Perf pass** — KTX2, Draco, instancing, streaming; verify the 2 s target
9. **Visual polish loop**

## 9. Two deliberate departures from PROMPT.md

**"Blind side-by-side vs. a Ghibli film, don't stop for 10 hours."** A model
voting on which image it prefers isn't a reliable signal, and an open-ended time
budget has no convergence criterion — it burns tokens long past the point of
improvement. Instead: a **rubric-scored critic** on screenshots from the running
game (silhouette readability, line-weight consistency at distance, palette
cohesion, shadow color temperature, splat legibility against foliage, frame time,
load time), against pinned reference stills, with a per-subsystem iteration cap
and a stop when scores plateau. Same loop shape, an actual stopping rule.

**Sub-agent fan-out.** Genuinely useful here — the subsystems separate cleanly.
Proposed sequencing: build Phases 0–2 first (they define the interfaces
everything else depends on), then fan out on 3/4/5/6 in parallel once there's
something concrete to build against.
