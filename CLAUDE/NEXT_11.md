# Next, after iteration 11 (the game held upright)

`prompt_11.md` is done, following `PLAN_11.md`, with the defaults from its four decisions.
There are a few departures, listed below. Nothing is committed.

## What was done

### The view (`CameraRig.fitFov`)

On a screen narrower than about 0.78:1, the vertical FOV opens until the view is 50° across
(`camera.minHorizontalFov`), up to 90° tall (`camera.maxVerticalFov`). Aim and sprint scale by
the same factor in tangent space. It's fitted at init, so a page opened upright starts at its
own width, and then every frame, so a rotation eases over about a third of a second.

Measured on the live camera:

| | vertical | across |
| --- | --- | --- |
| sideways 844×390 | 62.00° (unchanged) | 104.9° |
| upright 390×844 | 90.0° | 49.6° |
| upright, aiming | 73.1° | — |
| upright, sprinting | 96.6° | — |
| desktop window 600×1000 | 75.7° | 50° |

Sprint isn't capped. At 96.6° the fountain's spire stretches a little at the top edge, but it
reads fine in a screenshot.

### The controls (`TouchControls`, `style.css`)

- **The rotate gate is gone,** with its element, its CSS and the early return in `engage()`.
- **The orientation lock follows the phone.**
  - When the controls are taken, the screen locks to the way it's held. When they're let go,
    it unlocks.
  - `enterImmersive` asks again once fullscreen resolves, because the first ask comes before
    it.
- **Turning mid-round pauses,** through `releaseLock`, which also drops every held control.
- **Upright, fire is a look pad.**
  - A thumb that goes down on fire holds the trigger and also takes the look pointer, if no
    other thumb has it.
  - It starts turning the camera after 6px of travel (`touch.fireLookSlop`). The slop counts
    toward the turn.
  - The slop is also judged on release, so a flick that lifts before any move is reported
    still turns.
- **Upright CSS:**
  - the stick takes the lower 55% of the left half;
  - look takes everything else;
  - the left trigger is hidden;
  - the counters sit in a centred row under the clock and the pause button.
- **The start hint:** "either way up · fullscreen", or "· two thumbs" on iOS.
- **The manifest:** `"orientation": "any"`.

### The cards

- **Results, upright:**
  - the card stacks: the header, then the mural with the share row, then the awards (compact,
    two to a row), then the table;
  - the table columns are 54/50/50px, with head labels that wrap;
  - the card is border-box and stays below a 72px band at the top;
  - the mural is capped at 18vh, or 14vh on screens under 720px tall.
- **Pause:** `TOUCH_KEYS` marks two lines per grip ("drag right / drag", "either hand /
  hold, drag to aim"). The stylesheet shows the one that fits.
- **Poster:**
  - on a screen narrower than 4:3 (`CROP_MIN_ASPECT`), `PosterCapture` draws the frame through
    `RenderSystem.drawAt(1600, 900, …)`. That sets pixel ratio 1, the buffer size and
    `camera.aspect`, renders and reads back in the same task, then restores through
    `applyResolution`;
  - wider screens crop as before;
  - upright, the poster is the same picture of the wall as sideways: 3.5 of 255 mean
    difference on a 32×18 thumbnail. Today's build gave a beige close-up of the board.

## Departures from the plan

- **AIM didn't move.** The plan moved it up into the arc, clear of the counters and the stick's
  half. Moving the counters to the top already cleared them. AIM sits at x 210–280 on a
  390-wide screen, right of the stick's half (0–195). On a 360-wide screen its left edge meets
  that half at 180. Buttons sit above the zones, so a press there is AIM. Worth checking in a
  hand.
- **The poster is drawn at its own size below 4:3, not below 16:9.** 16:10 and 4:3 desktop
  windows keep the crop, which `PosterCapture` documents as losing only sky and grass. They
  don't pay the reallocation at the whistle.
- **The results card took more work than "stack it".**
  - **Short screens:** with three awards and the desktop share fallback, the card ran 40px past
    an iPhone SE. That's what the second, `max-height: 720px` block is for.
  - **The pause button's spot:** at 375×667 the card reached the top-right corner, and Play
    again landed on it. The 72px band fixes that.
  - **The card's box model:** `max-height: 100%` on a content-box card lets its padding and
    border poke 24px above the space it's given. Upright the card is now border-box. **This is
    still the case sideways,** where it hasn't caused a problem.
- **One existing `touch-test` case changed.**
  - **The change:** the sideways whistle now sends the bots away and waits for the share row
    before measuring the card.
  - **Why:** reading the poster there takes real time. In that time the share row was appended,
    the card grew, and Play again moved out from under the tap position the test had saved. The
    old test was relying on timing.
- **The tall desktop window check steps the sim by hand.** In a full run, that page's own
  frames were too few for the camera to ease out within the wait. Run on its own, it eased
  within 1.5s.

## Tests

| suite | before | now | |
| --- | --- | --- | --- |
| `touch-test` | 34 | 61 | +30 upright and layout checks, −3 gate checks |
| the other 12 | 254 | 254 | unchanged |

**`npm test`: 13 suites, 315 checks, all pass.**
- `net-test` ran on the GPU against Docker `p3p2/p3p2:0.2.0`.
- After that run, one more change went in (`TouchControls` judging the slop on release). I
  rebuilt and ran `touch-test` again on the final build: 61/61.

**`touch-test`, new:**
- **Sideways:** the FOV is still exactly 62°, and no control overlaps another or the HUD.
- **Upright, in a 390×844 context:**
  - there's no gate, and a tap takes the controls;
  - the view is at least 48° across, and aim narrows it;
  - no control overlaps another, the counters or the clock;
  - the left trigger is hidden;
  - the stick walks the player, and a drag in the top half turns the camera;
  - fire spends paint;
  - dragging from fire turns the camera while it keeps firing;
  - 3px of rocking on fire doesn't turn it;
  - the pause card shows the upright legend.
- **The cards, at 390×844, 360×800 and 375×667:**
  - the pause card fits without scrolling;
  - the results card fits without scrolling, with nothing past its sides;
  - Play again clears every touch button.
- **Turning mid-round:** it pauses and drops a held stick and trigger. Resuming sideways
  brings back the left trigger and 62°, and turning back upright pauses again.
- **The poster:** the upright poster matches the sideways one, within 12 of 255 on a 32×18
  thumbnail. It measured 3.5 and 3.6 in two runs.
- **Desktop:** a 600×1000 desktop window widens its view.

**On HEAD's build:** 19 of the new checks failed. Among them, the camera saw 31° across, the
counters overlapped AIM, the results table ran 89–111px off the card, and the poster didn't
match (a beige close-up of the board).

## Load budget

Gzip -9, HEAD's build against this one:
- **entry JS:** 236,905 → 237,125 bytes (+220);
- **CSS:** 4,655 → 4,779 bytes (+124).

**Per frame:** nothing new runs except two tangents in `CameraRig`.

**Drawing cost upright,** measured before the change (SwiftShader counts, mean of four headings
at spawn):
- sideways: 249 draw calls, 576k triangles;
- upright at 90°: 164 draw calls, 513k triangles;
- the pixel count is the same either way up.

## Still open

- **Nobody has held it.** Everything below needs a real phone.
  - **Android, rotation unlocked:** tap play upright, and check that the lock holds it upright
    while you tilt the phone. Pause, turn it, and resume sideways.
  - **Android, rotation locked:** it should now just play upright. It couldn't before.
  - **iPhone in Safari, upright:** check whether the bottom toolbar or the home-indicator swipe
    gets in the way of the stick, which plants low on the left.
  - **Drag-from-fire:** whether the 6px slop and the shared look speed feel right.
- **Sideways, the results card's content-box overflow,** as above.
- **Carried over from `NEXT_10.md` and `NEXT_10b.md`:**
  - the share row when the browser can't share files (upright it now wraps and fits);
  - Play again not returning to fullscreen on a phone;
  - a ready-check for rooms;
  - the unported multiplayer tests;
  - the bot-ball and presence-timing notes in `NEXT_10b.md`.
- **Two rows in the line-up upright** (`PLAN_11.md` §2.5). With seven figures they're about
  70px tall at 390×844, which is readable. Worth doing if a full room makes them too small.

## Next

Hold it: one Android phone and one iPhone, upright and sideways, with rotation locked and
unlocked. Then fix the sideways results card's box model, and look at Play again and
fullscreen.
