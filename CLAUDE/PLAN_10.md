# Plan 10 — a round that ends where you can see it

`CLAUDE/prompt_10.md` asks to make the end of a round harder to miss:

- Start the next round only from a button, not from a click anywhere.
- If that's already the case, add a timer before the button appears.
- The problem it describes: a player who is busy shooting when the five minutes run out skips
  straight past the results to the next round.

It isn't already the case. Today any click on the park, or any tap on a phone, starts the next
round, and I reproduced the skip on both. So the plan is the button *and* a short timer before
it can be pressed. A button alone isn't enough: on a phone the card sits right over the fire
button, and on a computer a player still aiming moves the cursor across the card.

---

## 1. What happens now, reproduced

**How a round ends today:**
- `MatchSystem.end()` releases the pointer lock and emits `match:ended`, and `ResultsSystem`
  puts up the line-up and the card.
- The card is `pointer-events: none` (`.results`, `style.css:634`), so a click passes through it
  to the canvas.
- `Game.ts:133` asks for the lock on any canvas click. Getting the lock back while the round is
  over is what `MatchSystem` treats as "play again" (`MatchSystem.ts:58-62`).
- On a phone, the round's end disengages the controls. `TouchControls.setEngaged(false)` then
  shows the full-screen "tap to play again" layer (z 36) underneath the card (z 38). Any tap
  that isn't on a link starts the next round.

**The repro.** A scratch Playwright script ran against the current build (`npm run preview`,
SwiftShader). It timed how long the results card stays up:

| case | results card up for |
| --- | --- |
| clicking every 150ms through the whistle | **279ms** |
| one click 100ms after the whistle | **202ms** |
| one click 400ms after the whistle | 503ms |
| one click 1s after the whistle | 1101ms |
| trigger *held* through the whistle, let go 250ms later | stays up (no restart) |
| phone: fire button tapped through the whistle | the **first** tap restarts |

What this shows:
- **On a computer:** the first click after the lock is released starts the next round. Chrome
  doesn't refuse the lock after a release the page made itself (it only does that after Esc).
  So nothing slows the skip down: 0.2–0.3s of results for a player who is clicking.
- **Holding the trigger is safe:** the press started under the lock and the release lands
  after it, so no click reaches the canvas. It's the clicking that skips.
- **On a phone:** after the whistle, the element under the fire button is `div.touch-start`.
  The card covers y 69–387 of a 390px-tall landscape screen, including the fire button
  (740–822 × 288–370). The fire thumb's next tap is "tap to play again". The tap timing in this
  run isn't meaningful (each CDP touch takes ~3s under SwiftShader), but the mechanism is
  certain.
- **In a room** (from the code; not run here): the first page to click asks the host for the
  next round (`Net.again()`), so one friend who keeps clicking skips everybody's results.

The scripts are at
`/tmp/claude-1000/-home-rx-Repos-mine-public-dp-paintball/b7ecfc15-28d9-494b-a574-30c87420cb9c/scratchpad/repro-skip.mjs`
and `.../repro-touch.mjs`. §4 turns them into checks in the suites, which fail on today's build.

---

## 2. The change

### 2.1 A Play again button, the only way to the next round

- **The button:** "click/tap to play again" becomes a real `<button data-results-again>` reading
  **Play again**. It's styled like the pause card's **Back to it** (`.pause__resume`): cyan
  pill, ink border, drop shadow. It's the card's one primary action.
- **Its handler** calls `ctx.input.requestLock()`, wired by `ResultsSystem` the same way
  `PauseSystem` wires its resume button. The click is the user gesture the pointer lock needs.
- **`MatchSystem` keeps its rule:** "the lock comes back while the round is over" still means
  play again, and in a room `net.again()`. So the round still only runs while the player has
  the controls, and there's no state where the round has started but the pointer is free.
  Only two of its comments change: the ones that say a click re-locks.

**Shutting the other two ways in:**
- **Computer: the card catches clicks.** `.results.is-visible` becomes a full-screen layer
  (`inset: 0`, card aligned to the bottom, `pointer-events: auto`), so a click never reaches the
  canvas while the results are up.
  - Between rounds it's still `visibility: hidden`, as now, so it can't catch shots during play.
  - A held trigger released over it can't reach the canvas either: the click goes to the
    nearest common ancestor, and the canvas listener doesn't see that.
  - The CSS exception that made only the fork badge clickable is no longer needed, so it goes,
    along with the comments that explain it.
  - The line-up's framing reads the card's own height (`heightFraction`), so it doesn't change.
- **Phone: the start layer stays down after a round.** In `TouchControls.setEngaged` and
  `applyOrientation`, the start layer shows only if the round isn't over
  (`match.phase !== 'ended'`). The "tap to play again" wording goes. Before the first round the
  start layer is unchanged ("tap to play", fullscreen, the install offer).
  - With that layer gone, a tap on the fire button lands on the card and does nothing.
  - The z-order comment in the touch section of `style.css` is updated to match.

### 2.2 The button arms after 2 seconds

- **What the player sees:** the button appears with the card, disabled, and a fill sweeps
  across it for **2s**. Then it becomes pressable. That's the prompt's "timer before the new
  game button appears", in a form that shows what's coming and when.
- **Timing:** it's wall-clock time, not simulated time. It's about human reaction, and the
  simulation has stopped by then anyway.
  - The constant is `match.againArmSeconds = 2` in `Config.ts`.
  - It starts in `ResultsPanel.show()` and is cleared in `hide()`.
  - The fill is a CSS transition of the same length. With `prefers-reduced-motion` it doesn't
    animate, and the button still arms on time.
- **Why 2s:** the reflex clicks in the repro land 0.1–0.4s after the whistle, and a click streak
  stops once clicks stop doing anything. 2s is long enough to break the streak and to take in
  the title and the line-up, and short enough not to feel like a wait.
- **It also covers a refused lock.** A browser only refuses the lock within about 1s of the
  player pressing Esc. A button that can't be pressed for 2s never runs into that, so this
  needs no retry like `PauseSystem`'s. If a lock were refused anyway, the card simply stays up
  and the button can be pressed again.
- **No keyboard shortcut.** The button isn't focused on show: a focused button is pressed by
  Space, which is jump. It can still be reached with the mouse and taps, and is a normal
  focusable button for accessibility.

### 2.3 Where it sits

- **Computer: in the card's footer,** centred, where "click to play again" is now. The cursor
  comes back where the lock was taken, usually mid-screen, which is over the awards and the
  mural. The button is ~300px below that.
- **Phone: in the card's header,** centred between "Time!" and the fork badge, which leaves it
  clear of both fire buttons:
  - top-left fire: 18–100 × 14–96;
  - right-hand fire, aim and jump: x ≥ 664, bottom right.

  The footer doesn't work on a phone. The landscape card already ends 3px from the bottom of
  the screen (69–387 of 390), and a 30px button there would push it off. The header row is
  already as tall as the fork badge, so the button costs no height there.

### 2.4 In a room

- **Anybody's press still starts the next round for everybody,** as the reference built it.
  `Net` doesn't change.
- **Every page arms its own button 2s after its own `match:ended`.** The end reaches every page
  through the log at nearly the same moment, so nobody's results can be cut short by less than
  about 2s.
- **The button says what it does:** in a room it reads **Next round, for everyone**. The label
  follows `PauseSystem`'s `shared()` pattern (set from `main.ts`).

---

## 3. Files

| file | change |
| --- | --- |
| `src/core/Config.ts` | `match.againArmSeconds = 2` |
| `src/ui/ResultsPanel.ts` | the button, `setAgainHandler`, arming in `show`/`hide`, the room label |
| `src/ui/ResultsSystem.ts` | wires the button to `input.requestLock()`; `shared` hook like `PauseSystem` |
| `src/ui/TouchControls.ts` | start layer stays down while `phase === 'ended'`; "tap to play again" removed |
| `src/gameplay/MatchSystem.ts` | comments only (the button, not a click, re-locks) |
| `src/main.ts` | sets `results.shared` next to `pause.shared` |
| `src/style.css` | `.results` full-screen while visible; button + arming fill; touch header placement; layer comments |

Load cost: a few hundred bytes of JS and CSS. Nothing changes during play, so frame time is
unaffected.

---

## 4. Tests

**`match-test`** (park, manual sim):
- *new:* clicking the park every 150ms through the whistle leaves the round over, the card up
  and the pointer free 1s later. This is the repro's case 2.
- *new:* one click on the park 100ms, 400ms and 2.5s after the whistle starts nothing.
- *new:* the trigger held through the whistle and released after it starts nothing.
- *new:* Play again is disabled when the card appears, and a click on it at 0.5s does nothing.
  After 2s it's enabled.
- *changed:* the two places that click the park to start the next round
  (`match-test.mjs:543`, `:609`) wait for the button to arm and click it. The checks after them
  (fresh round, refilled, rescored, crates, figures back in the park, spawn positions) are
  unchanged.

**`touch-test`** (landscape 844×390):
- After the whistle the start layer isn't visible, and three taps on the fire button's spot
  leave the round over.
- The Play again button's rect overlaps no touch button's rect, and the card fits on the
  screen.
- After arming, a tap on the button starts the round and the controls go live again.

**`net-test`:**
- *changed:* "the round ends for everybody" now has Grace press the button (`play()` learns to
  press it when the results are up) rather than click the canvas.
- *new, in the same case:* a canvas click on a guest's page after the whistle starts nothing.

**`ui-test`:** unchanged. The pause card and the loader aren't touched.

The whole of `npm test` runs on an idle machine, as `NEXT_8.md` advises. `net-test` runs with
the GPU flags `NEXT_9.md` describes.

---

## 5. Order of work

1. Turn the repro into the new `match-test` checks and see them fail on today's build.
2. §2.1: the button, the card catching clicks, and the start layer staying down. Then the
   `match-test` and `touch-test` changes.
3. §2.2: the arming and the fill.
4. §2.3: the phone's header placement, with screenshots at 844×390, 740×360 and 667×375 (the
   sizes `NEXT_9.md` measured).
5. §2.4: the room label, and the `net-test` change.
6. `npm run build`, then `npm test`. Then `NEXT_10.md`.

---

## Decisions for you

These are the defaults I'll go with unless you say otherwise:

1. **Button visible at once, armed after 2s.** The alternative is the prompt's literal reading:
   no button for 2s, then it appears. I prefer showing it, because the player can see the
   way out and how long until it works. Either way it's one constant if 2s is wrong.
2. **In a room, anybody's press still starts the round for everyone.** A ready-check (everyone,
   or a majority, presses before the round starts) is the stronger fix for a trigger-happy
   friend, but it's a feature of its own. That's a follow-up if wanted.
3. **No extra end-of-round cue.** For example, a large "TIME!" stamp across the line-up during
   the 2s, or a spoken countdown over the last 10 seconds. The whistle, the HUD clearing and
   the line-up already say the round is over. The problem was that they were gone after 0.2s.
   Say if you want one anyway.

## Not in this plan

- **On the phone, Play again doesn't go back to fullscreen** if the player left it while the
  results were up. It calls `requestLock()` like the pause card's Back to it, which doesn't
  either. If that matters, both should go through `TouchControls.engage()`.
- **A side finding: the phone card's share row breaks** when the browser can't share files.
  The screenshot at 844×390 shows Save PNG, Post to X and Copy image as tall ovals, with the
  "save the PNG and attach it" note spilling over the score table. Android Chrome and iOS
  Safari share files, so they get the other branch and look fine. Firefox for Android likely
  doesn't, and would show this. It's unrelated to the prompt. I'd fix it next.
