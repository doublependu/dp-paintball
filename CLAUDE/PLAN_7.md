# Plan 7 — the board's dead border, the tweet that can't carry a picture, and a park that says where you are

`CLAUDE/prompt_7.md`, three items. They share nothing technically, but two of
them are the same *kind* of problem: something the player can see is part of the
thing they are aiming at, and the game silently disagrees.

Item 1 is a bug with a measured cause, and the measurement changed what the fix
should be — see below, because the first three hypotheses were all wrong.
Item 2 is half a copy change and half an admission that the platform will not do
what we want, so the interface has to stop pretending. Item 3 is new content
with one interesting constraint: every sign is a collider, and every collider is
a navgrid obstacle.

Order of work: 1, then 3, then 2. Item 1 is the reported bug and the smallest
diff. Item 3 is the largest and wants the shared sign builder extracted before
anything else touches `ParkArena`. Item 2 is last because it is the one that
cannot be verified here at all — see "What cannot be tested on this machine".

---

## 1. The bottom of the mural

### What is actually wrong

The complaint reads like a bounds bug in `PaintScreen.onHit` and it is not one.
The canvas accepts paint over its whole surface; `screen-test` already stamps at
`v = 0.8` and lands there, and a sweep of real shots confirms the accepted band
runs to the canvas's bottom edge.

What is wrong is everything *below* the canvas. I swept pitch from -6° to +26°
at 8m, 14m and 22m in front of the board, logging every `hit:world` in the
board's own frame. In board-local metres — the canvas runs y ∈ [-3.094, 3.094],
the frame's front face sits at z = 0.225 and the plinth's at z = 0.395, so a
ball centre reported at z = 0.28 struck the frame and one at z = 0.45 struck
the plinth:

```
from 14m   pitch=0   4 hits, 0 splats   y = -3.70 -3.53 -3.50 -3.46 at z=0.45
from 14m   pitch=2   4 hits, 1 splat    y = -3.10 -3.21 -2.95 -3.22 at z=0.28
from 22m   pitch=0   4 hits, 0 splats   y = -4.42 -4.50 -4.41 -4.26 at z=0.45
from 22m   pitch=2   4 hits, 0 splats   y = -3.63 -3.56 -3.52 -3.40 at z=0.45
from  8m   pitch=0   4 hits, 2 splats   y = -3.24 -3.15 -3.23 -2.76 at z=0.28
```

Every one of those zero-splat rows is a clean hit on the board that produced no
paint anywhere in the game. The reason is in `PaintScreen.build`: it creates its
two static boxes with `ctx.physics.createStaticBox` and never calls
`surfaces.registerMesh` on either. The class header defends this — "Deliberately
*not* a `SurfaceRegistry` receiver, so world decals never land on it" — and that
argument is right about the canvas and was over-applied to the whole board.
`PaintSystem.paint` looks the handle up, gets `undefined`, and returns. So:

- the **frame's timber border**, 0.32m all the way round, and
- the **plinth**, 1.1m of clear standing height plus the buried part,

are the only large colliders in the park that swallow a paintball whole. That is
1.42m of board face directly under the picture, against a 6.19m picture — a
quarter of the board's visible front — and it is exactly where the ballistic arc
deposits anything aimed low. `SceneCrosshair`'s own header measures the drop at
0.80m at 15m; the board is 72m from spawn and most shots at it are long ones.

The screenshot makes the last piece obvious: the plinth is `0xd8cdb8` and the
canvas is `#f7f4ec`. Standing in front of the board you cannot tell where the
painting stops and the plinth starts, so "the bottom of the mural" is precisely
what a player would call it.

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
   posts already get, and it removes 1.1m of the 1.42m.

2. **The frame** gets a purpose-built receiver: a "mount" geometry of eight
   quads — the border ring just proud of the front face, and the same ring just
   proud of the back — registered against the frame collider's handle via
   `surfaces.register(handle, { geometry, matrixWorld })`. A hit in the middle
   of the canvas clips none of those triangles and costs one `DecalGeometry`
   that returns zero vertices; a hit on the border clips four and paints.
   `PROJECTION_DEPTH` is 0.5 and the box is centred on the impact, so a front
   hit reaches z ∈ [0.03, 0.53] in board-local space and cannot catch the back
   ring at -0.237. That margin is why one geometry can hold both rings.

3. **`PaintScreen` needs the `SurfaceRegistry`.** It is constructed in `main.ts`
   with only the `SplatAtlas` today; it already receives a `GameContext` in
   `build`, so check whether `ctx` carries the registry before widening the
   constructor.

Then a secondary change that answers the complaint from the other side: **repaint
the plinth so it stops reading as canvas.** A stone grey against the cream —
something near `0xb9b3a4` — makes the picture's bottom edge legible from the
meadow. Do this *after* the paint fix and look at it; if the board reads worse as
two colours, drop it. It is a taste call and the functional bug is fixed
without it.

### What is deliberately not done

Extending the front face's canvas to cover the whole outer board — one texture
holding the border and the plinth, with the 16:9 region cropped out for the
poster — is the architecturally purer answer and it is the wrong trade here. It
grows the per-upload payload from 9.4MB to about 11.9MB at the same 20Hz, it
puts the timber and the stone inside the thing `toDataURL` exports, and it
rewrites the geometry, the poster crop and half of `screen-test` to fix a bug
that three registrations fix. Revisit it only if the border ever needs to hold
something the world-paint budget cannot.

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

## 2. Post to X

Two separate things, and the prompt is right that the second one is not fixable.

### The copy

`SHARE_TEXT` in `src/ui/ResultsPanel.ts` is `'We painted the park. Come and add
to it:'`. It becomes `'We painted Central Park. Come and add to it:'`, and
`GAME_URL` is already `https://v0.maize.live`.

Put the whole sentence in the intent's `text` parameter and drop the `url`
parameter, so the post reads exactly as asked. X splits `text` and `url` onto
separate lines in some clients; the URL still unfurls a card from the body, and
matching the requested string is worth more than the parameter being the
documented pairing. `navigator.share`'s `text` gets the same string, so the two
paths say one thing.

### The picture

The tweet intent has never accepted an image and will not start. The code
already knows this and says so in a `results__share-note` at the end of the row,
which is evidently not enough — the note is the last element after three
buttons, in the smallest type on the card.

Three changes, in order of how much they help:

1. **Lead with "Copy picture", not "Save PNG".** `navigator.clipboard.write`
   with an `image/png` `ClipboardItem` is already implemented and already
   buried. X's web composer takes a pasted image. Copy → open X → paste is
   two steps and no file manager, against the download-and-upload the prompt
   describes. Make it the first control, label it for what it is, and let the
   flash message say what to do next: "Copied — paste it into the post".

2. **Number the sequence.** The row becomes an ordered pair rather than a bag of
   buttons: *1 · Copy the picture* (falling back to *1 · Save the picture* where
   `ClipboardItem` is missing), *2 · Post to X*, then the note — now short,
   specific and attached to step 2: "X can't take a picture from a link — paste
   or attach the one you just copied." This is the instruction the prompt asks
   for, and it belongs in the flow rather than as a footnote to it.

3. **Always render the X link.** Today it only appears when
   `canShare({ files })` is false. On Chrome/Windows, ChromeOS and Android that
   check passes, the system sheet appears, and there is *no* X button on the
   card at all — which is one honest reading of "post to X still does not work".
   It is an anchor; it costs nothing to keep alongside the share sheet.

Keep "Share the painting" first where the sheet exists — on a phone it is still
the only one-step path, and it does carry the image.

Do **not** revive the button that saved and opened the intent in one click.
`ResultsPanel`'s own comment records why it was removed: a gesture that starts a
download and opens a popup is what browsers throttle, and the popup is the half
that loses, silently.

### Tests

`tools/ui-test.mjs` asserts the intent URL contains the exact sentence and the
game URL, that the X link is present with and without a stubbed
`navigator.canShare`, and that the row renders its two steps in order. The
clipboard path itself is not assertable headlessly — see below.

---

## 3. Signs for the places

The park is laid out from real ground — `ParkLayout.ts` names Bethesda Terrace,
the Mall, Sheep Meadow, the Lake, Bow Bridge, the Ramble, Cherry Hill and the
island — and `LOOT_SPOTS` already speaks that vocabulary to the player ("deep in
the Ramble", "the west bank above Bow Bridge") in a HUD hint. Nothing in the
world says any of it. The dedication sign is the obvious form to reuse, and it
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
  point to look toward rather than an angle, the way `placeSign` already derives
  its rotation from `PLAZA`, so a sign stays aimed at its subject if the subject
  moves;
- `buildSign(ctx, surfaces, group, spec)`, extracted from `ParkArena.placeSign`
  and used by both — same box-per-part construction, same
  `physics.createStaticBox`, same `surfaces.registerMesh`, same shadow flags.
  The dedication sign passes its own plaque and 2.4m board width; place signs
  pass theirs and about 1.9m;
- `signBlocks(x, z, margin)`, exported and shaped exactly like
  `PaintScreen.screenBlocks`, because two existing predicates need to know:
  `ParkArena.canPlant` (line ~841) so no tree grows through a sign, and
  `isClearForFurniture` (line ~668) so no bench or lamp post lands on one. The
  hardcoded `Math.hypot(x - SIGN.x, z - SIGN.z) < 2.2` in the latter folds into
  it.

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

## What cannot be tested on this machine

Carried forward from `NEXT_6.md`, and still true:

- **The clipboard and the share sheet.** `navigator.clipboard.write` needs a
  focused, permitted document and `navigator.share` needs a real platform sheet;
  neither survives headless Chrome. Every claim about item 2's *behaviour* — as
  opposed to its markup and its URLs — is unverified, and the person who
  reported it is the only one who can close it. Ask them specifically whether
  the copy-and-paste path works in X's web composer, because that is the step
  the plan is betting on.
- **Frame time on real hardware.** `tools/perf.mjs` still needs a GPU behind
  ANGLE and the page never boots here. Nothing in this iteration should move it
  much — ten small static meshes and a handful of decal receivers — but the
  normal prepass named in `PLAN_6.md` is still the largest known cost and still
  the first thing to do on a machine that can measure it.
