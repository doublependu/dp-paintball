# PLAN_1 — the match layer

Plan for Gameplay items 1–6 in `CLAUDE/FEEDBACK_0.md`: ammo limits, a loot
pickup, a visible gun, faster paintballs, a five-minute round, and an end-of-match
screen.

Taken together these six are one feature, not six: the game currently has no
round, so there is nothing for ammo to be scarce *within*, nothing for the loot to
interrupt, and nothing for the results screen to conclude. `NEXT_0.md` P3 flagged
this as "no match, just a sandbox" and guessed ~150 lines. It is more than that
once the pickup and the showcase are real, but the shape it guessed is right.

---

## 1. The shape of the change

### One new shared-state object, one new system

`src/gameplay/MatchState.ts` — the round's authoritative numbers, following the
`PlayerState` precedent: a plain object passed explicitly at construction to the
handful of systems that genuinely need synchronous access, rather than routed
over the bus.

```ts
export type MatchPhase = 'playing' | 'ended';

export interface MatchState {
  phase: MatchPhase;
  /** Seconds remaining, counted down in *simulated* time. */
  timeLeft: number;
  /** id -> paintballs remaining. One authority for player and bots alike. */
  ammo: Map<string, number>;
  /** Sandbox: unlimited ammo, no clock, no loot. The test course sets this. */
  sandbox: boolean;
}

canFire(match, id): boolean
consume(match, id): boolean   // false if empty; callers must not fire
grant(match, id, n): void
totalAmmo(match): number
```

Ammo goes in the `Map`, not on `Character`, even though scores live on
`Character`. `WeaponSystem` has no way to reach a `Character` — characters are
constructed inside `CharactersSystem.init()`, after every constructor has run —
so putting ammo there means the player's count lives somewhere else, and
`HudSystem`'s own comment names that trap: two counters that can disagree.

`src/gameplay/MatchSystem.ts` — owns the clock, seeds ammo at `init`, watches the
end condition, and emits the round's events. It takes `CharactersSystem` directly,
which `HudSystem` already does, so this is existing practice rather than a new
liberty with the no-cross-references rule.

### Events added to `GameEventMap`

```ts
'match:started': { duration: number };
'match:ended':   { reason: 'time' | 'ammo' };
'ammo:changed':  { characterId: string; remaining: number };
'loot:spawned':  { position: Vector3 };
'loot:taken':    { characterId: string; amount: number };
```

`ammo:changed` is what lets the HUD stay dumb, and what a headless suite asserts
against.

### Registration order

`main.ts` gains, after `charactersSystem` and before `audio`:

```
.add(charactersSystem)
.add(new LootSystem(match, charactersSystem))   // needs the navgrid, built in characters.init
.add(new MatchSystem(match, charactersSystem, ballistics))
.add(audio)
.add(hud)
```

`MatchSystem` runs after loot so "everyone is empty" and "the crate is gone" are
evaluated in the same step they became true, and before the HUD so the clock the
HUD draws is this step's.

---

## 2. Ordered phases

### Phase A — item 4: muzzle speed ×1.5 (smallest, and it moves the baseline)

`ballistics.muzzleSpeed: 42 → 63`.

Everything downstream reads the config, so the crosshair prediction, the bots'
drop compensation and the flight integrator all follow for free. Three things do
*not* follow and must be changed with it:

- **`Character.takeHit` splat scaling.** `remap(impactSpeed, 12, 42, min, max)`
  has 42 hardcoded as "nominal impact speed". At 63 every hit clamps to
  `maxSplatScale` and speed stops modulating splat size at all. Replace the
  bounds with expressions of `ballisticsConfig.muzzleSpeed` (roughly `0.3×` and
  `1.0×`). `PaintSystem` has the equivalent remap for world splats — same fix.
  This one is not cosmetic: it is plausibly a contributor to Visual item 1, since
  a permanently-maxed splat is also a permanently-scissored one.
- **`tools/ballistics-test.mjs`** asserts landing points by coordinate. Its
  numbers are re-baselined against the new arc, not adjusted by feel.
- **`NEXT_0.md` P0's drop table** is obsolete. Drop at 10 m falls from ~0.80 m to
  ~0.36 m; the complaint that the player's uncompensated shots land low largely
  dissolves, without touching the deliberate asymmetry between the player's aim
  and the bots'.

`predictMaxFlight: 1.2` now traces ~59 m instead of ~40 m, which is more
crosshair than before and still cheap. `drag: 0.42` stays: drag is linear in
velocity, so the ball sheds the extra speed proportionally and the arc keeps its
character. Both worth a look in `npm run capture` before deciding they're right.

Verify: `npm run test:ballistics`, `npm run test:crosshair`, and one capture pass
to confirm the arc still reads as an arc rather than a laser.

### Phase B — item 3: the gun model

Add the marker as extra `RigPart`s bound to `JOINT.ARM_R`, not as a separate
mesh. The rig merges every part into one geometry with a per-vertex joint index,
so the gun costs 4 boxes of vertices and *zero* extra draw calls, and it inherits
the inverted-hull ink, the shadow pass and the animated pose without a line of new
code. A child `Object3D` holding its own mesh would cost three draw calls per
character across the three passes, on every bot.

Geometry: body, grip, barrel, hopper — barrel running along the arm's local **−Y**
(i.e. continuing past the hand). That orientation is the one that reads right in
both poses for free: the arm hangs at rest so the marker points at the ground, and
the aim pose rotates the shoulder to ≈ −1.35 rad so the marker swings up and
level. Colours are explicit — dark receiver, hopper in the character's team
colour — set in the `HUMAN_PARTS` mapping in `Character`'s constructor alongside
the shirt tint.

One correctness detail: `AimSolver.computeMuzzle` places the muzzle analytically
at `+1.35 up, +0.26 lateral, +0.34 forward`. Once there is a visible barrel, that
constant should be moved to sit at the barrel tip in the aim pose, or close-range
shots visibly leave from beside the gun. It stays analytic — reading the posed
joint matrix would make the muzzle a frame stale, since the rig is posed in
`update()` and the gun fires in `fixedUpdate()`.

Also check: `VoxelRig.resolvePaintAnchor` picks the nearest part, so a hit near the
hand can now anchor to the gun. That is fine and arguably correct — a painted
marker is good — but it is a behaviour change worth seeing in
`rig-preview.html` first.

### Phase C — items 1 and 2: the ammo economy

**Item 1, the limit.** `MatchSystem.init` seeds every character id with
`match.startingAmmo` (100). `WeaponSystem.shoot` and `Bot.aimAndFire` call
`consume()` and bail if it returns false. Empty is not silent: the player gets a
dry click from `Synth` and the HUD counter goes to its empty state. Bots need a
behaviour, not just a mute — a bot standing in `engage` firing nothing is a bot
that looks broken. Below ~15 rounds it prefers `reposition`; at zero it leaves
combat states entirely and wanders.

**Item 2, the loot.** `src/gameplay/LootSystem.ts`.

- *Where.* Not `nav.randomWalkablePoint()` — that lands the crate in the middle
  of Sheep Meadow as often as anywhere, which is neither hidden nor interesting.
  Instead a hand-authored list of ~10 hiding places in `ParkLayout` (under the
  arcade undercroft, behind the terrace, on the Lake island, deep in the Ramble,
  in a woodland glade past `PLAY_HALF`, …), one picked per session and validated
  through `nav.nearestWalkable()` so it is always reachable.
- *Which random.* **Not `ctx.rng`.** `Character.takeHit` carries a comment
  explaining why that sequence must stay draw-for-draw reproducible. The loot
  gets its own `Rng` seeded from `Date.now()`, overridable by `?seed=` and pinned
  in sandbox mode, so "a different place each game" costs nothing in determinism.
- *What it looks like.* A crate — box plus a translucent hopper of coloured balls
  — on a cel material, bobbing and turning slowly. Hidden means hidden: no
  waypoint marker, no beacon. A quiet positional shimmer from `Synth` inside ~12 m
  is enough of a tell.
- *Taking it.* A distance check in `fixedUpdate` against all seven characters
  (seven comparisons — a trigger collider would be more machinery for no gain).
  First within ~1.4 m takes all 20, `loot:taken` fires, crate hides, HUD toasts.
- *Bots and the crate.* If bots can never take it, the item-5 end condition
  ("all players out, including the loot") stalls whenever the player ignores it.
  So: a bot under 15 rounds, with the crate unclaimed and within `sightRange ×
  1.5`, paths to it. Range-gated deliberately, or every bot beelines at t=0 and
  the crate is gone in fifteen seconds.

HUD gains an ammo readout beside the tag counters, warm under 20, struck through
at 0.

### Phase D — item 5: the round

`MatchSystem.fixedUpdate` counts `timeLeft` down in simulated time —
`simElapsed`, not wall clock, per the `Loop` contract; a round that runs short on
a slow machine is not a round.

The round ends when **either**:

- `timeLeft <= 0`, or
- `totalAmmo() === 0` **and** the crate has been taken **and**
  `ballistics.activeCount === 0`.

All three clauses of the second condition matter. Without the crate clause,
"everyone is out" fires while 20 rounds are still sitting in the park, which is
not what item 5 says. Without the in-flight clause, the results screen appears
while the last shot is still travelling and the final hit lands behind the
overlay.

HUD gets a mm:ss clock, warm under 30 s, plus a one-minute toast.

### Phase E — item 6: the results screen

The interesting problem: showing painted characters over a translucent screen,
without a second WebGL context and without re-running the NPR pipeline.

**Rendering.** Add `RenderSystem.setOverlay(scene, camera)`. After the pipeline
has composited its frame, if an overlay is set, clear depth and render that scene
on top with `autoClear = false`. The translucent screen is a full-screen quad
inside the overlay scene rather than a DOM panel, because DOM cannot be layered
*between* two things drawn on one canvas. DOM still does all the text, sitting
above the canvas as the HUD already does.

`src/ui/ResultsStage.ts` holds the overlay scene: the scrim quad, a hemisphere +
directional pair matching the park's key and fill so the paint reads in the same
colours it did in the world, a plinth, and the characters.

**The characters.** Reparent each `character.rig.root` into the stage scene and
lay them out on an arc, each turning slowly on its own Y. Reparenting rather than
cloning means the paint, the pose and the team colours are exactly the ones from
the round, at zero cost — `CharacterPaint` is uniform data on a material that
travels with the mesh. The animator keeps running on an idle input so they
breathe rather than freeze. `CharactersSystem.update` guards on
`phase === 'ended'` and stops writing transforms. The stage camera must
`layers.enable(NO_OUTLINE_LAYER)` or the hull ink disappears.

That hull ink is the reason this works without the Sobel pass: `CLAUDE.md` notes
the hull exists precisely because screen-space edges give characters a weak,
background-dependent line. On the stage, the strong line is the one that comes
along for free.

*Fallback if reparenting fights the shadow map or the layer setup:* build display
clones that share the rig geometry and a fresh `RigMaterial` bound to the same
`CharacterPaint` instance. More code, but zero interaction with the live scene.

**The panel.** `src/ui/ResultsOverlay.ts`: title, final clock, a row per character
sorted by tags given — swatch, name, tags given, tags taken, splats worn
(`character.paint.splatCount`, which is literally "paints received") — and award
chips. Pointer lock is released so the cursor can reach "play again"; the player
controller and weapon are frozen for the duration, while bots keep milling about
behind the scrim, which is much nicer than a still frame.

**Restarting.** `match:restart` clears character paint (`CharacterPaint.clear()`
already exists), zeroes scores, re-seeds ammo, respawns the crate at a *new*
hiding place, resets the clock, returns characters to their spawns and reparents
the rigs. No world rebuild — that is the 1.4 s boot, and none of it changed.

World paint I would **leave alone** across rounds. It is already bounded by
oldest-first eviction, and a park that accumulates the day's mess is more in
keeping with the game than one that wipes clean every five minutes. If that reads
as a bug rather than a feature, `PaintSystem` needs a `clear()` — it has no reset
path today, only `evictOldest`.

---

## 3. Testing

`?scene=course` sets `sandbox: true`: unlimited ammo, no clock, no crate, no
results screen. This is not a special case so much as the honest description of
what the test course already is, and it keeps `movement`, `ballistics` and `paint`
asserting the same things they assert now. `?match=off` does the same in the park,
for capture runs.

`window.__paintball` gains `match`, with `end()` and `restart()`, so a new
`tools/match-test.mjs` can:

- assert the ammo counter falls with fire and blocks at zero,
- teleport the player to the crate, assert `+20` and a single consumption,
- call `end()` and assert the overlay exists, has one row per character, and names
  the right winners,
- assert `restart()` zeroes scores and puts the rigs back in the game scene.

`tools/capture.mjs` gets a results-screen viewpoint. `NEXT_0.md` P4 already
observed that all seven pinned shots are landscapes while every reported visual
bug has been about characters; a results shot is a framed close-up of six painted
characters, which is the cheapest possible fix for that blind spot.

---

## 4. Where I'd suggest something different

**100 balls is 14 seconds.** At `fireInterval: 0.14`, 100 rounds is fourteen
seconds of held trigger inside a five-minute round. That is not necessarily wrong
— it makes every shot count, which suits the game — but the likely failure mode
is a player who empties early and then walks around an empty park for four
minutes. Three dials, in the order I'd try them:

1. **Let the crate respawn.** `lootRespawnSeconds` (default 0 = off, as
   specified; try 45). One number, and it turns "hidden loot" into the round's
   pacing mechanism instead of a one-shot event. It also makes the item-5 ammo
   ending reachable in a way that doesn't feel like the game just stopped.
2. Start at 150 rather than 100.
3. Lengthen `fireInterval` to ~0.2, which limits the burn without limiting the
   supply.

I'd ship 100 as asked with the respawn dial available, and tune after a play.

**Bots will run dry sooner than the player.** A bot's cooldown is
`fireInterval × 1.6–3.4`, about 2.9 shots/second while engaged, so a busy bot
empties in well under a minute of contact. With 100 each, most rounds will end on
ammo exhaustion rather than on the clock. That may be exactly what item 5 wants;
if rounds should usually reach five minutes, bots need a separate, larger budget.
Flagging rather than deciding — it's a feel question.

**"Most hit" is ambiguous.** Item 6 asks to highlight "least hit received" and
"most hit". The parallel construction reads as most hits *received* — a booby
prize, very much in keeping with "nobody wins, everybody gets messy" — but it
could equally mean most hits landed. I'd show three awards and sidestep it:
*Sharpshooter* (most tags given), *Cleanest* (fewest taken), *Most Painted* (most
taken). Say the word if you want only two.

**Fold in the recoil fix while we're here.** `Weapon.ts` nudges pitch by
`RECOIL` per shot and never gives it back (`NEXT_0.md` P4). With an ammo limit
the player fires in bursts rather than streams, so it matters less than it did —
but it's a spring and five lines, and this phase is already touching the file.

---

## 4a. What actually landed — phases A and B

**A (item 4).** `muzzleSpeed` 42 → 63. The splat remaps in `Character.takeHit`
and `PaintSystem.paint` now read `paint.splatSpeedMin`/`splatSpeedMax`, both
derived from muzzle speed, so raising the speed no longer pins every splat at
maximum size. Measured drop fell from 0.46 m to **0.21 m at 8 m** and from 1.73 m
to **0.80 m at 15 m** — the two figures quoted in `Config.sceneCrosshair` and
`SceneCrosshair`'s header, both updated, and re-baselined in
`tools/crosshair-test.mjs`. `tools/ballistics-test.mjs` needed no re-baselining
(its assertions were range-tolerant) but its arc check gained an upper bound so
that a regression back toward 42 m/s fails it: a level shot now carries ~21 m
where it used to carry ~14 m. Recoil recovery folded in as agreed
(`WeaponSystem.recover`), applied as a decaying *delta* so re-aiming mid-burst
still wins.

**B (item 3).** Four boxes on `JOINT.ARM_R` — body, barrel, grip, hopper — so the
figure is still one draw call (10 parts → 14, 240 verts → 336). The hopper takes
the team colour.

The part worth recording: **the aim pose was pointing the arm backwards, and had
been all along.** A rotation about +X carries a hanging limb's tip toward +Z, and
these characters face −Z, so `aimPose = -1.35` put the hand 0.64 m *behind* the
shoulder. Nothing showed it while the hand was empty — an arm raised behind you
and an arm raised in front of you are the same silhouette from the front, and
every capture in the rubric is a landscape. Measured by pushing the posed joint
matrix through the arm tip in `rig-preview.html`, which is now repaired (it had
been calling `createRigMaterial` with the pre-refactor signature and could not
have run since) and exposes `window.__figures` for exactly that kind of question.
The shot kick flipped sign with it.

The muzzle moved from `1.35 up / 0.26 lateral / 0.34 forward` to
`1.18 / 0.15 / 0.56`, and those are measured rather than guessed: with the pose
held, the barrel runs from (0.12, 1.17, 0.67) to (0.04, 1.09, 0.93) in
body-relative metres, so the new muzzle sits on that line, extended back into
the receiver. The first attempt put it at the shoulder and was 0.18 m to the
right of the gun — the aim pose tucks the arm inward across the chest, so the
marker ends up near the body's centre line, not out where the shoulder is.
Deliberately not the barrel tip: spawning a ball 0.93 m out lets a player
hugging cover fire from the far side of it. `Bot.aimAndFire` got the matching
offset, minus the lateral term, so bots' shots leave their marker rather than
their ribcage.

**Two pre-existing `ui` failures, unrelated to any of this** (confirmed by
running the suite against a stashed tree): "releasing Tab closes it" / "Tab opens
the scoreboard" flap between runs, and "lens paint drips away" fails every time.
The second one has a diagnosis worth writing down, because it is the
`elapsed`/`simElapsed` trap from `CLAUDE.md` seen from the other side: the test
waits 5 s of *wall clock* for blobs with 2.1–3.8 s lifetimes, but the lens ages
on frame `dt`, and under SwiftShader **5 s of wall clock is 0.58 s of simulated
time** — about 1.4 fps, so seven frames of `dt` clamped to `MAX_FRAME_DT` age the
lens by ~1.75 s and nothing expires. The fix belongs in the test (wait on
`simTime`), not the overlay.

**Still inverted, deliberately left alone:** `torso.rotation.x` uses the same
convention, so `leanAmount * 0.20` leans a *running* character backward and
`crouchAmount * 0.24` leans a crouching one backward, while `- flinch * 0.28`
rocks a character *into* the shot that hit them. Each is one sign, all three are
outside items 1–6, and at 0.2 rad they are subtle enough that they may have been
tuned by eye against the inverted convention. Worth deciding, not worth
smuggling in.

## 5. Rough order and size

| Phase | Item(s) | New files | Touches | Feel |
|---|---|---|---|---|
| A | 4 | — | `Config`, `Character`, `PaintSystem`, ballistics suite | small, re-baselines everything after it |
| B | 3 | — | `VoxelRig`, `Character`, `Aim` | small, self-contained, visible immediately |
| C | 1, 2 | `MatchState`, `MatchSystem`, `LootSystem` | `Weapon`, `Bot`, `Hud`, `ParkLayout`, `Events`, `main` | the bulk of it |
| D | 5 | — | `MatchSystem`, `Hud` | small once C exists |
| E | 6 | `ResultsStage`, `ResultsOverlay` | `Renderer`, `CharactersSystem`, `PlayerController`, `style.css` | the second-largest, and the only rendering risk |

A and B are independent of everything and can land in either order. C is the
spine; D is a few lines on top of it. E is last because it displays what C and D
produce, and because reparenting live rigs into an overlay scene is the one part
of this that might need its fallback.
