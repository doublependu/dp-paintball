# Next, after iteration 3 (the phone build)

What was asked for is done and green: `npm run test:touch` drives the whole
scheme through real touch events and passes 20/20, and the nine older suites are
unchanged at pass.

## The one thing a machine cannot tell us

**None of this has been held in a hand.** Everything below the plumbing —
whether the fire button falls under the thumb, whether `touch.lookScale` turns
the camera at the speed a wrist expects, whether the stick's 58px radius suits a
phone smaller than the 844×390 the tests use — is a judgement that needs a real
device and a real player. The numbers are all in one place (`touch` in
`src/core/Config.ts`) precisely so they can be argued with.

Two specific unknowns worth naming:

- **iOS.** Fullscreen and orientation lock are both requested and both fail
  silently on an iPhone; the portrait gate carries it instead. That path is
  written and reasoned about but has never run on the hardware it is for.
- **Frame rate.** The pixel-ratio cap (1.5) and the halved shadow map are the
  cheap, obvious savings, and the suite asserts the cap is applied. Whether a
  mid-range phone actually holds a playable frame rate in the park is unmeasured
  — `tools/perf.mjs` runs on a software rasteriser and cannot answer it.

## Worth doing next

**P1 — the round runs while the start card is up.** Tapping to play is the
gesture that buys fullscreen, so there is a window between "loaded" and "playing"
in which the clock ticks and six bots are already loose. A phone takes longer
over that window than a desktop does, and a player can be tagged before their
first tap. The fix is not a new phase: hold the round until the first engage and
let `match:started` be what the tap triggers. Worth doing for the desktop too,
where the same hole has always existed behind "click to play".

**P2 — a tap that starts the round should not also be a look.** The pointer that
lands on the start card keeps its implicit capture, so the drag that follows
straight after the first tap is swallowed. Harmless, and briefly confusing.

**P3 — the look zone could carry a fire tap after all.** It was left out
deliberately (a tap while repositioning a thumb must not cost paint), but a
double-tap, or a tap with a short movement threshold, would give the right thumb
somewhere else to be. Only worth trying with a device in hand.

**P4 — no aim on touch is a real asymmetry.** A phone player never gets the
narrower cone or the closer camera. Nothing is broken by it, but a bot fight at
range is meaningfully harder with a thumb than with a mouse, and if that reads
as unfair the answer is probably a slightly tighter hip-fire cone on touch rather
than an aim button nobody has a thumb for.

## Still open from before

`CLAUDE/NEXT_2.md` is untouched by this iteration — in particular its P0, the
ammo economy, which is still the one item that wants a human rather than a
machine.
