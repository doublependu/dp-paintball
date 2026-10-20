# Next, after iteration 10 (a round that ends where you can see it)

`prompt_10.md` is done, following `PLAN_10.md`, with the departures listed
below. Nothing is committed.

## What was done

### The skip, reproduced first

Against the iteration 9 build, a player clicking through the whistle saw the
results card for **0.2–0.3s**. The first click after the pointer was released
started the next round. On a phone, the fire thumb's first tap after the
whistle did the same. `PLAN_10.md` §1 has the measurements. The new
`match-test` checks below failed on that build before any code changed.

### Play again, the only way to the next round

- **The button.** The card's "click/tap to play again" line is now a
  **Play again** button, styled like the pause card's Back to it. Pressing it
  asks for the controls back (`input.requestLock()`). Getting them back after a
  round is what `MatchSystem` already read as "play again", so `MatchSystem`
  and `Net` are unchanged apart from comments.
- **Computer.** The results layer covers the whole screen while the card is up
  and catches every click, so no click reaches the canvas. Between rounds it is
  `visibility: hidden`, as before.
- **Phone.** The full-screen "tap to play" layer no longer comes up after a
  round (`TouchControls.refreshStart`). It still does before the first round.
  It also comes back if a round starts while the player is on the card, which
  in a room happens when a friend presses the button.
- **In a room.** The button reads **Next round, for everyone**. Anybody's press
  still starts it for everybody.

### It arms after 2 seconds

- The button appears with the card, pale and disabled, and fills with cyan from
  the left. It can be pressed once full. The constant is
  `match.againArmSeconds = 2`.
- The button is not focused when it arms, so Space (jump) can't press it.

**Departure from the plan: the arming counts frame time, not a timer.**
`ResultsSystem.update(dt)` adds up dt and sets the button's `--arm` every
frame, and the fill follows `--arm` directly rather than running as a CSS
transition.
- **Why:** under SwiftShader a test interaction takes seconds, so a wall-clock
  timer would have armed before the suite could check "not yet". With frame
  time, `stepSim` drives the arming, and the checks are exact.
- **In play it's the same 2s.** Frame dt is wall time, clamped at
  `MAX_FRAME_DT` (0.25s). So the wait only stretches below 4 frames a second,
  and it pauses while the tab is hidden, since there are no frames then.

### Where it sits

- **Computer:** in a footer under the card, centred, well below where the
  cursor comes back.
- **Phone:** in the header between "Time!" and the fork badge. This is clear
  of both fire buttons at every size checked, and adds no height.

**Departure from the plan: two layout fixes the screenshots called for.** The
card is now the only way back, so it has to fit.
- **667×375:** the card stood 694px tall and Play again was 316px above the top
  of the screen. Below 720px wide the mural stacks above the scores. On touch it
  now stays beside them at any width, since a phone only plays in landscape.
- **Every size:** `.results__card` now has `max-height: 100%` and scrolls inside
  itself, so its top can't leave the screen.

| viewport | card (y) | Play again (x × y) | fire buttons |
| --- | --- | --- | --- |
| 1280×720 | 269–708 | 490–790 × 650–691 | — |
| 1024×576 | 125–564 | 362–662 × 506–547 | — |
| 844×390 | 92–390 | 285–408 × 105–141 | 18–100 × 14–96 and 740–822 × 288–370 |
| 740×360 | 52–350 | 233–356 × 65–101 | right one at x ≥ 636 |
| 667×375 | 74–372 | 197–319 × 87–123 | right one at x ≥ 563 |
| 640×360 | 28–357 | 183–306 × 41–77 | right one at x ≥ 536 |

The card's y values were read 1.2s after the whistle, possibly before its
slide-in had finished. That would explain the 844×390 card ending at 390, while
the screenshot shows it ending at about 377.

At 1024×576 the button costs the line-up about 25px. Its padding was trimmed
from the first version for that reason.

## Tests

| suite | before | now | |
| --- | --- | --- | --- |
| `match-test` | 45 | 51 | +6, below |
| `touch-test` | 27 | 34 | +7, below |
| `screen-test` | 22 | 22 | starts its next round with Play again |
| `net-test` | 8 | 8 | the rounds case gained assertions |
| the other 9 | 172 | 172 | unchanged |

**`npm test`: 13 suites, 287 checks, all pass**, in one run of the whole chain
on the final build (17m48s; `net-test` against Docker `p3p2/p3p2:0.1.1` on the
GPU).

**`match-test`, new:**
- the card has a Play again button, not yet armed;
- it does nothing when pressed before it arms;
- clicking the park every 150ms through the whistle doesn't skip the results;
- it arms at 2s (disabled at 1.8s, armed at 2.15s);
- a click on the park after it arms still starts nothing;
- a trigger held through the whistle and let go after it starts nothing.

The two places that clicked the park to start a round now press Play again.

**`touch-test`, new:**
- the whistle puts the card up and leaves the start prompt down;
- three fire taps after the whistle start nothing;
- Play again clears every touch button;
- the card fits 844×390;
- Play again does nothing before it arms;
- once armed it starts the round and hands the controls back;
- a round started from elsewhere brings the start prompt back.

**`net-test`, rounds case:**
- Grace's four clicks on the park after the whistle start nothing on either
  page;
- her button reads "Next round, for everyone";
- `play()` now presses Play again when the results are up.

**`screen-test`:** "a new round wipes the front of the mural" clicked the park
to start the round. I missed it when I searched the tools for restart paths, and
the first full run caught it. It now steps 2.1s for the button to arm, then
presses it. The stepping happens *before* the check takes its paint counts,
because stepping lets the last balls in the air land, and the next check
compares those counts.

**Flake:** `match-test` failed one check in one of four runs. The failure was
among the checks before the round ends, and I didn't capture which one. The
other three runs and the full chain passed it. It fits the crate check's 1-in-12
flake in `NEXT_8.md`.

## Load budget

Gzip -9, HEAD's build against this one:
- entry JS: 236,705 → 236,973 bytes (+268);
- CSS: 4,515 → 4,655 (+140).

That's about **+0.4 KB** on first load. Nothing changes during play.

## Still open

- **The phone's share row breaks** when the browser can't share files, as
  `PLAN_10.md` noted. Save PNG, Post to X and Copy image become tall ovals, and
  the "save the PNG and attach it" note spills over the score table. It shows in
  the emulated phone at 844 and 667 wide (`.is-touch .results__share` is
  `nowrap`, and the note is `flex-basis: 100%`). Android Chrome and iOS Safari
  share files and get the other branch. Firefox for Android likely doesn't. The
  card is now the whole interface between rounds, so this is more visible than
  it was. It's the first thing I'd fix next.
- **Play again on a phone doesn't go back to fullscreen** if the player left it
  during the results. The pause card's Back to it doesn't either. Both would
  need to go through `TouchControls.engage()`.
- **A ready-check for rooms**, where everyone presses before the round starts,
  is still a follow-up if wanted.
- **The held-trigger result is from headless Chrome.** A press that starts
  under the pointer lock and ends after it produced no click on the canvas.
  The card now catches that release anyway, so a different browser can't turn
  it into a restart.
- **Nobody has played it by hand.** Worth one round on a computer and one on a
  phone: does 2s feel right, and does the fill read as "wait"?
- **Carried over from `NEXT_9.md`:**
  - the six multiplayer tests not ported;
  - a room never played by hand;
  - iOS generally;
  - `NEXT_2.md` P2 and `NEXT_3.md` P1.

## Next

Fix the phone share row. Then play a round to the whistle on a computer and on
a phone, and a room with two browsers, before choosing from `GAMEPLAY_8.md`.
