# Plan 6 — the mural moves west, the bots learn to draw, and the frame gets its time back

`CLAUDE/prompt_6.md`, seven items. (Named `PLAN_6.md` rather than `plan_6.md` to
match the convention `CLAUDE.md` documents and every other file in this folder.)

Five of them are about the paint screen, and they are not five separate jobs:
items 1, 2 and 3 are one pass over `src/world/PaintScreen.ts` — where the board
stands, what its two faces do, and what survives a whistle — and items 4 and 5
are the two things that make the board worth having, an interesting picture on
it and a way to get that picture out of the game. Item 6 is the only one that
touches the render pipeline, and it is the only one where the honest first step
is a measurement rather than an edit. Item 7 is small, self-contained, and the
one the player will feel first.

The board's move (item 2) comes first in this document because items 1, 3 and 4
all read its geometry, and because the site is the only decision here that is
expensive to change later — a collider, a navgrid hole and a tree exclusion all
follow it around.

---

## 2. The board moves to Sheep Meadow's west rim

Today it stands at `SITE = { x: 13.5, z: 2 }` facing west (`PaintScreen.ts:40`),
which is 16 m from the player's spawn at `(0, 1.5, 10)` and inside the plaza
ring. The prompt asks for the other side of the park, nearer the forest, away
from the spawn.

**Recommended site: `x = -64, z = 42`, `FACING = +Math.PI / 2` (facing east,
into Sheep Meadow).** The numbers behind that, sampled from `heightAt` and the
layout masks over the board's real footprint (13.2 m of frame width, ±2.5 m of
depth):

| | current | proposed |
|---|---|---|
| ground height across the footprint | 0.00 m flat (paved plaza) | 3.39–3.66 m, **spread 0.27 m** |
| distance from the player's spawn | 16 m | **72 m** |
| `walkMask` within 2.5 m | 0 | 0 (the meadow's western walk passes 8 m behind) |
| trees on the site (`woodlandDensity`) | 0 | 0.00 |
| clear ground in front, out to 20 m | yes | yes, no trees, no slope over 0.25 |
| woodland density behind, within 30 m | 0 | **0.68** |
| `meadowMask` | 0 | 1.00 |

Why this one and not the others tried. `(-70, 40)` and `(-68, 44)` are flatter
still but bring the board's north end within 1.8 m of the meadow's western walk,
and a canvas standing across a path is a thing you walk into rather than look
at. The Ramble's edge is nearer the forest and the ground there moves 1.5 m
across a 12 m span. The mall's south end (`8, 80`) is flat and wooded behind but
sits on the player's own side of the park. The west bank above Bow Bridge
(`-76, 4`) is the most forested option in the play area and is 76 m out, but it
faces the lake arm and the fight rarely goes there.

What the meadow site buys, beyond satisfying the prompt: Sheep Meadow is the
map's one long sightline, and `canPlant` keeps it deliberately treeless
(`ParkArena.ts:830`), so an 11 m white board on its west rim is visible from
40 m in every direction across open lawn — which is most of the answer to "will
the player ever find it" once it is no longer 16 m from where they spawn. The
west woods stand behind it, so the *back* of the board (item 3) faces the trees,
which is the right way round for a surface nobody photographs.

**Settling the transform.** Same recipe as the stairs and the bridge ramps: sample
`heightAt` across the footprint, take the *minimum* rather than the centre, and
extend the plinth downward by the spread. The plinth is a single box
(`PaintScreen.ts:210`) and 0.27 m of fall across 13 m would leave one end
floating; `PLINTH_HEIGHT` 1.1 → 1.7 with the extra buried is cheaper than making
the plinth follow the ground. Then one screenshot from the meadow and one from
behind, because nothing here catches a board leaning into a hillside.

**Four things that follow it, and all four are easy to miss:**

- **`canPlant` does not honour `screenBlocks`** (`ParkArena.ts:825`). On the
  plaza it never needed to — `plazaMask` already kept trees off. On the meadow
  rim `meadowMask > 0.35` does the same job today, but the exclusion is now
  load-bearing at the board's *edges* where the meadow mask falls off. Add
  `if (screenBlocks(x, z, 3)) return false;` to `canPlant`, next to the one
  `isClearForFurniture` already has.
- **`NavGrid` derives walkability from physics and flood-fills from the player's
  spawn** (`CharactersSystem.ts:94`). The board is two static boxes in open
  lawn, so nothing can be cut off behind it — but check the fill anyway, because
  it is one assertion in `bot-test` and the failure mode is a silent island.
- **`bot-b`'s spawn comment in `main.ts:73` becomes wrong.** It was moved off
  `(16, 6)` because that spawn was two metres behind the board. The spawn can
  stay where it is; the comment must say why it moved rather than describing a
  board that is no longer there.
- **`LOOT_SPOTS` has no entry near the new site.** Not required, but a crate at
  the meadow's west rim gives the board a reason to have people near it. One
  line, and it is validated against the navgrid at spawn like every other spot.

**Findability.** `NEXT_5.md` already flagged that the board is the only thing in
the park you can paint deliberately and that nothing says so; at 72 m that stops
being a nicety. The sign machinery in `render/SignPlaque.ts` exists and the
arena already places one. A plaque at the plaza's west exit reading *"the
painting wall — Sheep Meadow, west rim"* is four lines of arena code. It is not
in the prompt, so it goes in only if item 7's work leaves room.

---

## 3. The back takes paint too

Today `onHit` rejects anything whose impact normal disagrees with the board's
forward (`PaintScreen.ts:266`), because a shot into the back would otherwise
print a *mirrored* splat on the front — paint nobody can see, in the wrong
place, on the picture that gets shared.

**The fix is a second canvas, not a relaxed test.** Give `PaintScreen` a `Face`
pair: each face owns a canvas, a 2D context, a `CanvasTexture`, a mesh and its
own hit count. `onHit` classifies by the sign of `localPoint.z` and the normal
dot, then stamps into that face's context with `u` mirrored for the back —
`x = (0.5 - localPoint.x / BOARD_WIDTH) * width` — so a splat lands where the
shooter saw it land from *their* side.

Details worth fixing at authoring time rather than at review time:

- **The back is not the poster, so it does not need the poster's resolution.**
  Front stays 2048 × 1152; back goes at 1024 × 576. That is 2.4 MB of texture
  rather than 9.4, and it matters twice over — once for memory and once for
  upload bandwidth, which item 6 has opinions about.
- **The back gets its own material instance.** `createCelMaterial({ map })`
  already takes a map (added in iteration 5); the back plane sits at
  `-FRAME_DEPTH/2 - 0.012` with its geometry rotated π about Y, so its own +Z
  faces out and `worldToLocal` on the *front* mesh stays the one frame every
  outside caller uses.
- **`MIN_FACING_DOT` stays 0.25 per face.** A grazing shot along the edge should
  still land nowhere: the frame and the plinth reject themselves by geometry
  today and must keep doing so.
- **The back is unlit rag paper in the same way the front is** — no change, but
  worth stating: it faces west into the woods, so it will read much darker than
  the front, and that is the park lighting doing its job, not a bug.

`splatCount` becomes per-face, and `toDataURL()`/`toBlob()` stay front-only.
Nothing outside this file should have to know there are two faces except the
tests.

---

## 1. The front wipes at the whistle; the back does not

The prompt says "wipe just the mural front surface clean when starting a new
round", which reads two ways: *just the mural* (not the park's world paint), or
*just the front* (not the back). Both are right, and both come out of the same
one-line change, so take the literal reading of each:

- On `match:started`, `PaintScreen` clears the **front** face only.
- The **back** accumulates across rounds, exactly as world paint does, for the
  reason `MatchSystem.restart` already documents: a park that carries the day's
  mess is more in keeping with this game. The front is different because it is
  the round's canvas and its picture goes out to social media — a mural that is
  half of last round's game is not this round's souvenir.

`PaintScreen.clear()` splits into `clearFront()` / `clearBack()`, and `build()`
subscribes to `match:started` alongside the `hit:world` subscription it already
has. Two traps:

1. **The first `match:started` fires during boot**, from `MatchSystem.init`
   (`MatchSystem.ts:34`), after the arena has built the screen. It clears an
   already-blank canvas. Harmless, and worth a comment so nobody "fixes" it by
   adding a guard that then also skips the first *restart*.
2. **The results card must not lose the picture it is showing.** It will not:
   `showMural` assigns `image.src = screen.toDataURL()`, a snapshot string, and
   the shareable `File` is built from a blob taken at `match:ended`. The clear
   happens on `match:started`, which is the click that dismisses the card. Order
   is already correct — but this is exactly the kind of thing that stops being
   correct silently, so `screen-test` should assert it: end a round, read the
   card's `src`, restart, and check the card's `src` is unchanged while the live
   canvas is blank.

---

## 4. The bots paint something

This is the long pole. Bots shoot with a 4.5°–12° error cone
(`Personality.ts`), which at 10 m is a 0.8–2.1 m group — noise, not a picture.
Making them draw needs four things: a reason to go and stand there, a much
tighter aim *for that activity only*, somewhere on the board that is theirs, and
something worth drawing.

### 4a. A new bot state, `muralist`

`BotState` gains `'muralist'`. Entry conditions, checked in `decide()` after
`restock` and before target acquisition:

- no target in sight, and none for the last few seconds;
- ammo ≥ 80 (a drawing costs 25–45 rounds and a bot that spends its last paint
  on art is a bot that spends the round walking to crates);
- the board exists — `PaintScreen | null`, because the test course has none;
- within 60 m of it, so this reads as "walked past the wall and had an idea"
  rather than a cross-park pilgrimage;
- a free slot to claim (below);
- a per-bot cooldown after finishing or abandoning, ~45 s;
- a global cap of **two** painters at once, so the park does not empty into an
  art class.

Exit: hit by anything (`onHit` already forces `startled`), a target coming into
view, ammo below `botSeekAmmo`, the design finished, or a 40 s timeout.

`act()` gains a branch that walks to the firing stance and holds it. The stance
is a point 8–12 m out from the slot's centre along the board's normal, within
±22° of it, snapped by `nav.nearestWalkable`, with one raycast for line of
sight. Standing still in the open for twenty seconds is a liability the bot
takes on knowingly, and finding a bot mid-brushstroke and tagging them is the
best thing this feature does for the game.

### 4b. Aim that can actually hit a 20 cm target

Two changes, both scoped to this state:

- **Error cone.** `muralAimErrorDeg = 0.35` — 6 cm at 10 m — replacing
  `personality.aimErrorDeg` while painting. Keep a *little* error: a perfectly
  rasterised glyph looks printed, and the whole game is hand-drawn.
- **Elevation solve.** The existing lift is `drop = ½·g·t²` with
  `t = range / muzzleSpeed` (`Bot.ts:571`), which ignores linear drag and is
  fine against a 1.8 m capsule and useless against a 20 cm dot: at 10 m it is
  wrong by a few centimetres and, worse, wrong *consistently*, which bends every
  drawing downward the same way.

  Solve it properly, and reuse the one copy of the flight model:
  `BallisticsSystem.advance` is deliberately the only integration in the game
  (`Ballistics.ts:232`) and the crosshair's accuracy already depends on that
  staying true. Integrate the launch from the muzzle in `FIXED_DT` steps until
  the path crosses the board plane, interpolate the crossing, compare with the
  target point, add the miss back into the aim point, repeat. Three iterations
  converge to well under a centimetre. No physics queries at all — this is
  arithmetic on the same `advance` call, ~200 vector operations per shot, and it
  runs once per shot rather than per frame.

  Do **not** reach for `ballistics.predict()` here. It is the right function for
  "what will I hit", it costs ~36 raycasts a call, and it answers a question
  this does not ask.

### 4c. Slots, so two bots do not draw on top of each other

`PaintScreen` grows a small claim registry over the front face: **3 columns × 2
rows**, each about 3.4 m × 2.6 m with a 0.35 m gutter. `claimSlot(ownerId)`
returns a free slot and its world-space rectangle, `releaseSlot(ownerId)` gives
it back, and slots are released on `match:started` with the wipe. A slot is a
lease, not a lock: it stops two painters overlapping, and it does not stop the
player from shooting straight through somebody's cat.

Slot geometry belongs to `PaintScreen` because it is the only thing that knows
the board's transform, and because `NEXT_5.md` already noted that if a second
paintable board ever appears, this logic wants extracting rather than copying.

### 4d. What they draw

A catalogue of designs in `src/ai/MuralDesigns.ts`: each design is a set of
polylines in a unit square plus a `closed` flag, rasterised into dot targets at
0.75 × splat diameter along the path. Twelve is plenty and they should be
legible at 3 m across from 15 m away — a sun with rays, a heart, a smiley, a
five-pointed star, a cat's head, a pine tree, a house, a fish, a flower, a
sailing gull, a balloon, and a single letter (the painter's own initial from
`displayName`, which is the one that makes the mural feel signed rather than
generated).

The dot count per design lands between 24 and 48 at the sizes above, which is
20–35 seconds of one bot firing every 0.4–0.6 s. That is a pleasant thing to
watch and it does not empty a 200-round load.

**One dial has to move for any of this to read:** splats on the board are
`paint.baseSplatRadius` × the speed scale, which at close range is ~0.48 m —
nearly a metre across on an 11 m board, and `NEXT_5.md` already flagged that as
possibly wrong for a surface whose purpose is being painted on. Add
`paint.screenSplatScale = 0.55` and apply it in `PaintScreen.stampSplat`. At
0.26 m across, a 3.4 m glyph is thirteen dots wide and reads as a drawing; at
0.95 m it is three dots wide and reads as three dots. This number is a *feel*
number and should be flagged for a person the way the ammo economy was.

### 4e. Wiring

`Bot` needs the board. It already takes `match` and `loot` as constructor
arguments for exactly this reason ("shared, lifetime-stable state",
`Bot.ts:113`), so `screen: MuralBoard | null` joins them, threaded from
`main.ts` through `CharactersSystem`. Declare a narrow `MuralBoard` interface
(`claimSlot`, `releaseSlot`, `slotRect`, `normal`, `centre`) that `PaintScreen`
implements, so the AI does not depend on a canvas, a texture or a data URL.

---

## 5. Post to X, properly, with a picture of the park in it

Two things are wrong today and they are unrelated.

**The link goes to the repo.** `REPO_URL` is used both for the "Fork me on
GitHub" badge and for the tweet's `url` (`ResultsPanel.ts:5, 279`). Split them:
`GAME_URL = 'https://v0.maize.live'` for sharing, `REPO_URL` stays on the badge.
The share text should mention the painting.

**The click does two things at once.** `case 'x'` calls `this.download()` and
then `window.open(..., '_blank', 'noopener')` inside one user gesture
(`ResultsPanel.ts:276-281`). A gesture that starts a download *and* opens a
popup is exactly the pattern Chrome and Safari throttle: the popup is the one
that loses, silently, which is a very good match for "does not quite work yet".

Fix it structurally rather than by reordering:

- Render the X control as a real `<a href="…" target="_blank" rel="noopener">`
  with the intent URL built when the card appears. A genuine link click is not a
  popup and is never blocked.
- Keep saving the image as its own adjacent button, with a line of copy saying
  what the flow is: **X cannot be handed an image by URL** — `intent/post` and
  `intent/tweet` take `text` and `url` and nothing else — so the picture is
  saved and attached by hand. `PLAN_5` said not to dress the intent up as if it
  posts the picture; that stands, and the fix is to make the two steps look like
  two steps.

**The picture becomes a screen capture with the mural in it.** Today the shared
PNG is the flat 2048 × 1152 canvas: the painting, with none of the park. A
gameplay frame is a better souvenir and is what the prompt asks for.

Mechanism, and every step of this has a trap in it:

- A new `src/ui/PosterCapture.ts`, registered as a system **before**
  `ResultsSystem`. On `match:ended` it places a camera from the board's
  transform — 13 m out along the face normal, 2.4 m up, yawed ~18° off axis so
  the board has perspective rather than being a rectangle — renders one frame
  through the existing NPR pipeline, and reads the canvas back.
- **Order is the trap.** `ResultsStage.present` reparents every character onto
  the overlay scene, so a capture taken after it shows an empty park. `EventBus`
  dispatches in subscription order and systems `init` in registration order, so
  registering the capture ahead of `ResultsSystem` is what makes the figures
  still be in the park when the shutter goes. Say so in a comment; it is a
  one-line ordering dependency that nothing else enforces.
- **`preserveDrawingBuffer` is off**, deliberately — it costs frame time, which
  item 6 is trying to buy back. So the readback must happen in the *same
  synchronous task* as the render: `renderer.render(...)` then
  `canvas.toDataURL()`, with nothing awaited in between. That is well-defined
  and it is the only reason this does not need a render target and a
  `readRenderTargetPixels` round trip.
- **Crop to 16:9** in a scratch 2D canvas as it is copied out, so the poster's
  shape does not depend on the player's window.
- **Fall back to the flat mural** if the capture comes back blank — which it
  will under SwiftShader, where the whole suite runs. `ResultsPanel` takes an
  image and a file rather than a `PaintScreen`, and `ResultsSystem` decides
  which it got. That keeps `screen-test` honest instead of green-by-luck.

The card then shows the poster; the flat canvas is still reachable through
`toDataURL()` for anything that wants the painting alone.

---

## 6. The mouse feels laggy

The look path itself has no smoothing in it: `consumeMouseDelta` writes straight
into `state.yaw`/`state.pitch` and the camera quaternion is set from them in the
same frame (`CameraRig.ts:54-84`). `followLambda` smooths the *pivot*, which is
the character's position, not the aim. So this is not input smoothing — it is
frame time, and probably frame time on a high-DPI display.

**Measure before changing anything.** The harness exists: `npm run perf` runs a
real GPU under Chrome with vsync off and reports percentile frame times,
`npm run perf:attribute` hides one group of objects at a time to attribute cost,
and `NprPipeline.setPassEnabled('outline' | 'bloom' | 'grade' | 'prepass', …)`
exists precisely so a pass can be removed and re-measured without a rebuild
(`NprPipeline.ts:310`). F3 shows the frame graph in a live session. Take a
baseline at `plaza-fountain` and `meadow-skyline`, at DPR 1 and DPR 2, before
touching a line — and take it *before* item 4 lands, because bots painting
continuously changes what the numbers mean.

Ranked hypotheses, with the fix each one implies:

1. **The normal prepass renders the whole scene a second time, every frame.**
   `renderNormalPrepass` traverses the graph, swaps the material on every
   visible mesh, renders, and swaps back (`NprPipeline.ts:342`). That is a
   second full draw-call submission per frame, and it is the single largest
   structural cost in the pipeline.

   **Fix: reconstruct view normals from depth in the outline shader and delete
   the prepass.** The pass already samples linear depth at five taps; screen-space
   derivatives of the reconstructed view position give a normal good enough for
   a 3 px ink line, and it costs a handful of ALU against a whole scene render.
   It also disposes of the reason the prepass swaps materials per mesh rather
   than using `scene.overrideMaterial` — skinned characters collapsing to their
   rest pose — because depth already has the skinning baked in.

   Requires a depth texture on the composer's render targets, which means
   constructing them by hand rather than letting `EffectComposer` allocate them.
   **Fallback if the ink quality regresses:** run the prepass at half resolution
   into a smaller target. Cheaper to try, worth less.

2. **Four full-screen passes at DPR 2.** Outline (≈16 texture fetches), bloom
   (five mip levels, already halved), grade, output. At 1920 × 1080 × DPR 2
   that is 8.3 M fragments per pass. **Fix: fold the grade into the outline
   shader** — grain, vignette and the split tone are a dozen instructions and
   need no neighbourhood — saving one full-screen pass and one target ping-pong.
   The output pass has to stay; it is what applies tone mapping and sRGB.

3. **Pixel ratio is capped at 2 and never adapts** (`render.maxPixelRatio`).
   **Fix: adaptive resolution.** Track a rolling median frame time in
   `RenderSystem` and move the renderer's pixel ratio between 1.0 and the cap in
   0.25 steps, with hysteresis and a floor. On a 4K laptop this is the single
   biggest lever, and unlike everything else on this list it degrades gracefully
   on machines that do not need it.

4. **The sun's shadow map redraws the whole scene into 2048² every frame.**
   **Fix:** `renderer.shadowMap.autoUpdate = false` with `needsUpdate` set every
   other frame. The sun does not move; only the characters do, and a shadow at
   30 Hz under a 60 Hz camera is not visible. Measure this one specifically —
   it is either a large win or nothing, depending on how much of the park is in
   the sun's frustum.

5. **The mural uploads 9.4 MB whenever anything hits it.** `texture.needsUpdate`
   re-uploads the whole 2048 × 1152 canvas (`PaintScreen.ts:349`). One hit per
   frame is one upload per frame; with item 4's bots painting continuously that
   is the steady state, not the exception. **Fix:** track the dirty rectangle
   per frame and copy only that region with `renderer.copyTextureToTexture`,
   from a small scratch canvas texture. A 256 × 256 region is 256 KB — 2.5% of
   the current cost. **Fallback:** throttle uploads to ~20 Hz, which is
   imperceptible on a wall of paint and costs three lines.

6. **Allocation churn in the physics hot path.** `PhysicsWorld.raycast`
   allocates a `Ray`, two vector literals, a `pointAt` result and a hit record
   on *every* call (`PhysicsWorld.ts:197`); the scene crosshair issues up to 36
   of them per fixed step at 60 Hz; `CameraRig.castArm` allocates a fresh
   `Ball` every frame (`CameraRig.ts:142`) and `Ballistics` one per projectile
   per step. None of this is a leak, and all of it is garbage that a collector
   eventually stops the world to clear — which is what a periodic hitch while
   panning feels like. **Fix:** cache the shapes as fields, reuse a single `Ray`,
   and give `raycast` an out-parameter. Cheap, low-risk, and it makes the
   profile easier to read even if it turns out not to be the cause.

7. **Ruled out, and worth recording so it is not re-investigated:** the fixed
   loop is not the problem. `MAX_SUB_STEPS` is 5 against a 60 Hz step, and the
   backlog is dropped rather than paid off (`Loop.ts:119`), so a slow frame
   cannot spiral. And input is consumed after the steps and before the draw, so
   there is no extra frame of latency in the ordering.

Land 3 and 6 first — they are small, and 3 alone may be the whole answer. Do 1
and 2 only against measurements, and re-run `perf` after each, because
attributing frame time by reasoning about triangle counts is how you end up
optimising the thing that was already free.

---

## 7. Crates you can find

`LootSystem` puts three crates in eleven possible hiding places, each 0.52 m
across, bobbing quietly (`LootSystem.ts:299`). Nothing announces them, nothing
marks them, and the bots know where they are the instant they spawn because
they read the shared state directly. The player is the only participant playing
hide-and-seek.

Four changes, cheapest first:

1. **Say where it is.** `pickSpot` already returns a hand-written `where` string
   for every spot — "the arcade undercroft, west bay", "deep in the Ramble" —
   and `spawn()` throws it away (`LootSystem.ts:214`). Put `where` in the
   `loot:spawned` payload and have `HudSystem` toast *"paint crate — the arcade
   undercroft"* for a couple of seconds. This is one field, one line of HUD, and
   it is most of the feature: the park's places have names and the game already
   knows them.
2. **A beacon.** A slim vertical shaft above each crate — 7 m tall, ~0.35 m
   across, in the crate's brightest paintball colour, additively blended and
   gently pulsing, with the depth test left **on** so a hill or the terrace
   still hides it. Tall enough to clear the benches and most understorey,
   honest enough that finding one still means walking there. It goes on the
   crate `Group`, so it bobs, spins, hides and disposes with everything else.
3. **A marker on the HUD.** A small chevron with a distance readout for the
   nearest live crate, pinned to the screen edge when the crate is off-camera
   and floating over it when it is not. Gate it on the same
   `botLootSightScale × sightRange` notion the bots use, so the player learns
   about a crate at the range a bot would — that gating already exists in
   config and its comment explains exactly why it is there.
4. **A bigger crate.** 0.52 → 0.68 m on the body with the lid and balls scaled
   to match. It is a pickup, not scenery, and at the current size it reads as a
   rock from 20 m.

Do 1 and 2 for certain. 3 is the one that guarantees the player finds a crate
and also the one most likely to feel like an objective marker in a game that has
carefully avoided having any — build it, then decide with it on screen.

---

## Tests

`npm test` is eleven suites and 197 checks today. The discipline `NEXT_5.md`
argues for holds throughout: **every new check gets run against the
reintroduced bug**, because all three of the colour tests in iteration 5 passed
against both the fix and the fault before they measured the right thing.

- **`screen-test`, items 1–3, 5:** a shot at the back lands on the back canvas
  at the *mirrored* u and leaves the front untouched; the front is blank after
  `match:started` while the back and the world's decals survive it; the results
  card's `src` is unchanged by the restart that dismisses it; the poster capture
  returns a 16:9 PNG of the expected size, or falls back to the flat mural with
  the fallback flag set; the X control is an anchor whose `href` carries
  `v0.maize.live`.
- **New `tools/mural-test.mjs`, item 4:** a bot forced into `muralist` with a
  known design and slot, stepped 30 s, must leave ≥ 85% of its painted pixels
  inside its claimed slot rectangle, and the painted bounding box must match the
  design's aspect within tolerance. Two muralists never hold the same slot. And
  the differential that makes it a real test: with the tight aim override
  removed, the same check must **fail** — a bot shooting at a wall with a 7.5°
  cone fills a slot with noise, and a test that cannot tell that from a drawing
  is measuring nothing.
- **`bot-test`, item 4:** a bot enters `muralist` only under the stated
  conditions, leaves it when hit or when a target appears, and never enters it
  below the ammo floor. Its stance is inside ±22° of the board normal and has
  line of sight.
- **`match-test`, item 7:** `loot:spawned` carries a non-empty `where`; a beacon
  exists above each live crate and goes with it when taken.
- **Item 6 is measured, not asserted.** Frame times belong in `NEXT_6.md` as
  before-and-after numbers from `npm run perf` on one machine, not in a suite
  that would fail on somebody else's laptop. What *can* be asserted: the render
  output still has ink on it — `arena-test` already screenshots the park, and a
  pipeline change that quietly disables the outline should not pass.

---

## Order of work

1. **Baseline the frame time** (item 6, measurement only), before anything
   changes what is on screen.
2. **Items 2, 3 and 1** — one pass over `PaintScreen` plus the four things that
   follow the site. Everything else on this list reads the board's geometry.
3. **Item 7** — self-contained, and the first thing a player will notice.
4. **Item 5** — the poster and the share row. Small, and it does not need bots.
5. **Item 6's fixes** — adaptive resolution and the allocation cleanups first,
   then the prepass and the pass merge, re-measuring after each.
6. **Item 4** — the muralist bots, last, because it is the largest piece and
   because it wants a frame budget that has already been cleaned up.

## Deliberately not in this plan

- **Bots painting the back.** They paint the poster side; the back is the park's
  graffiti wall and belongs to whoever wanders behind it.
- **Letting the player pick a stencil, or scoring the mural** — coverage by
  colour, territory, a per-player share of the canvas. Tempting, and none of it
  is in the prompt.
- **A wipe button for the back face.** Still the same question `PLAN_5` deferred
  — who is allowed to clear a shared painting — and now the front answers itself
  every round, which may be enough.
- **`NEXT_3.md` P1**, the round clock running while the start card is up, and
  **`NEXT_2.md` P2**, the bots' inability to use the map's verticality. Both
  still open, both untouched by any of this.
