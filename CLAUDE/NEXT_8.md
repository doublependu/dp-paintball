# Next, after iteration 8 (a playtester, four bugs, and a second take)

`PLAN_8.md` minus its gameplay section, as asked. The gameplay proposals are in
`GAMEPLAY_8.md` for you to choose from. Nothing in this iteration changes the
rules of the game.

## What was done

**The autopilot is now a playtester as well as a camera operator.**
`tools/autopilot.js` has two policies:
- `film` is what it was: it knows where every bot is and keeps a sightseeing
  schedule, for video.
- `play` has no schedule and no wallhack. It engages only what is inside its
  view and in line of sight, and learns where bots are only by hearing them:
  shots within 38m, and whoever just hit it. Between fights it walks between
  the park's named places.

Its randomness is seeded now, so a seed replays the same round exactly. It
records the metrics that `tools/playtest.mjs` (`npm run playtest`) turns into a
table over several seeds. There are two saved tables:
- `captures/playtest/baseline.json`: the build as it was at the start of the
  iteration.
- `captures/playtest/fixed.json`: the build as it is now.

**`record-match.mjs`** gained `--policy`, puts the metrics in `match.json`,
and adds a second, shareable encode next to the master (CRF 23, capped at
6Mbps). `npm run record:match` runs it.

**Four bugs, all found by the harness or the recorded round, and all
diagnosed before being fixed:**

1. **Painters froze on the way to the board.** `Bot.integrate` clears the path
   whenever a step is refused, even when the axis-slide fallback succeeded.
   `wander` and `restock` repath and recover; `muralist` never repathed, so a
   painter that grazed a wall a hundred metres out stood still until its 45s
   timeout ran out. In a rerun of the recorded seed it happened to Dev three
   times in a row, which is why the board was nearly empty in the take. Fixed twice over: the path
   is kept when the slide succeeds, and `approachStance` repaths when the path
   is exhausted. Measured stall: 26.5s → 0.3s per round. At least one drawing
   is now finished in every round (the baseline had none in two of five).
2. **The undercroft ended in a crawlspace.** This is the "camera inside the
   terrace" from the plan, and it wasn't a camera bug. The lawn that climbs to
   the Mall ran on under the slab, so the back of the undercroft was a floor
   rising into the ceiling across its full 60m width. It was also a real route:
   bots and players walked it up to the Mall, which is how the real arcade
   works too. Now the undercroft has a back wall at z=23.8 with solid fill
   behind it on either side. The three central bays lead out onto an
   open-air ramp to the Mall (the slab has a 12m cut over it:
   `TERRACE.undercroftBackZ`, `TERRACE.passageHalfWidth`). The first attempt,
   a thin wall, left the wedge behind it reachable from outside. The second, a
   solid fill across the whole width, closed the route and failed
   `bot-test`'s path-length check. The open passage is the third attempt.
3. **The camera went inside trunks and sign boards.** The arm is sphere-cast
   back from the shoulder point, 0.5–0.65m to the player's right, and that
   point was never checked itself. With a trunk or a board at the right elbow,
   the cast started inside it. `CameraRig` now casts the shoulder out from the
   pivot first. Measured: 27 frames per round → 0.
4. **The navgrid couldn't see sign boards.** Its five probe balls sat at the
   centre and the diagonals and never reached a cell's edge. Cherry Hill's
   0.12m board stands on a cell boundary, so bots walked through it and the
   player walked into it. The four outer probes now sit at the edge midpoints:
   the same query count, and the same ~100ms build. A whole-cell capsule probe
   was tried first. It was faster (67ms), but it closed every arcade bay to
   bots, so it was rejected.

Two autopilot bugs were fixed along the way. They affected only the tooling,
not the game:
- It crashed when a route refusal dropped a crate in the middle of a frame.
- It treated standing on Bow Bridge as standing in the lake, because it looked
  at the ground under the deck. It then kept trying to walk sideways off the
  deck until it was rescue-teleported.

## Tests

New checks. The two that guard behaviour were run against the old code and
fail there. The geometry checks test facts that were measured false on the old
build: the Cherry Hill cell was walkable, and the undercroft had no back wall.
- `arena-test`:
  - the undercroft has a back wall;
  - the passage is open to the sky;
  - walking south out of the arcade reaches the Mall;
  - **the camera is never inside geometry**, swept over 27 spots × 8 headings,
    which fails four ways on the old `CameraRig`;
  - the navgrid blocks every sign board.
- `mural-test`: in each natural round, **no painter stands still on the way to
  the board** for 12s or more. On the old `Bot.ts` it fails with 40-second
  stalls in two of three rounds.

`match-test`'s "a bot out of paint walks to the crate" check was fixed too. It
was flaky, and the new walls made it fail more often. Crates hide somewhere new
every run, and the test put the bot "9m east" of crate 0. That was sometimes
nearer a different crate, which the bot rightly took. For the east undercroft
crate it was also on the far side of an obstacle, a 61m walk that can't be
done in the 12s allowed. The test now keeps only the one crate and picks a
start point whose *route* is short. The failure message now reports where the
crate was and what the bot ended up doing.

**`npm test`: 12 suites, 250 checks, all passing** when each suite is run on
an idle machine (the count was 242). Flakes seen during the iteration, all of
them while the recording was encoding in parallel or with live bots
interfering:
- `screen-test`'s back-face check failed once, then passed 3 of 3.
- `touch-test` timed out once, then passed.
- The crate check above failed 1 of 12 runs after the fix. That one run was
  consistent with a live bot shooting the restocker, which sends it `startled`.

The suites share one machine with every other workload and use wall-clock
timeouts, so they shouldn't be run alongside a recording.

## The numbers, baseline → fixed

Five seeds, `play` policy, means:

| | baseline | fixed |
| --- | --- | --- |
| camera inside geometry (frames) | 6 | 0 |
| rescue teleports | 0 | 0 |
| player stuck events | 3 | 2 |
| painter walk-in stalled (s) | 26.5 | 0.3 |
| rounds with a finished drawing | 3 of 5 | 5 of 5 |
| board splats at the whistle | 15 | 18 |

The intermediate runs in between, before the autopilot's bridge fix, averaged
two rescue teleports a round, all on Bow Bridge's deck.

## Corrections to PLAN_8

- "No target in about 40% of samples" came from the `film` autopilot and does
  not hold. Under `play` the player is fighting 78% of the round, and first
  contact is 1.6s in on every seed. `GAMEPLAY_8.md` builds on the corrected
  number, and it changes one recommendation.
- The painter bug was diagnosed in the plan as "keeps re-entering the state or
  walking". It was neither: it stood still.
- The terrace frames were not a camera-collision bug (see 2 above).

## Still open

- **One stuck spot on Bow Bridge's deck at (-42, -20)**, once in five rounds.
  The navgrid is 2D and holds the ground under the bridge, so a player on the
  deck is routed along the underpass beneath it. The autopilot no longer
  mistakes the deck for the lake, which removed the rescues, but it still
  plans its route on the ground layer. Steering straight at the goal while
  elevated is the obvious next step. Bots are unaffected, because they never
  leave the ground layer, so this only affects the tooling.
- **The film policy still logs two "stuck" events** in the new take: at
  (-7, 39) on the way to the Mall stop (the same spot as in the original take)
  and at (-44, 41) by the painting wall. There is no collider at either spot
  and both cells are walkable. The autopilot counts any 0.8s window in which it
  wanted to move and covered under 0.9m, so these are most likely that
  heuristic firing near a stop rather than a real snag. They are unexplained,
  and harmless in the footage.
- **The share encode and the new take** are in `captures/match-8/`: 317.5s,
  no cuts, no camera clipping, no rescue teleports, no page errors. The master
  is 633MB (16Mbps) and the share copy 240MB (6Mbps). The old
  take in `captures/match/` is kept as the "before". The share copy has not
  been checked on a phone.
- **Frame time on real hardware**, and **iOS generally**: unchanged from
  `NEXT_6.md`. This machine still can't run `tools/perf.mjs`. Nothing here
  should move it: one extra sphere cast a frame for the camera, the same nav
  query count, and five static boxes around the terrace where there was one.
- `NEXT_2.md` P2 (bots can't use verticality) and `NEXT_3.md` P1 (the clock
  runs while the start card is up) are still open.

## Next

Choose from `GAMEPLAY_8.md`. My recommendation is its items 1–3 together (outs,
spread spawns, a hit-direction arc), tuned with `npm run playtest` against
`captures/playtest/fixed.json`.
