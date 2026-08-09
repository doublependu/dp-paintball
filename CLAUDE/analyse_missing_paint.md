

The bug

The splat centre was the point where the ball hit the physics capsule — not the body. The capsule is 0.35 m in radius; the torso box is 0.13 m half-deep, so a face-on chest hit left the splat floating 0.24 m off the shirt. The shader discards a splat whose surface is further away than its own radius (0.14–0.30 m, scaled by impact speed), so torso hits sat right on the threshold and impact speed decided the coin flip.

Measured with takeHit instrumented and real bursts fired:

┌─────────────┬────────┬───────────┬─────────────────────┐
│     box     │ splats │ discarded │ float above surface │
├─────────────┼────────┼───────────┼─────────────────────┤
│ torso       │ 6      │ 3 (50%)   │ 0.242 m             │
├─────────────┼────────┼───────────┼─────────────────────┤
│ head        │ 18     │ 0         │ 0.171 m             │
├─────────────┼────────┼───────────┼─────────────────────┤
│ arms / legs │ 8      │ 0         │ 0.08–0.13 m         │
└─────────────┴────────┴───────────┴─────────────────────┘

The head is 0.22 m half-deep, so it clears the gap every time — which is exactly why your face paint always worked and the torso didn't. Close range is worst because a face-on hit is where the capsule stands proudest of the chest. Survivors also came through at taper ≈ 0.6, i.e. faint.

This mismatch predates the rewrite; the rewrite only changed how it fails. The old code clamped into face UV space so it always painted, just nudged. The new depth gate turns the same error into nothing.

The fix

resolvePaintAnchor snaps the anchor onto the surface of the box it resolved to — a per-axis clamp, which for a point outside a box gives exactly the surface point the ball would have struck. src/character/VoxelRig.ts:183, one import plus ~10 lines.

After: float 0.000 m, zero discarded at 1.5 / 2 / 4 / 8 m, every scored hit painted (26/26 and 30/30). Torso splats also render ~40% larger now, since taper goes to 1.0.

Two corrections to things I said earlier

My screenshot A/B was invalid. It showed no difference — but the synthetic hit resolved to ARM_R, not the torso: the bot's aiming pose swings its arm into the chest, and the arm is thin enough that the centre landed inside it in both builds. The evidence above is the instrumented real-shot measurement, not a picture.

I said the fragment loop's GPU cost was unmeasured. It's now measured: 14.80 ms → 14.70 ms worst median on an RTX 3060, 68 fps either way. No cost.

One test failure, not a regression

predicted impact tracks the real one fails intermittently (~2 in 8 runs). Shot 7 of 8 occasionally predicts 10.3 m where the ball lands at 7.3 m. It is not a character hit — I added a label to the test to check that hypothesis and it disproved it. The cause is the documented ray-vs-swept-sphere difference in predict(): the prediction's ray sails past a thin obstacle the 5.5 cm ball clips, tipped either way by the weapon's random spread.

It isn't a physics change: the median is identical before and after (12.1–12.2 cm), and all seven other shots reproduce the pre-rewrite errors to a fraction of a centimetre. On the pre-rewrite commit I got 4/4 clean, so I can't rule out that the rate shifted — but 8 runs is too small to attribute, and the mechanism doesn't touch anything the rewrite changed. Happy to harden the test (exclude grazing obstacle cases, or widen the worst-case bound) if you want it quiet.

State

Uncommitted on top of your 2996ee0: the fix in src/character/VoxelRig.ts, plus the diagnostic label in tools/crosshair-test.mjs I added while investigating — say the word and I'll drop the latter. CLAUDE/FEEDBACK_0.md is your own edit, untouched by me. Character tests 17/17, typecheck clean, build green.
