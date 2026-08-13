# NEXT_2 — what to work on after PLAN_2

Written at the end of the run that cleared `FEEDBACK_1` and `NEXT_1`'s P0, P2,
P3 and most of P4. `CLAUDE/PLAN_2.md` is the record of what was built.

State at the time of writing: `npm test` is nine suites, 121 checks, exit 0.
Everything in `FEEDBACK_1.md` is addressed. The one item carried forward
untouched is the economy, and it is first below because it is the only thing on
this page that a person has to be at the controls for.

---

## P0 — The economy is still untuned, and only a play test can tune it

Unchanged from `NEXT_1` P1, and now the oldest open item. Phase C shipped the
numbers from the brief without a play test behind them:

- **100 rounds is about fourteen seconds of held trigger** at
  `fireInterval: 0.14`. A player who holds the button empties in the first
  skirmish and then walks around an empty park for four minutes.
- **Bots run dry faster than the player.** A bot's cooldown is
  `fireInterval × 1.6–3.4`, so a busy bot empties in well under a minute of
  contact. Expect most rounds to end on the ammo condition rather than the
  clock, which is legal but makes five-minute rounds a fiction.
- **One crate per round** (`lootRespawnSeconds: 0`, as specified) may be too
  little to matter once six bots are hunting it.

The dials, in the order worth trying: `lootRespawnSeconds: 45` first, because it
turns the crate into the round's pacing mechanism rather than a one-off; then
`startingAmmo` toward 150; then `fireInterval` toward 0.2, which limits the burn
rate without limiting the supply.

Three rounds played end to end would settle all of it, and nothing else on this
page is blocked behind it.

---

## P1 — The results screen is the only place the new work is not measured

`capture.mjs` now takes a `painted-bot` shot and reports `paintPixels` — the
fraction of the frame a bot's paint is responsible for — and a `results` shot of
the end-of-round line-up. Two things are missing from that:

- **No baseline is recorded anywhere.** `metrics.json` holds the number but
  nothing states what it should be, so a regression that halves it reads as a
  number that moved. One line in this file naming the expected range would fix
  it, once a couple of passes have established what the range is.
- **The results shot is not measured for paint at all**, and it is the frame
  where paint matters most: seven bodies, close up, in a fixed frame. The same
  clear-and-diff trick used for `painted-bot` would work there and would be the
  strongest single check in the rubric.

Related and cheap: `character-test`'s paint sweep is the most valuable test in
the repo and it is also the slowest, at about ninety seconds of the suite's five
minutes. Most of that is `waitSim(0.7)` per spot waiting for a flinch to settle.
A `Character.settlePose()` or simply not flinching on a synthetic hit would cut
it to a third.

---

## P2 — The bots still cannot use the map's verticality

`NavGrid` is a single-layer 2D grid, so the terrace, Bow Bridge and the arcade
undercroft's roof are all invisible to it. This mattered less when the terrace
was unreachable by anybody; now that the grand stairs work, the map has a whole
upper level that only the player can use, and a bot chased onto the stairs
stops at the bottom of them.

`NEXT_0.md` P1 has the options. The cheapest one that would actually help:
- Keep the 2D grid, but let a cell carry a *second* walkable height and mark
  the pair as linked where a stair or ramp joins them. The pathfinder already
  string-pulls; it would need to know that moving between linked cells is legal
  and costs the climb.

This is the largest remaining piece of work in the game and it is the thing
standing between "a park with a terrace" and "a fight that uses the terrace".

---

## P3 — Things the new scenery has not been asked hard questions about

- **The fountain's water has no physics and no paint.** Shooting the falling
  sheet does nothing — the ball goes through and paints the pedestal behind it,
  which is correct — but a splash and a sound where a shot enters the basin
  would cost very little and is the kind of detail this game trades on.
- **The birds ignore everything except gunfire.** They do not scatter when a
  player runs through the tree they are in, which is the more common event.
  `Birds.scatter` already takes a position and a radius; it needs a caller.
- **Nothing has profiled the additions.** The fountain is four transparent
  meshes with their own shaders and the flock is one more draw call, and the
  perf budget has not been re-measured since. `npm run perf` exists for this.

---

## P4 — Smaller things, still true

- **Character paint doesn't wrap 3D-adjacent faces.** Rare and subtle, and
  distinct from the deliberate decision not to bleed paint onto surfaces a shot
  never reached. The anchor-snapping work in `resolvePaintAnchor` touched the
  same code and did not address this.
- **`paint.characterMaxSplats: 24`** is now a real ceiling rather than a
  theoretical one, because splats reliably draw. Worth watching in a long round
  whether the oldest vanishing mid-fight reads as a bug to a player.
- **No proximity cue for the crate.** Deliberately hidden with no marker, but a
  quiet positional shimmer inside ~12m would reward getting close without giving
  the position away. `AudioSystem` now has the fountain's proximity bed as a
  precedent to copy — see `updateAmbience`.
- **The lakeside walk runs into the water** south of the plaza. It is only a
  ground *colour*, so it reads as a gravel path disappearing under the lake at
  about x=-2. The railing placed this pass runs along the true waterline and
  makes the discrepancy easier to see, not harder.

---

## Traps recorded, so nobody re-learns them

Everything in `NEXT_1`'s trap list still applies. Added this pass:

- **A frame-to-frame pixel diff measures the whole park, not the thing you
  changed.** Canopies sway, the fountain runs, the character breathes, the clock
  ticks, and being hit triggers a flinch that moves half a percent of the frame
  on its own. Four separate measurements of "is the paint visible" passed
  against code that drew no paint at all. What works is in `PLAN_2.md` §1.
- **Matching a paint colour on screen does not work either.** Paint is
  cel-shaded, fogged and lit by a warm sun and a blue sky, so its hue on screen
  is nothing as tidy as the hex in `Config`. A visible splat measured 0.02% of
  the frame against a 0.22% background of sky and shadow.
- **A shape cast that starts penetrating has no normal to report.** Rapier
  returns zero, and a zero vector propagates silently through anything that
  normalises it — `Vector3.normalize()` divides by `length() || 1` and hands
  back the zero unchanged. If a normal comes out of physics, check it.
- **`heightAt` can be run in node** with `--experimental-strip-types` and a
  resolver hook that appends `.ts` to extensionless imports. Sampling the
  terrain directly is much faster than placing a prop and screenshotting it, and
  it is how the stairs and the bridge ramps were sized.
- **`rig-preview.html` answers marker and pose questions in one screenshot** and
  needs the *dev* server, not the preview build. `?yaw=1.5708` puts the four
  figures in profile, which is the view that shows what a limb is doing.
