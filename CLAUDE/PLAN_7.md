# Plan 7 — the pedestal that eats paint, a park that says where you are, and the bots' side quest

`CLAUDE/prompt_7.md`, three items, after its update. Items 1 and 3 are both
about the board on Sheep Meadow and both are the same shape of problem:
something we believe about the mural is not true in play. Item 1 is a bug with a
measured cause. Item 3 is a feature that exists, is tested, and never happens —
which is worse, and the measurement below says exactly why. Item 2 is new
content with one interesting constraint: every sign is a collider, and every
collider is a navgrid obstacle.

Order of work: 1, then 3, then 2. Item 1 is the smallest diff and it opens
`PaintScreen.ts`, which item 3 also has to change; doing them together is one
read of that file rather than two. Item 2 is last because it is the largest and
it wants the shared sign builder extracted before anything else touches
`ParkArena`.

---

## 1. The plinth

### What is actually wrong

The prompt names the plinth and the prompt is right, and it is right about
slightly less than the whole bug. The canvas itself accepts paint over its whole
surface; `screen-test` already stamps at `v = 0.8` and lands there, and a sweep
of real shots confirms the accepted band runs to the canvas's bottom edge.

What is wrong is everything *below and around* the canvas. Sweeping pitch from
-6° to +26° at 8m, 14m and 22m in front of the board and logging every
`hit:world` in the board's own frame — the canvas runs y ∈ [-3.094, 3.094], the
frame's front face sits at z = 0.225 and the plinth's at z = 0.395, so a ball
centre reported at z = 0.28 struck the frame and one at z = 0.45 struck the
plinth:

```
from 14m   pitch=0   4 hits, 0 splats   y = -3.70 -3.53 -3.50 -3.46 at z=0.45
from 14m   pitch=2   4 hits, 1 splat    y = -3.10 -3.21 -2.95 -3.22 at z=0.28
from 22m   pitch=0   4 hits, 0 splats   y = -4.42 -4.50 -4.41 -4.26 at z=0.45
from 22m   pitch=2   4 hits, 0 splats   y = -3.63 -3.56 -3.52 -3.40 at z=0.45
from  8m   pitch=0   4 hits, 2 splats   y = -3.24 -3.15 -3.23 -2.76 at z=0.28
```

Every zero-splat row there is a clean hit on the board that produced no paint
anywhere in the game. The reason is in `PaintScreen.build`: it creates its two
static boxes with `ctx.physics.createStaticBox` (`PaintScreen.ts:442` and
`:447`) and never calls `surfaces.registerMesh` on either. The class header
defends this — "Deliberately *not* a `SurfaceRegistry` receiver, so world decals
never land on it" — and `onHit`'s own comment repeats it: "the plinth and frame
reject themselves by geometry". Both are right about the *canvas* and both were
over-applied to the whole board. `PaintSystem.paint` looks the handle up, gets
`undefined`, and returns. So:

- the **plinth**, `PLINTH_HEIGHT` 1.1m of clear standing height plus the buried
  part, which is what the prompt is pointing at, and
- the **frame's timber border**, `BORDER` 0.32m all the way round,

are the only large colliders in the park that swallow a paintball whole. That is
1.42m of board face directly under the picture, against a 6.19m picture — a
quarter of the board's visible front — and it is exactly where the ballistic arc
deposits anything aimed low. `SceneCrosshair`'s own header measures the drop at
0.80m at 15m; the board is 72m from spawn and most shots at it are long ones.

### The fix

Register both, but not naively — the frame's collider is one box spanning the
whole board, so registering its *box geometry* would mint a world decal for
every hit on the canvas too. That is double paint and it is the vertex-budget
blowout the class header correctly refuses.

`PaintSystem.paint` gives us the way out, and it is already written down there:

> A decal that clipped nothing means the impact point missed the receiver's
> triangles — nothing to draw.

So the receiver's geometry decides where paint can land, independently of what
the collider's shape is. Three changes in `PaintScreen.build`:

1. **The plinth** gets `surfaces.registerMesh(plinthCollider.handle, plinth)`.
   It is its own collider and lies entirely below the canvas, so there is no
   overlap to reason about. This is the same treatment the dedication sign's
   posts already get, and it is the item the prompt asks for.

2. **The frame** gets a purpose-built receiver: a "mount" geometry of eight
   quads — the border ring just proud of the front face, and the same ring just
   proud of the back — registered against the frame collider's handle via
   `surfaces.register(handle, { geometry, matrixWorld })`. A hit in the middle
   of the canvas clips none of those triangles and costs one `DecalGeometry`
   that returns zero vertices; a hit on the border clips four and paints.
   `PROJECTION_DEPTH` is 0.5 and the box is centred on the impact, so a front
   hit reaches z ∈ [0.03, 0.53] in board-local space and cannot catch the back
   ring at -0.237. That margin is why one geometry can hold both rings.

3. **`PaintScreen` has to be given the `SurfaceRegistry`.** `GameContext` does
   not carry one — `src/core/System.ts:11` — so `build(ctx)` cannot reach it.
   `ParkArenaSystem` holds both (`ParkArena.ts:219`) and calls
   `this.screen.build(ctx)` at `ParkArena.ts:256`, so widen `build` to
   `build(ctx, surfaces)` and pass `this.surfaces` there. That keeps
   `main.ts:61`'s one-argument constructor alone and keeps the registry out of
   `PaintScreen`'s lifetime.

### What is deliberately not done

**Repainting the plinth.** An earlier draft of this plan argued for a stone grey
against the canvas cream, on the grounds that `0xd8cdb8` and `#f7f4ec` are
indistinguishable from the meadow and a player would call the plinth "the bottom
of the mural". The updated prompt says "plinth". The player can evidently tell
them apart, the recolour was only ever a fix for a confusion that isn't there,
and the board reads better as one object. Dropped.

**Extending the canvas over the whole outer board** — one texture holding the
border and the plinth, with the 16:9 region cropped out for the poster — is the
architecturally purer answer and it is the wrong trade here. It grows the
per-upload payload from 9.4MB to about 11.9MB at the same 20Hz, it puts the
timber and the stone inside the thing `toDataURL` exports, and it rewrites the
geometry, the poster crop and half of `screen-test` to fix a bug that three
registrations fix. Revisit it only if the border ever needs to hold something
the world-paint budget cannot.

### Tests

`tools/screen-test.mjs` gains three checks, and they have to be shots rather
than stamped impacts, because the whole bug lives between the ballistic arc and
the registry:

- firing at the plinth raises `paintSystem.placedCount` and leaves
  `paintScreen.splatCount` alone;
- firing at the frame's bottom border does the same;
- firing at the canvas raises `splatCount` and does **not** raise
  `placedCount` — the guard against the double-paint regression, and the one
  that would have caught a naive registration.

The pitch sweep above is the shape to reuse: teleport to a known distance on the
board's normal, step pitch, and read the two counters.

---

## 2. Signs for the places

The park is laid out from real ground — `ParkLayout.ts` names Bethesda Terrace,
the Mall, Sheep Meadow, the Lake, Bow Bridge, the Ramble, Cherry Hill and the
island — and `LOOT_SPOTS` already speaks that vocabulary to the player ("deep in
the Ramble", "the west bank above Bow Bridge") in a HUD hint. Nothing in the
world says any of it. The dedication sign is the form the prompt asks for and it
is already the right one: generated lettering, no download, three boxes, and it
takes paint like everything else.

### Generalising the plaque

`src/render/SignPlaque.ts` hardcodes `LINES` and a 1024×512 canvas. Split it:

- an internal `paintPlaque(lines, width, height, seed)` holding the board fill,
  the wobbling border, the bolt heads and the per-glyph shrink-to-fit — all of
  which are already generic;
- `createSignPlaqueTexture()` unchanged in signature and output, so the
  dedication sign re-letters identically (its fixed `0x51c14` seed stays);
- `createPlaceSignTexture(name)` returning `{ texture, aspect }`, at 512×176.

A place name is one short line, so it wants a wider, shorter board than a
two-line dedication: 512×176 is about 2.9:1, which reads as a park marker rather
than a plaque. Seed the wobble from a hash of the name so every sign is
hand-made and *stable across reloads* — a sign that re-letters itself on refresh
is the bug the existing fixed seed exists to prevent.

Ten signs at 512×176 RGBA is 3.6MB of texture memory. That is acceptable and it
is the simple option; if it ever isn't, the fallback is one 1024×1024 atlas with
a row per name and `map.offset`/`map.repeat` per material, which is the pattern
`CanopyAtlas` and `SplatAtlas` already establish.

### Placing them

New file `src/world/PlaceSigns.ts`, because `ParkArena.ts` is 1208 lines and this
is a table plus a builder. It holds:

- `PLACE_SIGNS`, a table of `{ name, x, z, facePoint }` — facing given as a
  point to look toward rather than an angle, the way `placeSign`
  (`ParkArena.ts:755`) already derives its rotation from `PLAZA`, so a sign
  stays aimed at its subject if the subject moves;
- `buildSign(ctx, surfaces, group, spec)`, extracted from `ParkArena.placeSign`
  and used by both — same box-per-part construction, same
  `physics.createStaticBox`, same `surfaces.registerMesh`, same shadow flags.
  The dedication sign passes its own plaque and 2.4m board width; place signs
  pass theirs and about 1.9m;
- `signBlocks(x, z, margin)`, exported and shaped exactly like
  `PaintScreen.screenBlocks`, because two existing predicates need to know:
  `ParkArena.canPlant` (`:826`) so no tree grows through a sign, and
  `isClearForFurniture` (`:666`) so no bench or lamp post lands on one. The
  hardcoded `Math.hypot(x - SIGN.x, z - SIGN.z) < 2.2` at `:680` folds into it.

The table, each beside a walk and off its made surface, facing whoever is
walking past:

| name | at | faces |
| --- | --- | --- |
| Bethesda Fountain | (-10.5, 9) | the fountain — the mirror of the dedication sign across the plaza's axis |
| Bethesda Terrace | (-20, 17) | north over the plaza, from the terrace's north rim |
| The Mall | (-9, 30) | the allée, clear of `mallPathMask`'s 7.5m half-width |
| Sheep Meadow | (-23, 40) | west across the lawn, off the west drive |
| The Painting Wall | (-58, 38) | east down the meadow, outside `screenBlocks(x, z, 3)` |
| Cherry Hill | (-33, 18) | the west drive where it turns |
| The Lake | (-2, -19) | north to the water, south of the lakeside walk |
| Bow Bridge | (-47, -15) | north along the bridge, at its southern approach |
| The Ramble | (-38, -60) | the trail, where the bridge approach meets it |
| The Island | (14, -40)? | across the water — see the note below |

Treat those coordinates as a starting proposal, not a result. The paint screen's
site was chosen by sampling `heightAt` over the real footprint rather than by
eye, and the same discipline applies: each sign wants
`walkMask(x, z) < 0.05` — **not** the 0.15 the tree predicate uses, because a
sign is a collider and the navgrid is built by querying physics, so a sign that
overhangs a walk pinches the path every bot uses — plus `lakeMask < 0.05`, at
least 2.5m from every other sign, and ground flat enough that the posts do not
float. Write that as a validation loop and let it move the ones that fail.

The Island is the one to decide by looking rather than by argument. It is
reachable only by water, so a sign naming it has to stand on the shore pointing
across, which is a different kind of sign from the other nine. Build the nine
first; add it only if the shore has somewhere that reads.

### Tests

`tools/arena-test.mjs` gains a group of checks driven off the exported table, so
they follow it if it changes:

- every sign stands on solid ground — the same `heightAt`-versus-landed-player
  probe the file already uses for its ground test;
- no sign's footprint intersects a walk (`walkMask` at its four corners), the
  lake, the fountain basin, the terrace footprint or `screenBlocks`;
- no two signs are within 2.5m;
- every sign is reachable — a walkable navgrid cell within 2m of it — which is
  the check that catches a sign that walled itself into the wood;
- paint sticks to one, fired at rather than stamped, since the whole point of
  registering them is that they are ordinary park geometry.

Then `npm run stills` for a look at two or three of them, because "does the
lettering read at walking distance" is not a number.

---

## 3. Bots painting the mural

### We did implement it

`src/ai/MuralDesigns.ts` holds twelve drawings and a stroke alphabet. `Bot.ts`
has a `muralist` state, a slot claim, an elevation solve and a 0.4° aim cone.
`PaintScreen` hands out slots. `Config.mural` has fourteen tuned numbers.
`tools/mural-test.mjs` measures the result and passes: the paint that lands is
the drawing, at over 90% coverage, and it is measurably not a scatter.

So the prompt's "I thought we implemented this, or maybe not" is answering
itself. It is implemented, it is tested, and in an actual round it never
happens — which the test file admits in its own setup comment:

> The park is put in an unnatural state on purpose: a bot only paints when it
> has nothing to shoot at, so everybody else is sent to the far side of the map
> and the player with them. **Left alone, six bots within sight of each other
> fight for the whole round and nobody ever picks up a brush** — which is the
> intended behaviour and useless for measuring the brush.

That parenthesis is the bug. The rig was built to measure the brush and it
became the only place the brush is ever used.

### What a real round looks like

A natural 300-second match, six bots, the player standing at spawn and doing
nothing, sampled once a second:

```
mural entries per bot   a:2  b:1  c:0  d:0  e:0  f:0
seconds spent painting  a:4  b:4  c:0  d:0  e:0  f:0
splats on the board at the whistle: 3
```

Three splats. Two bots started, neither got past the walk-in, and four of the
six never entered the state at all. Of the 1792 bot-seconds spent not painting,
attributed to the first clause of `wantsToPaint` that refused:

```
has a target 1163 (65%)   too far 266 (15%)   not quiet yet 148 (8%)
on cooldown  135  (8%)    low on ammo  80 (4%)   all clear 0
```

And the shape of the opportunity, per bot, over the same round — total
target-free seconds and the longest unbroken run of them:

```
bot-a  70/300s, longest 45s      bot-d  152/300s, longest 97s
bot-b  52/300s, longest 48s      bot-e   46/300s, longest 19s
bot-c  24/300s, longest 11s      bot-f   93/300s, longest 72s
```

Three compounding causes, in order of how much they cost:

1. **The gate is a coincidence.** `wantsToPaint` needs no target, three seconds
   since the last one, 80 rounds in hand, under 60m to the board and no cooldown
   — *simultaneously*. The board sits at (-64, 42) and the bots' median distance
   to it over the round was 79.6m, so the 60m `noticeRange` alone disqualifies a
   sixth of the quiet time, and it is not the same sixth as the rest.
2. **Commitment is fragile.** `decide` abandons on any `target`, and
   `abandonMural` throws away the slot, the dots and the index, then adds
   `cooldownSeconds` 45. That is why the two entries above averaged four
   seconds: a bot walks off toward the board, catches sight of somebody through
   the trees, and loses the whole errand plus three quarters of a minute.
3. **The job is too big for the gap.** 56 marks at `fireInterval` 0.32 is 18
   seconds of standing still, after a walk that can be 20 seconds from the far
   side of the park. Against the runs above, that fits inside bot-d's 97s and
   nothing else reliably.

### What to change

The prompt asks for a side quest for one to three NPCs, drawing a small thing in
a corner. That is not a smaller version of the current design — it is a better
one, because each part of it also removes one of the three causes.

**1 · Designate the painters at the whistle.** Roll `1 + rng.int(3)` bots at
match start and sample that many from the roster without replacement; only they
ever enter `muralist`. `CharactersSystem` owns the roster and already has a
per-round reset (`:253`), so the roll belongs there and gets re-rolled with it.
A `Bot.isPainter` flag, checked first in `wantsToPaint`. The colours come free:
every bot already carries its own `colorIndex` into `paintColors`
(`CharactersSystem.ts:106`, `Character.ts:56`), so three painters are three
colours on the board with no further work — which is the thing the prompt is
actually after.

Then, for a designated painter only: **drop `noticeRange` entirely** — the trip
across the park *is* the errand, and it is what turns a coincidence into a plan —
and drop `minAmmo` from 80 to about 40, since the drawing now costs a quarter of
what it did.

**2 · Corners, not halves.** `SLOT_COLUMNS = 2` gives each painter a 4.73 × 4.58m
column running the full height of an 11 × 6.19m board; between them they own the
whole picture. Replace it with four corner slots. A 2.8 × 2.6m drawing box inset
0.45m from the canvas edge puts `halfU` at 0.127 and `halfV` at 0.210, with
centres at u ∈ {0.168, 0.832} and v ∈ {0.283, 0.717}. Three painters at once is
21.8m² of the board's 68.1m², all of it at the rim; the whole central band and
most of the height stay the player's. Four slots for at most three painters is
deliberate — it keeps the least-recently-used hand-out in `claimSlot` meaningful,
so a second round of drawings does not land on the first.

**3 · A legibility budget for the smaller box.** A splat on the screen is 0.476m
across, so a 2.8m box is under six blobs wide and the file header's warning
applies: "anything that needs a thin line or a small feature to read will not
survive". Measured, by rasterising each design at a range of box sizes and
stamping each mark as a disc — the figure is the fraction of the drawing's own
bounding area that ends up inked, and a shape that has closed up into a blob
scores high:

```
box (m)     4.7   3.6   3.0   2.4        marks at 3.0m
gulls        30    40    46    54            14
heart        31    40    46    55            26
smiley       31    41    49    60            31
letter A     32    41    49    57            21
sun          33    48    54    63            29
balloon      35    43    51    60            24
mushroom     38    49    58    70            32
cat          40    54    62    75            42
house        45    62    71    83            37
cloud        50    63    74    84            33
flower       51    69    73    80            44
fish         54    66    74    83            24
tree         57    73    79    86            25
```

The catalogue as shipped spans 30–57% at the current slot size, so 57% is a fill
we have already accepted as readable. At a 2.8–3.0m box the six sparsest designs
land at 46–54% — the same territory — and the dense half goes to 62–79%, which
is the lumpy disc the `CAT` and `FLOWER` comments in that file describe from the
last time this was got wrong.

So corner work draws from the sparse half only: gulls, heart, smiley, sun,
balloon, and the painter's own initial. Express it as a `minBox` in metres on
`MuralDesign` rather than as a second array, so the catalogue stays one list and
a new design declares its own floor. Raise `letterChance` for corner work while
you are there — an initial in the corner of a mural is exactly the thing the
prompt describes, and at 49% fill it is one of the best-behaved marks on the
board.

**4 · Fewer marks, so the job fits a real gap.** `maxDots` 56 → 26 for corner
work, which is what the measured mark counts at that box size come to anyway
(14–31 for the sparse set). At `fireInterval` 0.32 that is eight seconds of
standing still. With the walk-in, a drawing now fits inside a 20-second quiet
run, and every bot in the sample had several.

**5 · Commit, and resume.** The remaining cause is the one that costs most. A
painter that has arrived and started should keep painting through a sighting it
is not actually in a fight over — abandon on being hit, or on a target inside
some close range, not on `target` being non-null — and either way should **keep**
its slot, its dots and its index for `resumeSeconds` (30 or so) rather than
wiping them. A bot that breaks off to fight and then comes back to finish its
heart is the side quest the prompt is describing; a bot that restarts from
nothing and then sits out 45 seconds of cooldown is what we have. `abandonMural`
splits into `pauseMural` (keeps the lease, starts the resume timer) and the
existing full abandon (timeout, round end, restock, resume timer expired). The
`timeoutSeconds` backstop stays as it is.

Do **not** relax the "paint before art" ordering or the restock clause. A bot
that spends its last rounds on a drawing and then walks the park looking for a
crate is the failure `wantsToPaint`'s comment was written about, and lowering
`minAmmo` to 40 already spends some of that margin.

### Tests

The suite passed the whole time this was invisible in play, so the first new
test is the one that would have caught it, and it is not a rig:

- **the natural-round test.** No isolation, no teleports: run a full 300-second
  match and assert that at least one designated painter finishes a drawing and
  that the board carries paint from it at the whistle. This is the check the
  existing `isolate()` deliberately gives up, and it is the only one that speaks
  to the complaint. Use a fixed seed and assert a floor of one, not a count —
  the sample above says two to three is typical and one is the honest bar.
- painters are chosen once, are between one and three, and do not change during
  a round;
- every mark of a corner drawing lands inside its own slot rectangle, and none
  lands in the central band the player is being left;
- two painters at once hold different slots and leave different colours on the
  board — the prompt's actual ask, and cheap to read off the canvas;
- the design filter holds: every design offered for a corner slot is under the
  fill threshold at that box size, computed the way the table above was;
- the resume path: start a painter, put a target in front of it mid-drawing,
  take the target away, and assert it returns to the same slot and finishes the
  same design rather than starting a new one.

Keep the existing differential coverage test as it is — it is what stops the aim
work from rotting — and re-run it against the corner box, where a 0.4° cone at
8–11m matters more than it did at twice the size.

Then watch one. `npm run record` on a natural round with the camera on the
board, because "is that a heart" is not a number either.

---

## Not in this iteration

The **post to X** item from the first version of `prompt_7.md` was removed when
the prompt was updated, and nothing here plans for it. The two pieces it asked
for are still written up in the previous draft of this file if they come back:
a one-line copy change in `ResultsPanel.SHARE_TEXT`, and leading the share row
with the already-implemented "copy the picture" path, since the X intent has
never accepted an image and will not start.

## What cannot be tested on this machine

- **Frame time on real hardware.** `tools/perf.mjs` still needs a GPU behind
  ANGLE and the page never boots for it here. Nothing in this iteration should
  move it much — ten small static meshes and a handful of decal receivers — but
  the normal prepass named in `PLAN_6.md` is still the largest known cost and
  still the first thing to do on a machine that can measure it.
- **Whether a corner drawing reads.** The fill table is a proxy for legibility,
  not legibility. It is good enough to reject the dense half of the catalogue
  and not good enough to accept the sparse half; that wants `npm run stills` and
  a pair of eyes, and if 2.8m turns out to be too small the honest fix is 3.2m
  and two painters rather than a cleverer design.
- **One seed.** Every number in item 3 comes from a single 300-second run with
  the player standing still. The direction of the result is not in doubt — three
  splats is not a sampling artefact — but the exact split between "has a target"
  and "too far" will move with the seed and with a player who actually plays.
