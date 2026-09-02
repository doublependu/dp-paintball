# Next, after iteration 6 (the board moves west, the bots learn to draw)

All seven items in `CLAUDE/prompt_6.md` are done — `CLAUDE/PLAN_6.md` is what
each turned into. `npm test` is twelve suites and 219 checks, exit 0. The new
suite is `tools/mural-test.mjs`; `screen-test`, `match-test` and
`character-test` all grew.

## The thing most worth carrying forward: a passing test that was measuring the wrong shot

`character-test`'s "the shooter is credited" failed on the first full run of this
iteration, and nothing in the diff touched aiming, hit routing or scoring. It
was the oldest kind of bug in this repo — a test that had been passing for the
wrong reason — and it took a bisect through five files to stop blaming the
render pipeline for it.

Two faults, and both had been there since iteration 2:

- **It aimed from the player and fired from the camera.** `AimSolver` traces
  from the camera, which sits 3.6m behind the character and off its shoulder,
  and points the muzzle at whatever that ray reaches. A yaw that lines the
  *player* up with a bot leaves the camera's ray passing half a metre to one
  side — a clean miss at ten metres. It usually landed anyway.
- **Its success condition was "somebody got hit".** Six bots with live triggers
  are shooting each other throughout, so the retry loop could stop on a
  bot-on-bot hit and then assert, correctly and uselessly, that a hit had been
  registered on a character.

What flipped it was that this iteration's bot code draws from `ctx.rng`, which
shifts the shared sequence, so every bot wanders somewhere slightly different
and the marginal aim stopped landing. **A test that depends on the RNG stream
depends on every future change to it.** The fix aims from the camera in two
passes and requires the player's own `hitsGiven` to move; it now lands six hits
where it used to scrape one.

The same lesson turned up twice more in the new suites and both times the fix
was to stop depending on incidental state: the mural test's control arm fired
from wherever the painting bot had since wandered to (anchored to the board
now), and the crate-marker test teleported to the mirror of one crate's position
without noticing that the other two are also on the map (it searches for the
point furthest from all of them now).

## Consequences worth knowing about

**The board is placed by measurement, and the site is in the file.** `SITE` on
Sheep Meadow's west rim was chosen by sampling `heightAt` across the real 13.2m
footprint at a dozen candidate sites: 0.27m of fall, no walk within 8m, no trees
in front, woodland at 0.68 density behind, 72m from the player's spawn. Two
flatter neighbours were rejected for putting the board's north end within 1.8m
of the meadow's western walk. The plinth now sinks to the lowest ground under
the footprint and the frame sits above the highest, because a single `heightAt`
sample at the centre was enough on the paving and is not enough on a lawn.

**Which face a hit lands on is decided by position, not by the impact normal.**
The normal was the obvious test and it is wrong: a swept-sphere cast against a
box reports a contact normal that can come back either way round, and a burst
fired into the back of the board split roughly evenly between the two faces,
half of it printing mirrored onto the picture. The frame's two planes are 0.45m
apart and the bounds check has already rejected every edge hit, so the sign of
the local z is unambiguous where the normal is not.

**Slots go out least-recently-used, and that is not a detail.** Two bots in
front of the same board can see each other, and a bot that can see somebody
stops painting and fights — so two simultaneous painters is a situation this
game will almost never produce, and the slot registry's real job is keeping
*successive* drawings apart. Handing out the first free slot put every picture
in a round on the same half of the board, on top of the last one.

**The mural's marks are 45cm and the strokes overlap.** At `screenSplatScale`
0.55 a bot's cat came out as three dozen separate dots with daylight between
them; a drawing made of paintballs needs its marks to touch. The two designs
that had to be redrawn — the cat and the flower — both failed the same way:
features that overlap on paper merge into one blob at this mark size. Everything
in the catalogue now sits outside everything else.

**The poster borrows the game's own camera for one frame.** It renders through
the real pipeline rather than a second one, and the readback happens in the same
synchronous task because the renderer has no `preserveDrawingBuffer` — that is
deliberate, it costs frame time. It runs before `ResultsStage` reparents the
characters out of the park, and nothing but system registration order enforces
that.

## What the frame-time work is and is not

The lag item was measured where it could be and reasoned where it could not, and
the difference matters:

- **`tools/perf.mjs` cannot run on this machine.** It needs a real GPU behind
  ANGLE/Vulkan and the page never boots. Every frame-time figure below is either
  from a software rasteriser, where absolute numbers are meaningless, or from
  first principles. **None of this has been measured on a real GPU.**
- **Adaptive resolution is verified working**, on a DPR-2 viewport under
  SwiftShader: the buffer walks 2560x1440 → 1920x1080 → 1280x720 and settles at
  the floor without oscillating. Its first implementation did not work at all,
  and the reason is worth keeping: it gated on a frame *count* and on
  accumulated `dt`, which `MAX_FRAME_DT` clamps at 0.25s — so the slower the
  machine, the slower it reacted, which is exactly backwards. It runs on wall
  clock now.
- **The shadow map redraws every other frame**, the mural uploads its canvas at
  20Hz instead of on every hit (9.4MB an upload, and bots painting make that the
  steady state rather than the exception), and the per-frame Rapier `Ray` and
  `Ball` allocations in the raycast, the camera arm and the projectile sweep are
  gone.
- **The normal prepass is still there, and it is still the largest known cost:**
  it renders the entire scene a second time every frame. `PLAN_6.md` proposes
  reconstructing normals from depth and deleting it, which needs a depth texture
  on the composer's targets. That change is not in this iteration on purpose —
  the plan says to do it only against measurements, and there are none to be
  had here. It is the first thing to do on a machine with a GPU.
- **One item in the plan was rejected on inspection:** folding the grade pass
  into the outline pass would save a full-screen pass, and it would also move
  the grain and vignette *underneath* the bloom, which is a different picture.
  The pass order is load-bearing.

## Still unverified

- **Everything about frame time on real hardware.** See above. The player who
  reported the lag is the only person who can say whether it is fixed, and the
  first question to ask them is what `resolutionScale` settles at (F3 shows the
  frame graph; the scale is on `game.render.resolutionScale`).
- **The share sheet on a real phone**, unchanged from `NEXT_5.md` and still the
  whole point of the feature. What *is* fixed is the desktop path: the X control
  was a button that started a download and called `window.open` in the same
  gesture, which browsers throttle silently, and the link went to the source
  repository rather than to the game.
- **Whether one bot painting at a time is enough.** In a real round a painter
  needs three seconds with nobody in sight and eighty rounds in hand, near a
  board 72m from the plaza. It happens; how often has only been watched in a
  rigged scenario with the other five bots sent to the far corners.
- **`context.filter` on older iOS**, and **iOS generally**, both unchanged from
  `NEXT_5.md`.

## Still open from before

- `NEXT_3.md` P1 — the round clock runs while the start card is up.
- `NEXT_2.md` P2 — the bots cannot use the map's verticality. Still the largest
  remaining piece of work in the game.
- `NEXT_2.md` P3 — the fountain's water takes no paint and no splash.

## New, small, and worth doing

- **Nothing tells the player the board exists.** It is 72m from the spawn now
  rather than 16, which was the point, and the sign plaque machinery in
  `render/SignPlaque.ts` has been sitting unused for two iterations. A plaque at
  the plaza's west exit is four lines of arena code.
- **The back face has no way to be wiped and no picture taken of it.** Both are
  deliberate for now; the first person to paint something regrettable on it will
  settle the question.
- **`mural.letterChance` is 0.22 and there are eight glyphs.** A bot whose name
  starts with a letter outside A-H silently draws a picture instead. Harmless,
  and it means the roster and the alphabet have to be kept in step by hand.
- **The crate marker is the first thing in this game that tells you where to
  go.** It was added reluctantly and it is gated to 60m for that reason. Worth
  looking at with fresh eyes after a round: if the beacon and the toast turn out
  to be enough on their own, the marker is the one to drop.
