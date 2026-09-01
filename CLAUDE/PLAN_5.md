# Plan 5 — the colour is wrong, the paint is finite, and the park needs a canvas

`CLAUDE/prompt_5.md`, six items. (Named `PLAN_5.md` rather than `plan_5.md` to
match the convention `CLAUDE.md` documents and every other file in this folder.)

They are not six pieces of work. Items 1 and 2 are two separate colour bugs in
the two separate paint pipelines — one in the rig shader, one in the decal
buffer — and each is a small, well-localised fix. Items 3 and 4 are the ammo
economy, which has been the oldest open item in this repo since `NEXT_1` and
which `NEXT_2.md` P0 says outright can only be settled by a person at the
controls: this prompt is that person, so the numbers go in as given. Items 5 and
6 are one new feature in two halves — a thing to paint on, and the picture of it
afterwards — and they are most of this iteration.

---

## 1. Pink paint on a green shirt comes out blue

**Cause, and it is exact.** `createRigMaterial` composites character paint by
replacing `#include <map_fragment>` (`src/character/RigMaterial.ts:134`). In
three's fragment chunk order, `<color_fragment>` runs *after* `<map_fragment>`,
and `<color_fragment>` is `diffuseColor *= vColor`. The material sets
`vertexColors: true`, and the shirt is a vertex colour: `VoxelRig` writes the
character's team colour into the `color` attribute for the torso, cap and brim
(`src/character/VoxelRig.ts:389`, colours assigned in `Character.ts:56-73`).

So the shader writes the splat's colour and then multiplies it by the shirt
underneath it. Every character splat in the game has been the *product* of the
paint and the clothing, not the paint.

That also explains why the wrong colour is specifically blue rather than merely
dim. Magenta `0xff3d81` × mint `0x3fc98a` ≈ `(0.25, 0.19, 0.28)` — a dark
blue-violet, which is exactly what a cool ambient sky and a three-band cel ramp
then present as "blue". Lime shirts give the same answer. The reason nobody
caught it is that the product of a paint colour and a *blue* shirt still looks
blue-ish, and the default torso in the part table is `0x3f8fd0`.

**Fix.** Move the paint loop after the vertex-colour multiply: replace
`#include <color_fragment>` with itself plus the loop, rather than replacing
`<map_fragment>`. Paint then writes `diffuseColor.rgb` last and is absolute, as
it already is in world paint — `PaintSystem`'s decal material has no
`vertexColors`, which is why the same bug does not exist there and why the park
has always shown the right colours.

**Trap.** `material.customProgramCacheKey` returns `voxel-rig-v3-…`
(`RigMaterial.ts:194`). It must be bumped, or a cached program from an earlier
compile in the same session is reused and the change appears not to work.

---

## 2. Overlapping paint of different colours z-fights

**Cause.** All world paint is one merged buffer drawn in one call
(`src/paint/PaintSystem.ts`), with a single constant polygon offset for the
whole mesh (`polygonOffsetFactor: -4`, `PaintSystem.ts:283`) and
`depthWrite: true`. The offset separates paint from the *surface*; it does
nothing to separate paint from other paint. Two decals over the same triangle
are generated from that triangle's own vertices, so after the same offset they
are not merely near-coplanar, they are the same depth to the bit — and which
one wins per pixel falls out of rasterisation order and interpolation
precision. That reads as speckle, and it moves when the camera moves. Trees and
benches show it worst because they are instanced props whose small triangles
collect several decals in the same square metre.

**Fix, recommended:** `depthWrite: false` on the paint material, keeping the
depth *test* and the polygon offset. Paint is one draw call in insertion order,
so with nothing self-occluding, the last decal to cover a pixel is the newest
one — deterministically, at every pixel, with no epsilon. That is also exactly
the rule character paint already documents ("later splats paint over earlier
ones, which is why the list is kept in the order the hits landed") so the two
pipelines end up agreeing.

What to check when doing it: paint is opaque and alpha-tested, so dropping depth
writes should not change how it occludes anything else — the world geometry
under it already wrote depth. Watch the transparent things drawn after it, the
lake and the fountain sheet, for paint on the fountain rim showing through
water.

**Fallback if that misbehaves:** bake a per-decal bias into the vertices —
push each decal along its normal by `(index % 48) * 0.0004 m` at `append()`
time. It works, it survives the repack in `evictOldest` because that preserves
order, and it is worse: two decals 48 apart in a 2000-splat buffer can still
tie, and the number needs retuning per surface scale.

---

## 3–4. The ammo economy, finally tuned by a person

`NEXT_2.md` P0 has said since iteration 1 that these numbers shipped from the
brief with no play test behind them and that only a play test could set them.
The prompt sets them, so they go in as given rather than as an opinion:

- `match.startingAmmo`: 100 → **200**. Roughly twenty-eight seconds of held
  trigger at `fireInterval: 0.14`, up from fourteen.
- `match.lootAmmo`: 20 → **100**. A crate is now half a fresh load rather than
  a rounding error, which is what makes going and getting one worth crossing the
  park for.

"Should spawn more" is the interesting half. Today `LootSystem` owns exactly one
crate: one `Group`, one `LootState.position`, and `lootRespawnSeconds: 0`
meaning "one per round and no more". Two ways to give it more, and they are not
close:

**Recommended — several crates at once, plus a respawn.** `LootState` becomes
`crates: Array<{ position: Vector3; rounds: number }>`, `LootSystem` builds and
places `match.lootCrates` of them (start at **3**) into distinct spots from
`LOOT_SPOTS` — there are eleven, so distinctness is free — and each taken crate
starts its own respawn timer at `lootRespawnSeconds: 35`. Three crates out at
once is what makes a crate a place to fight over rather than a race that one bot
wins at t=0.

Its cost is an API change with four call sites, and they should be listed
because that is the whole risk of this item:

- `src/ai/Bot.ts:306,326,420` read `this.loot.position` directly. Add
  `nearestCrate(loot, from)` to `LootSystem.ts` and use it at all three. Bots
  choosing the nearest crate rather than the only crate is better behaviour, not
  just a port.
- `MatchSystem.outOfPaint()` tests `this.loot.position === null`
  (`MatchSystem.ts:104`); it becomes "no crate holds anything". The clause
  matters and its comment explains why — paint sitting in a crate counts as
  paint in the park.
- `tools/match-test.mjs` touches `loot.position` in roughly a dozen places,
  including writing to it to stage a bot's approach (line 245). These are the
  suite's crate tests and they need porting, not deleting.

**Cheaper, if the above proves too big for one pass:** keep one crate and set
`lootRespawnSeconds: 35`. It satisfies "spawn more" literally and touches one
config line. It does not give the park more than one crate to fight over at a
time, which is the part worth having.

**Two dials that are now wrong and are easy to miss**, both scaled off the old
hundred:

- `match.lowAmmo: 20` — the HUD's warm-counter threshold. At a 200 load this
  turns warm at 10% left instead of 20%. Take it to **40**.
- `match.botSeekAmmo: 15` — below this a bot goes looking for paint instead of
  a fight. At the new load a bot at 15 rounds has 7.5% left and has spent the
  whole round not seeking. Take it to **30**.

`match.durationSeconds: 300` stays. With 1400 rounds in the park at the whistle,
rounds should now end on the clock rather than on the ammo condition — which is
what `NEXT_2` said five-minute rounds were a fiction without.

---

## 5. The canvas: a big white screen to paint on

A free-standing painting screen in the park: white, framed, and large enough
that seven people shooting at it produce something worth looking at.

**Size and site.** 12 m × 6.75 m — 16:9, because the picture of it is going out
to social media and a square or 4:3 poster gets letterboxed there — with its
bottom edge about 1.2 m off the ground on a stone plinth and a dark timber
frame, so its silhouette reads as a canvas rather than as a wall.

Site wants: flat authored ground, inside the navgrid, near where fights already
happen, and not across an existing sightline that the map depends on. First
candidate is the **plaza's east rim, roughly x = +17, z = 0, facing west across
the fountain** — `PLAZA` is `{ x: 0, z: 2, radius: 20 }` and paved flat, the
player spawns at `(0, 1.5, 10)` looking into it, and the fountain at the origin
gives the screen something to be seen across. Settle the exact transform the way
the stairs and the bridge ramps were settled: sample `heightAt` under node (the
recipe is in `NEXT_2.md`'s trap list) and take one screenshot. Two things to
check while doing it — `bot-b` spawns at `(16, 0, 6)`, close enough to land
inside the frame; and the screen gets a collider, so `NavGrid` — which derives
walkability by querying physics, and then flood-fills to prune what it cannot
reach — must not end up with a slice of plaza cut off behind it.

**How paint gets onto it, and this is the design decision of the iteration.**
The screen should *not* be an ordinary `SurfaceRegistry` receiver taking decals
like every other surface. Two reasons:

1. **The decal budget would eat it.** World paint is a 150k-vertex buffer with
   oldest-first eviction. A wall that every player shoots at deliberately is the
   heaviest decal producer in the park, and the mural would both consume the
   budget that the rest of the park's paint lives in *and* be the first thing
   evicted out of it. A mural that erases its own beginning is not a mural.
2. **The picture has to leave the game.** Item 6 needs a PNG. From decals that
   means an orthographic camera, a render target and a `readRenderTargetPixels`
   round trip, with colour-space and flip pitfalls at every step.

So the screen carries **its own paint, in texture space** — a 2048 × 1152
`CanvasTexture`, cleared to white, with each hit stamped into it by the 2D
canvas API. This is the technique `PaintSystem`'s header explicitly rejects for
the park, and the reason it rejects it is the reason it is right here: texture
space fails on a 130 m map because 4096 texels buy 5 per metre, and succeeds on
one 12 m board because the same budget buys 170.

Mechanics:

- **New module**, `src/world/PaintScreen.ts`, built by `ParkArenaSystem`
  alongside the other architecture. It owns the mesh, the collider, the canvas
  and the texture, and exposes `toBlob()`/`toDataURL()` and a `splatCount`.
- It **does not register in `SurfaceRegistry`**. `PaintSystem.paint()` already
  returns early when the registry has no receiver for a collider handle, so
  world decals stay off it for free with no new branch. It subscribes to
  `hit:world` itself.
- **Impact to UV** is the inverse world matrix and a divide — the board is a
  plane with a known transform, so no raycast. Reject hits whose normal
  disagrees with the board's forward, or the back and the edges collect paint
  that the front-on picture cannot show.
- **Stamping** reuses `SplatAtlas` rather than drawing new shapes, so a splat on
  the canvas is the same shape as a splat on a bench. The atlas is a
  `DataTexture` over a `Uint8Array`; build a `<canvas>` copy of it once at init
  via `putImageData`, then per hit: draw the variant's tile into a scratch
  canvas, `globalCompositeOperation = 'source-in'` with the shooter's colour to
  tint the mask, and composite that onto the mural at the impact UV with the
  same speed-scaled radius and random roll `PaintSystem` uses. Set
  `texture.needsUpdate` and nothing else — no render pass, no readback.
- **Material**: `createCelMaterial` takes no `map`, so it needs a `map` option
  added, or the screen gets a small dedicated material. Either is fine; the
  first is three lines and helps the next caller.
- **Lighting.** A white board under a warm key and a cool hemisphere fill will
  not read as white in the park, and should not — but the exported picture
  should be paint on white paper, not paint on cream. The export comes from the
  2D canvas directly, so this resolves itself: the world shows a lit board and
  the PNG shows the canvas. Worth stating because it looks like an inconsistency
  and is deliberate.
- **Across rounds:** the mural persists through a restart, matching the choice
  `MatchSystem.restart` already documents for world paint ("a park that carries
  the day's mess from round to round is more in keeping with this game"). One
  config flag can wipe it per round if the opposite turns out to feel better.

---

## 6. The poster: the mural on the results card, and sharing it

**On the card.** `ResultsPanel.show()` grows a panel above the score table
holding the mural — an `<img>` fed from `toDataURL()`, at the card's width,
16:9, with the same ink border the card uses. `ResultsSystem` already assembles
everything the panel shows, so it passes the screen in the same call as the
scores; it needs a reference to the screen, which it can take the way it takes
`RenderSystem` — one explicit constructor argument rather than widening
`GameContext`.

Layout consequence worth planning for: the card is already tall, and
`ResultsStage.PANEL_SHARE = 0.34` is the arrangement that keeps the line-up's
legs clear of it. Adding a 16:9 image pushes past that. Either raise
`PANEL_SHARE` to match, or put the mural and the score table side by side on a
wide viewport and stacked on a phone. The second is better and is a media query.

**Sharing.** What is actually possible, stated plainly, because the prompt asks
for something the web only half-supports:

- **`navigator.share({ files: [png] })`** — Web Share Level 2 — is the real
  answer, and it is the one that matters, because it works on iOS Safari and
  Android Chrome and it opens the system sheet with X, Instagram, Messages and
  everything else the phone has. This is a phone game with an install flow; the
  phone path is the path.
- **X cannot be handed an image by URL.** `twitter.com/intent/tweet` accepts
  `text` and `url` and nothing else. So the desktop fallback is a row of three:
  *Save PNG*, *Post to X* (opens the intent prefilled, having first saved the
  image, which the player attaches), and *Copy image* via `ClipboardItem` where
  it exists. Do not dress the intent link up as if it posts the picture.

Three traps, all of which will otherwise be found the hard way:

1. **Build the blob when the card appears, not in the click handler.** iOS
   consumes the user gesture across an `await`, so `canvas.toBlob(...)` followed
   by `navigator.share(...)` fails there with a `NotAllowedError`. Generate the
   `File` when `match:ended` fires and have the handler call `share` directly.
   The same rule saves `window.open` for the X intent from the popup blocker.
2. **Feature-detect with `navigator.canShare({ files })`**, not
   `'share' in navigator`. Desktop browsers advertise `share` and refuse files.
3. **The buttons must not restart the round.** `.results` is
   `pointer-events: none` so a click falls through to the canvas, and the canvas
   click is what re-locks the pointer and starts the next round
   (`Game.ts:132`). The share controls opt back in with
   `pointer-events: auto` — the precedent is `.results .fork-badge`, and the CSS
   comment there explains it. On touch the same thing already works because the
   results card sits at z-index 38 and the tap-to-play-again layer at 36; the
   layer stack comment in `style.css` is the record of that and should be
   updated rather than rediscovered.

---

## Tests

The two colour bugs are the interesting ones to test, because `NEXT_2.md`'s trap
list says both of the obvious approaches do not work: a frame-to-frame pixel
diff measures the whole swaying park, and matching a paint colour against the
hex in `Config` fails because everything on screen is cel-shaded, fogged and lit
by a warm sun. Both tests below are *differential* for that reason — they
compare two rendered things to each other, never a rendered thing to a constant.

- **`character-test`, item 1:** paint two characters with *opposite* shirt
  colours — a mint bot and a magenta one — with the same paint colour, at the
  same spot on the torso, from the same camera. The two splat regions must come
  out within a small tolerance of each other. That is exactly the invariant the
  bug breaks and it needs no absolute hue. A second cheap check: the splat's red
  channel must exceed the unpainted shirt's beside it.
- **`paint-test`, item 2:** put two decals of clearly different colours
  overlapping on one bench face, then screenshot from two camera distances a
  couple of centimetres apart. The overlap must be dominated by the *newer*
  colour in both, and must not change between them. Speckle that flips with the
  camera is precisely what the player reported.
- **`match-test`, items 3–4:** starting ammo is 200, a crate holds 100, three
  crates are out at the whistle, a taken crate comes back after
  `lootRespawnSeconds`, and `outOfPaint` stays false while any crate still holds
  rounds. The existing crate tests need porting to the array either way.
- **New `tools/screen-test.mjs`, items 5–6:** a shot at the board's centre lands
  at the expected UV; the canvas is pure white before the first hit and is not
  after; `toDataURL()` returns a PNG of the right dimensions; and the results
  card shows an `<img>` with a non-empty `src` once the round ends. Add it to
  the `test` script alongside the other eleven.

---

## Order of work

1. **Item 1**, then **item 2** — two small shader-level fixes, independent of
   everything else, and both are visible in the next screenshot.
2. **Items 3–4** — config first (five numbers, immediately playable), then the
   multi-crate refactor and its test port.
3. **Item 5** — the screen, its site, its texture and its stamping. This is the
   long pole and the only item with a geometry question in it.
4. **Item 6** — the card and the share row, which cannot be built before there
   is a mural to put on it.

## Deliberately not in this plan

- **A wipe button for the mural.** It will be wanted eventually; it is a UI
  question ("who is allowed to clear the park's shared painting?") that a round
  of play should answer first.
- **Anything that makes the screen a gameplay objective** — scoring coverage,
  claiming territory by colour, a per-player share of the canvas. All of it is
  tempting and none of it is in the prompt, which asks for a thing to paint on.
- **`NEXT_3.md` P1**, the round clock running while the start card is up, which
  remains open and untouched by any of this.
