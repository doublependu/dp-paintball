# PLAN_2 — the paint that wasn't there, and a park that holds together

Work done against `CLAUDE/FEEDBACK_1.md` (the human's second pass) and
`CLAUDE/NEXT_1.md` P0–P4. This is the record of what changed and why.

Two things dominate it. The first is `NEXT_1`'s P0 — character paint being
recorded and then not drawn — which turned out to have a cause nobody had
guessed and which is now diagnosed by measurement rather than by argument. The
second is the park itself: four things the human walked into and found broken.

---

## 1. P0: paint that scored and did not appear

### What was actually wrong

`NEXT_1` listed three candidate mechanisms and recommended starting with the
grazing-angle guard in `RigMaterial.ts`. That guess was in the right area and
wrong in the specifics, and finding out cost the first half of this session.
The real chain, established by instrumenting the recorded splat rather than by
reading the shader:

1. `BallisticsSystem.sweep()` casts the ball's shape with `stopAtPenetration`.
   When a step *begins* already overlapping the target, Rapier has no surface to
   report and returns `time_of_impact = 0` with a **contact normal of zero
   length**. There is nothing wrong with this; it is what a shape cast means.
2. At muzzle speed a ball covers **1.05m per fixed step**, so anything inside
   about a metre is struck by a step that started inside it. That is what
   "especially at close range" in the original complaint was pointing at.
3. That zero vector became the splat's projection axis. In the rig shader
   `abs( dot( vRigNormal, axis ) ) < 0.35` is then true on *every* face of the
   body, so the splat was skipped everywhere — recorded, counted, never drawn.

Nothing upstream is broken in that sequence, which is why it survived two passes
of reading the code: the hit is real, the score is right, `splatCount` rises,
and the paint is simply not there.

A second, quieter version of the same failure was in `resolvePaintAnchor`. The
impact point arrives on the **capsule**, which is 0.35m in radius where the torso
is 0.13m deep, so an ordinary square hit on the chest is recorded about 0.2m
clear of the body it is meant to paint. Against a 0.15m splat radius that fails
the shader's `abs( along ) > radius` test on every face — the same symptom by a
different route, and the reason the old `characterSplatRadius` had been pushed up
to 0.2 without ever fixing the problem.

### The fix, in three places

- **`Ballistics.emitImpact`** — a degenerate contact normal is replaced with the
  reverse of the flight direction, which is the normal a square hit would have
  had. This keeps bad data out of everything downstream, not just the rig.
- **`VoxelRig.resolvePaintAnchor`** — the anchor is snapped onto the surface of
  the nearest box, and the projection axis is tipped back toward that face's own
  normal when the two disagree by more than about 55 degrees. Blended rather
  than replaced: the residual tilt is what lets a splat wrap a corner.
- **`Config.paint.characterSplatRadius`** — 0.2 down to 0.15. The larger number
  was compensating for splats that had to reach the body before they could draw
  on it; on a corrected anchor it covered a whole torso face and scissored.

### How it is kept fixed

`tools/character-test.mjs` grew a sweep of twelve impacts over the capsule —
nine ordinary ones at a spread of yaws, heights and cap tilts, plus three
deliberately nasty ones: a zero-length normal, a point-blank hit recorded from
inside the body, and a normal pointing the wrong way. Each is measured by
photographing the frame, taking the paint off, and counting the pixels that
changed.

That measurement took four attempts to make honest, and the failures are worth
recording because every one of them *passed*:

- **Diffing across 0.35s of simulation** measures the park, not the paint: the
  canopies sway, the fountain runs, the clock ticks. Everything scored ~5%.
- **Diffing across the flinch** the hit itself triggers measures the animation.
  Every spot scored an identical 0.5%, including spots drawing nothing at all.
- **Matching the paint's hue** instead fails the other way: paint is cel-shaded
  and fogged like everything else, so a clearly visible splat scored 0.02%
  against a 0.22% background of sky and shadow.
- **A level camera** cannot see the top of a head, so a splat on the crown is
  correctly drawn and correctly invisible.

What works: face the terrace (the only backdrop on this map made entirely of
things that hold still), send the bots to the far corner so they cannot shoot
mid-measurement, hold the aim button so the character is four times its usual
area on screen, let the flinch settle, photograph, then *remove* the paint and
step one frame. Removal animates nothing.

Against the fixed code all twelve spots score 0.35–2.5% over a 0.09% floor.
Against the code as it was, six of the twelve are at the floor — including both
point-blank cases, at 0.17% and 0.08%. The test discriminates, which is the only
property that makes it worth having.

---

## 2. The marker (FEEDBACK_1, player character 1 and 2)

The old marker was four boxes riding on the right arm's joint, laid along the
arm's own -Y and continuing past the hand. It could only ever point where the
arm pointed, which is exactly what "an extension of the arm" describes, and it
meant the gun could not be aimed at anything.

- **A ninth joint, `JOINT.GUN`**, parented to the right arm with its pivot at the
  fist and set 8cm in toward the body's centre line.
- **The marker rebuilt as eight boxes** in that joint's own frame: grip under the
  receiver, hopper standing proud on top and set back, barrel a little over a
  third of the length, air tank behind the grip. That silhouette is what says
  *paintball* rather than *rifle*, and it is the whole reason the hopper is worth
  four boxes of vertices.
- **Two fists**, which is what turns a gun stuck to an arm into a gun held in a
  hand — without them there is a visible kink where the arm stops.
- **`CharacterAnimator.aimMarker`** solves the gun's orientation as the inverse of
  whatever the arm and torso are doing, times the orientation wanted: barrel
  along the body's forward axis, pitched to the view. Composing Euler angles
  does not work here — the aim pose tucks the shoulder inward, and a Z rotation
  above a pitched joint *yaws* what hangs off it, which put the barrel about 15
  degrees left of the crosshair.
- **The left arm braces** while aiming. It cannot reach the fore-end — these arms
  are 0.6m of straight box with no elbow and the fore-end is 0.9m from the left
  shoulder — but bringing it forward and inward reads as a two-handed hold.
- **`AimSolver.computeMuzzle`** re-measured onto the new barrel line, and
  `character-test` now asserts that a fired ball leaves within 18cm of the axis
  of the barrel that is drawn. It measures 1cm.

At rest the marker rides muzzle-down at the hip, which is where a hand holding
one actually carries it.

---

## 3. The park (FEEDBACK_1, environment 1–4)

**The grand stairs were nonsense.** Three flights had been placed on the plateau
*behind* the terrace, climbing north down a slope that rises from 0.9m to 3.8m
over the same ground: the bottom flight was buried whole, the middle one half
sunk, the top one stood in mid-air. They are now on the plaza side climbing
south onto the terrace, which is the real Bethesda arrangement and the one route
this map was missing — the terrace slab is a walkable roof 4.2m up and the only
way onto it was to walk round the back. The prop is scaled so three flights
climb exactly from the plaza to the slab, the arcade's side walls are split to
leave a gap at each stair head, and the mass under flights two and three is
filled in so they are stone rather than floating.

**Benches and lamp posts stood inside walls.** They were laid out on rings and
polylines with no knowledge of the buildings those rings pass through: two
benches sat inside the arcade's side wall and two 4.7m lamp posts stood under a
3.5m undercroft ceiling. `isClearForFurniture` now vets every placement against
the water, the fountain basin, the terrace footprint, the stairs and the sign.

**The lakeside railing stood in the lake**, on the bed, 3.4m under the surface.
It had been swept as an arc of fixed radius; the shoreline here is a
noise-wobbled ellipse whose distance from the plaza varies between 12m and 20m
over that same sweep, so no single radius could have worked. It is now placed by
walking the actual waterline and stepping along it at the prop's own width.

**Bow Bridge had no ramp.** Its abutments top out 2m above the ground its
approach corridor is levelled to, so both ends were a wall with a bridge on top.
Two stone embankments now carry the approach up to the deck — tilted slabs, so
the collider is exactly the thing that was drawn.

`arena-test` grew two checks that walk both routes rather than dropping onto
them, because every individual flight of stairs was exactly where it had been
asked to be.

---

## 4. The fountain and the birds (FEEDBACK_1, improvements 1 and 2)

`src/world/Fountain.ts` — the prop is stone only, which left the map's
centrepiece dry. Four small meshes and no physics: a pool in the basin, a pool
in the upper bowl, the sheet of water falling between them, and a splash ring.
Every radius is measured off the prop's own geometry. The spray is one static
mesh of billboard quads whose flight is computed in the vertex shader from a
launch angle and a phase — nothing to step, nothing to allocate.

`src/world/Birds.ts` — thirty birds, one instanced draw call, perched in the
same crowns the canopy cards are built from. They sit for a while, then flit to
a nearby tree; gunfire puts the nearby ones up. The flap is in the vertex shader
and the flight path on the CPU, which is the right split at this scale. They own
a forked `Rng` rather than drawing from the shared sequence, because they are
stepped from the render frame and every bot decision downstream would otherwise
depend on the frame rate.

The fountain is audible from anywhere on the plaza, as scheduled one-shots that
overlap into a bed rather than a loop.

---

## 5. Round hygiene (NEXT_1 P2)

- **`MatchSystem.restart` now respawns everybody.** `CharactersSystem` records
  where everyone stood at boot and `Bot.respawn` puts a bot back with its path,
  target and state cleared — a retained path walks it straight back into the
  fight that just ended.
- **The whistle.** `Synth.whistle` is two close tones beating against each other
  with a band of breath noise under them and a fast tremolo for the pea. Rising
  to start, two falling blasts to end. It is scheduled on unlock when the round
  starts before audio has been unlocked by a click.

---

## 6. Smaller things

- The bots have names — Ada, Bo, Cass, Dev, Etta, Fitz — with initials following
  the ids so `bot-c` is still findable as Cass from a screenshot.
- `@dimforge/rapier3d-compat` removed. It has been unused for three phases.
- `tools/capture.mjs` gained the two character-facing shots the rubric has never
  had: a painted bot at fighting range, measured for how many pixels its paint
  is responsible for, and the results line-up.
- `crosshair-test`'s "a shot lined up on a bot" check was casting from four
  metres above the bot, and failed whenever the bot wandered under the terrace —
  it was reporting the ceiling. It casts from a metre over the head now.
- `arena-test` sends the bots away before walking the undercroft, for the same
  reason the paint sweep does.
