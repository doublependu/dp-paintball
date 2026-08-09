# What to work on next

Written after phases 0–10 shipped: 86/86 headless tests passing, 1.4s load,
11–14ms frames at 1080p, 827 KB gz. The engineering is in decent shape. What's
left is mostly *game*, plus one bug that quietly makes the core verb feel broken.

Ranked. P0 is a day's work and changes how the game feels more than anything
else on the list.

---

## P0 — The crosshair lies

`src/gameplay/Weapon.ts:75` aims the muzzle straight at the point under the
crosshair:

```ts
this.shotDirection.subVectors(this.aimPoint, this.muzzle).normalize();
```

No compensation for the arc. `src/ai/Bot.ts:401-404` does compensate. So bots
tag the player reliably while the player's shots sail underneath, and the effect
is invisible up close and severe at range — which reads as "hit detection is
random" rather than "you're aiming wrong."

Integrating the real projectile step (gravity −22, linear drag 0.42, muzzle 42
m/s) gives the drop below the crosshair:

| Range | Drop | Verdict |
|---|---|---|
| 5m | 0.21m | lands low on the body |
| 8m | 0.46m | hits the legs |
| 10m | 0.80m | hits the ground in front of the target |
| 15m | 1.73m | passes under a 1.8m character entirely |
| 20m | 3.16m | nowhere near |

This is almost certainly the real content of the "paint doesn't show up on
players" complaint. That investigation measured 64 individual hits and found
every single one painted correctly — the paint system was never broken. The
shots were missing.

**Fix:** put a launch solver in `BallisticsSystem` and have *both* the player and
the bots call it:

```ts
solveLaunch(from: Vector3, to: Vector3, out: Vector3): boolean
```

Solve it numerically against the same integrator projectiles actually use — fire
a virtual shot, measure the miss at the target's range, lift the aim by the
error, repeat two or three times. Closed form won't do: the existing bot formula
is `0.5·g·t²` with `t = range / muzzleSpeed`, which ignores drag and so
undershoots by 0.33m at 15m. Bots are visibly bad shots at range for that reason.

Routing both shooters through one function is the point. The asymmetry exists
because the same physics got re-derived in two places; a shared solver means it
can't drift apart again.

**Design call worth making explicitly:** full compensation makes the crosshair
truthful but hides the arc, and the lazy readable arc is a deliberate,
charming part of this game. The alternative is an honest crosshair — project the
solved trajectory forward and draw the reticle where the ball will actually land,
leaving the shot itself uncompensated. That teaches the arc instead of erasing
it, and suits a game whose stated vibe is playful rather than competitive.
My recommendation: compensate the shot (players expect the crosshair to be
where the ball goes), and keep the arc visible through tracer/impact feedback
rather than through the player having to miss to learn it.

**Then re-judge the paint.** `characterSplatRadius` went 0.13 → 0.2 and shipped,
but hasn't been played since. Judging splat size while half the shots miss is
measuring the wrong thing. Do P0 first, then look again.

---

## P1 — Bots can only use the flat ground

`src/ai/NavGrid.ts` is a single-layer 2D grid: one walkability bit and one ground
height per (x, z) cell. The terrace, Bow Bridge and the arcade undercroft
therefore can't be pathed onto — and the bridge is a bridge, so the cell it
occupies is already claimed by the water underneath it.

This is the largest gameplay loss on the list. Those are the three most
interesting pieces of level geometry in the park and the AI treats all of them as
scenery. Five bots milling around the plaza is a much smaller game than the map
implies.

Two approaches:

- **Multi-layer grid.** Key cells by `(x, z, layer)` and let a column hold more
  than one walkable surface, with vertical links where surfaces are reachable
  from each other. Correct, and roughly a rewrite of the grid build plus the A*
  neighbour expansion.
- **Grid plus explicit links.** Keep the 2D grid for open ground, hand-author a
  handful of connections (ramp foot → terrace top, both bridge approaches), and
  let A* traverse them as extra edges. Much cheaper, covers the actual cases,
  and doesn't generalise.

Given there are exactly three structures, the link approach earns its keep.
Revisit if the map grows.

Watch out for `canTraverse()` — the step-versus-slope rule that made the Mall
reachable. Whatever replaces the grid has to keep that logic or the same class of
bug comes straight back.

---

## P2 — The deployed build may be broken for other people

`.github/workflows/deploy.yml` publishes to Pages, so that URL is the first thing
anyone else sees, and characters reportedly render wrong there while being fine
locally. It was deferred pending console output.

The leading theory is `uJoints[ int( aJoint ) ]` in `src/character/RigMaterial.ts`
— dynamic indexing into a uniform `mat4` array is legal in GLSL ES 3 but is a
known soft spot across drivers, and this machine's RTX 3060 is a single data
point. All three rig materials index that way, which fits the symptom of
characters specifically being wrong while the world is fine.

Cheapest path: stop guessing and make it not matter. Pack the eight joint
matrices into a `DataTexture` and fetch from it, which is the standard approach
and what three.js itself does for skinned meshes above a bone-count threshold.
Eight matrices is 32 texels — trivial. If the theory is wrong, nothing is lost
but a small refactor; if it's right, it fixes a bug that can't be reproduced
here.

Ask for the console output first anyway. It's free and it might name the problem.

---

## P3 — There's no match, just a sandbox

You can shoot forever and the counters go up. No round, no timer, no arrival or
departure, no reason to stop. "Playful and relaxing" argues against a competitive
structure, but it doesn't argue for *no* structure — the current state has no
shape at all, so a session ends when the player gets bored rather than when
something concludes.

The lightest thing that would work: a generous round timer (5 minutes?), the
existing scoreboard promoted to a full-screen beat at the end, and an immediate
restart. No elimination, no win condition beyond "who tagged the most," bots keep
playing regardless. That's maybe 150 lines and it converts a tech demo into
something with a beginning and an end.

This is a design decision, not a defect. Worth deciding deliberately rather than
drifting into it.

---

## P4 — Smaller things worth doing

**The visual rubric has no character coverage.** All seven pinned shots in
`tools/capture.mjs` are landscapes — plaza, terrace, mall, lake, bridge, ramble,
arcade. Not one contains a character. Every visual bug reported so far has been
about characters: the outline bug, the paint visibility complaint. The metrics
loop is blind in precisely the area that keeps failing. Add two shots — a bot at
~8m with paint on it, and a close-up — and the rubric starts covering the things
that actually break. Cheapest high-value item on this page.

**Recoil has no recovery.** `Weapon.ts:94` nudges pitch and leaves it there,
with a comment saying phase 7 would do better. Phase 7 didn't. Sustained fire
walks the camera upward and the player has to drag it back down manually. A
spring back toward the pre-shot pitch is a few lines.

**Character paint doesn't wrap 3D-adjacent faces.** `resolvePaintFaces()` blends
across faces that are neighbours *in the atlas*, so a hit on a box corner can
stamp a face that isn't physically adjacent, and can miss one that is. Rare and
subtle. Note that this is a different thing from bleeding paint onto surfaces the
shot never reached, which was considered and deliberately rejected — this is
about the faces the splat legitimately touches.

**`@dimforge/rapier3d-compat` is still a dependency** and isn't used by anything.
Removing it drops a chunk of `node_modules` and eliminates the chance of someone
importing the wrong one and quietly re-inlining 842 KB of base64 wasm.

---

## Suggested order

P0 first and alone — it's small, it's the core verb, and it changes the baseline
that every subsequent judgement about feel and paint gets made against. Then the
capture-set addition from P4, because it makes the next visual iteration
measurable. Then P1 or P3 depending on whether the next session should be about
the world getting better or the game getting a shape.
