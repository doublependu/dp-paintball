# NEXT_1 — what to work on after PLAN_1

Written at the end of the phase A–E run that delivered Gameplay items 1–6 from
`FEEDBACK_0.md`. `CLAUDE/PLAN_1.md` is the record of what was built and why;
this is what is left.

State at the time of writing: `npm test` is nine suites, 135 checks, exit 0.
Everything in `FEEDBACK_0.md` is now addressed **except Visual item 1**, which is
below and is the most important thing on this page.

---

## P0 — Character paint still isn't reliable, and now it matters more

The oldest open complaint in `FEEDBACK_0.md`:

> "Character paint" is not rendered reliably. After a hit is registered by the
> scoring system, I often don't see paint at all on myself or an NPC. Especially
> when hitting an NPC at close range.

This was not fixed during phases A–E, and phase E raised the stakes: the
end-of-round line-up exists to show the paint people collected, so every dropped
splat is now visible twice.

What was established this session, by measurement rather than argument:

- **The paint shader is fine.** A splat stamped straight into a character's
  `CharacterPaint` renders correctly in isolation (`rig-preview.html`, which now
  retains its paint object precisely so this check is a one-liner) and in the
  world (stamped on the player's back, plainly visible behind the camera).
- **So the loss is upstream of the shader**, in the path from impact to splat, or
  in a shader *guard* rejecting a splat that was legitimately recorded.

Three candidate mechanisms, all of which produce exactly the reported symptom —
the score moves and no paint appears — and all of which are cheap to test:

1. **`RigMaterial.ts:157` — the grazing-angle guard.**
   ```glsl
   if ( abs( dot( vRigNormal, axis ) ) < 0.35 ) continue;
   ```
   `axis` is the impact normal in the joint's frame; `vRigNormal` is the face's.
   The guard exists for a good reason — a face nearly parallel to the projection
   axis takes a smeared streak, the classic decal artefact — but it silently
   drops the splat on *every* face when the angle is bad, and the splat is
   already in the buffer by then. Impact normals come from the **capsule**, not
   from the blocky body inside it, so a hit near the shoulder or the crown gives
   a normal tilted well away from any box face. Close range makes this worse,
   which matches the report's "especially at close range" exactly.
   *Test:* log or count splats whose guard rejects on all six faces.
   *Likely fix:* fall back to the nearest box-face normal when the capsule normal
   disagrees with every face by more than the threshold, rather than dropping it.

2. **`VoxelRig.ts:200` — the anchor bail.**
   ```ts
   if (bestPart < 0 || bestDistance > 0.5) return -1;
   ```
   and `Character.ts:181`, which returns `true` — hit registered — without
   painting. The capsule (radius 0.35, height 1.8) is more generous than the
   figure inside it: a shot into the gap between an arm and the torso, or above
   the head, lands on the collider and can resolve to nothing. That is a scored
   hit with no mark, by construction.
   *Test:* count `joint < 0` outcomes over a few hundred real impacts.

3. **`paint.characterMaxSplats: 24`** — the oldest splat is dropped once a body
   is carrying 24. Not the reported bug on its own, but it will look like it in a
   long round, and it interacts with (1): if a third of splats are being rejected
   by the guard, the visible count is much lower than the cap suggests.

Start with (1). It is the only one that explains "sometimes renders, sometimes
not" for hits in the same place, and the fix is local.

Worth adding a suite for this rather than eyeballing it: fire a hundred real
shots at a bot from a spread of angles and ranges and assert that the number of
*visible* splats tracks the number of registered hits. There is no test today
that would notice paint silently vanishing — `character-test` asserts
`splatCount` rises, which is the number in the buffer, not the number on screen.

---

## P1 — The economy is untuned, and only a play test can tune it

Phase C shipped the numbers from the brief without a play test behind them.
Three known-shaky ones:

- **100 rounds is about fourteen seconds of held trigger** at
  `fireInterval: 0.14`. A player who holds the button empties in the first
  skirmish and then walks around an empty park.
- **Bots will run dry faster than the player.** A bot's cooldown is
  `fireInterval × 1.6–3.4`, roughly 2.9 shots a second while engaged, so a busy
  bot empties in well under a minute of contact. Expect most rounds to end on the
  ammo condition rather than the clock — which is legal under item 5, but it may
  make five-minute rounds a fiction.
- **One crate per round** (`lootRespawnSeconds: 0`, as specified) may be too
  little to matter once six bots are hunting it.

The dials, in the order worth trying: `lootRespawnSeconds: 45` first, because it
turns the crate into the round's pacing mechanism rather than a one-off; then
`startingAmmo` up to ~150; then `fireInterval` toward 0.2, which limits the burn
rate without limiting the supply. A separate, larger budget for bots is the
fourth option and the one that costs the most fairness.

None of this can be settled from a test harness. It needs somebody to play three
rounds.

---

## P2 — A restart is not yet a fresh round

`MatchSystem.restart()` resets the clock, everyone's load, the scoreboard and the
paint people are wearing, and puts out a new crate. It does **not**:

- **Move anybody.** The player and all six bots carry on from wherever they
  happened to be standing when the whistle went, which for the player is usually
  face-down in whatever fight ended the round.
- **Clear the park's paint.** Deliberate — see `PLAN_1.md` — but it is a decision
  worth revisiting once several rounds have been played back to back, because the
  eviction cap means the oldest splats start vanishing mid-round rather than
  between rounds.

Respawning everyone at their original spawns on restart is a few lines
(`CharactersSystem` already knows the specs; `PlayerController.teleport` exists)
and would make a second round feel like a second round.

**The whistle is silent.** Every other beat in this game has a sound — the shot,
the splat, the tag, the pickup — and the moment the round ends has none.
`Synth.bell` is already used for the crate; a two-note fall on `match:ended` and
a rising pair on `match:started` would cost about ten lines and would do more for
the sense of a round than anything else on this page.

---

## P3 — The visual rubric is still blind where the bugs are

`NEXT_0.md` P4 said this and it is still true: all seven pinned viewpoints in
`tools/capture.mjs` are landscapes, and every visual bug reported so far has been
about characters.

Phase E hands this one a gift. The results screen is a framed, deterministic,
seven-character close-up with paint on every body — exactly the shot the rubric
lacks, and it can be reached from the test hook in three lines
(`match.timeLeft = 0.2; stepSim(0.5)`). Adding it plus one over-the-shoulder shot
of a painted bot at ~8m would make the metrics loop able to see the thing that
keeps breaking.

While in there: `metrics.json` has no measure that would catch P0. Something as
crude as "count pixels within a tolerance of each paint colour" on the results
shot would turn "paint sometimes doesn't render" into a number that moves.

---

## P4 — Smaller things, still true

- **Bots still can't use the terrace or Bow Bridge.** `NavGrid` is a single-layer
  2D grid; `NEXT_0.md` P1 has the options. Phase C worked around it by keeping
  every `LOOT_SPOTS` entry inside the walkable ground, but the arcade undercroft
  spot is the only one that uses the map's verticality at all.
- **`@dimforge/rapier3d-compat` is still a dependency** and still unused. Removing
  it drops a chunk of `node_modules` and the chance of someone importing the
  wrong one.
- **Character paint doesn't wrap 3D-adjacent faces** — `NEXT_0.md` P4. Rare and
  subtle, and distinct from the deliberate decision not to bleed paint onto
  surfaces a shot never reached. Note that P0 above may touch the same shader
  code, so they are worth doing together.
- **No proximity cue for the crate.** It is deliberately hidden with no marker,
  but a quiet positional shimmer inside ~12m would reward getting close without
  giving the position away. `AudioSystem` would need to know about `LootState`.
- **The bots' scoreboard names are `bot a`…`bot f`.** Now that they are lined up
  on a results screen with awards, they could use actual names. Cosmetic, cheap,
  and it would make the end card read like a group of people rather than a test
  fixture.

---

## Traps recorded, so nobody re-learns them

- **The bots suite is `tools/bot-test.mjs`, singular; its npm script is
  `test:bots`, plural.** Any loop of the form `node tools/$t-test.mjs` fails on
  that one suite with `MODULE_NOT_FOUND`, which looks *exactly* like a crashing
  test: no PASS lines, no summary, exit 1. It cost most of an afternoon and was
  twice reported as an intermittent flake. Run suites through `npm test`, and
  capture full output before believing one is flaky.
- **Pointer lock is refused if requested too soon after navigating away from a
  locked page.** The match suite's sandbox section was silently firing nothing
  for two phases because of this — it passed, on impacts that came from
  somewhere else. `lockPointer()` in `tools/match-test.mjs` retries and fails
  loudly; copy it rather than clicking once and hoping.
- **Nothing is posed until a frame has run.** Under `setManualSim(true)` a rig
  root sits at the origin until the first `stepSim`, so any world-space hit point
  computed before then misses the body and records no paint. Two separate "paint
  is broken" diagnoses this session were this, not the game.
- **Transitions advance per frame, and headless frames are ~700ms apart.** A
  200ms CSS transition needs a couple of seconds of wall clock to finish under
  SwiftShader. Reading a computed colour immediately after a class change gives
  the *start* value and looks like a broken rule.

---

## Suggested order

**P0 first, and on its own.** It is the outstanding item from the user's own
feedback, it is now doubly visible because of the results screen, and it has
three concrete candidate causes with a cheap test for each.

**Then P1**, because it needs a human at the controls and everything else on this
page can be done around it — and because the answers change what `Config`'s match
block should say.

**P2 and P3 together.** The restart hygiene and the whistle sound are small and
make rounds feel finished; the capture viewpoints are the thing that would have
caught P0 automatically, and are worth having before the next visual pass.

**P4 whenever.** The `rapier3d-compat` removal is five minutes and can go in with
anything.
