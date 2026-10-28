# Plan 11 — the game held upright

`CLAUDE/prompt_11.md`:

> Make the game work on the vertical screen of a mobile phone

Today a phone only plays sideways. `PLAN_3.md` chose that ("portrait gets a gate rather than a
layout"), and this plan undoes it. Landscape stays as it is. Portrait gets its own camera,
control layout and cards.

---

## 1. What happens now, measured

**How I measured it:** HEAD's build (`8945b5b`) in headless Chrome with `?touch=1`,
`hasTouch`, DPR 2, at 390×844 (an iPhone 14 held upright). I took screenshots with the gate in
place, then hid the gate with CSS and took the controls with `input.requestLock()` to see what
is behind it. The script is
`/tmp/claude-1000/-home-rx-Repos-mine-public-dp-paintball/05519bf2-ee40-4636-a969-771eaf47444f/scratchpad/portrait-probe.mjs`.

1. **The gate is all you get.** "Turn your phone sideways" covers everything, and
   `TouchControls.engage()` returns early in portrait.
   - **A phone with rotation locked can't play at all (from the code, not observed).** Turning
     it doesn't rotate the page, so the gate never clears. Android only locks to landscape
     *after* the first tap, and the gate blocks that tap. Many people keep rotation locked.
2. **The camera sees a slit.** `camera.fov` is a *vertical* 62°. At 390×844 that leaves 31° across,
   against 105° on the same phone held sideways. The player's figure fills half the width. At
   90° vertical the same view shows 50° across, with the fountain and the trees around it.

   | screen | aspect | today, vertical / across | planned (§2.1) |
   | --- | --- | --- | --- |
   | desktop 1920×1080 | 1.78 | 62° / 94° | unchanged |
   | phone sideways 844×390 | 2.16 | 62° / 105° | unchanged |
   | iPhone 14 upright 390×844 | 0.46 | 62° / **31°** | 90° / 50° |
   | Android entry-level 360×800 | 0.45 | 62° / **30°** | 90° / 48.5° |
   | iPhone SE upright 375×667 | 0.56 | 62° / **37°** | 79° / 50° |
   | iPad upright 820×1180 | 0.69 | 62° / 45° | 68° / 50° |

3. **The controls are laid out for a sideways grip.** The right-hand cluster happens to land
   under the right thumb, because it's placed from the right and bottom. The rest doesn't fit:
   - **The left trigger sits in the top-left corner (18,14).** In landscape the index finger
     rests there. Held upright, no finger reaches it.
   - **The HUD counters overlap AIM.** The counters span 16–242 × 789–830 and AIM spans
     210–280 × 748–818. The counters also sit where the left thumb plants the stick.
   - **The stick zone runs the full height of the left 42%.** The look zone is the right 58%.
4. **The results card fits (513–834 of 844), but its table doesn't.** The forced side-by-side
   layout (`.is-touch .results__main { flex-direction: row }`, "a phone only plays in landscape")
   squeezes the scores, and the fourth column, *splats worn*, falls off the card's right edge.
   The mural is a 26%-wide thumbnail.
5. **The pause card fits (202–641, no scroll),** but its legend says "drag right · look" and
   "fire · either hand". After §2.2 neither is true upright.
6. **The end-of-round poster is a flat beige rectangle.**
   - **Why:** `PosterCapture.copyOut` cuts a 16:9 strip from the middle of the frame. From a
     portrait frame, at the poster's 52° vertical FOV, that strip covers about 14° vertically,
     and the board alone fills it.
   - **It's also soft:** the strip is 585×329 buffer pixels, blown up 2.7× to 1600×900.
7. **Drawing cost isn't the problem.** Mean over four headings at spawn (SwiftShader, so these
   are counts, not milliseconds):

   | | draw calls | triangles |
   | --- | --- | --- |
   | sideways, 844×390 | 249 | 576k |
   | upright, 62° (today) | 201 | 570k |
   | upright, 90° (planned) | 164 | 513k |

   The pixel count is the same either way up.

---

## 2. The change

### 2.1 A field of view that holds its width

**The rule.** Keep the vertical 62° unless that leaves less than **50° across**. Below that,
widen the vertical angle until 50° fits, up to a ceiling of **90°**.
- **Aim (48°) and sprint (68°) scale with it.** All three are multiplied by the same factor, in
  tangent space, so aiming still zooms by the same ratio and sprinting still widens by the same
  ratio.
- **Upright, sprint briefly reaches about 97°.** I'll check it in a screenshot, and cap it if it
  looks stretched.

**Where it applies.** Only to screens narrower than about 0.78:1, so every landscape screen
and every desktop window of normal shape is untouched. It lives in `CameraRig`, which already
owns the FOV and damps it each frame:
- the target becomes `fitFov(target, camera.aspect)`;
- after a rotation, the view eases to its new width over about a third of a second.

A desktop window dragged tall gets the same fix, since the rule depends on the screen's shape,
not on touch.

**Config:** `camera.minHorizontalFov: 50` and `camera.maxVerticalFov: 90`.

**Kept as is:**
- the arm length, shoulder offset and height;
- the crosshair, which stays at the centre of the screen. `AimSolver` casts along the camera's
  forward axis, so the crosshair has to stay where that axis meets the screen.

### 2.2 Controls for two thumbs at the bottom

Held upright, both hands cradle the lower half of the phone. That leaves two thumbs and no
spare finger. Everything here is CSS under `@media (orientation: portrait)`, plus one behaviour
in `TouchControls`.

- **The stick:** the left half of the screen's lower 55%. It still plants where the thumb
  lands.
- **Look:** everywhere else, including the upper left. Either thumb can reach up and turn.
- **The right cluster stays bottom right.**
  - Fire is under the thumb, and jump is above it, as today.
  - Aim moves up into the arc between them. Today it sits just right of centre, against the
    stick's half and on top of the counters.
- **The left trigger is hidden.**
  - **The new behaviour, upright only:** fire turns into a look pad. A thumb that goes down on
    fire holds the trigger. Once it has moved past a 6px slop (`touch.fireLookSlop`), dragging
    it also turns the camera. It stops at the slop so that a thumb rocking on the button doesn't
    nudge the aim.
  - This gives one thumb both firing and looking, which is what the left trigger is for in
    landscape. Mobile shooters do the same.
  - If another pointer already holds the look, fire only fires.
  - See Decision 1.
- **Pause stays top right.**
- **The HUD:**
  - the counters move to a centred row under the clock, compacted;
  - the clock, toast and crate marker stay where they are;
  - the build tag stays in the gutter under fire, which still exists upright.

### 2.3 Turning the phone

- **The gate goes.** Its element, its CSS and the early return in `engage()` are all removed.
  Either way up starts a round.
- **The orientation lock follows the player.** Android only grants it in fullscreen.
  - Today `enterImmersive` locks to `'landscape'`. Tapping play while holding the phone upright
    would swing the screen sideways.
  - **Planned:** when the controls are taken (`setEngaged(true)`, which also covers resume from
    the pause card), lock to the current orientation. Unlock when they're let go. Between
    rounds and while paused, the phone can be turned freely, and it stays put during play.
- **Turning mid-round pauses,** wherever the lock didn't take: iOS, or Android outside
  fullscreen.
  - The layout changes under the thumbs, and a phone being turned isn't being played.
  - It's the same release the gate does today, so held controls are dropped and the pause card
    comes up in the new orientation.
  - See Decision 2.
- **The manifest:** `"orientation": "landscape"` → `"any"`. An installed copy on Android
  otherwise forces sideways at launch.
- **The start hint's copy:**
  - Android: `landscape · fullscreen` becomes `either way up · fullscreen`;
  - iOS: `either way up · two thumbs`.

### 2.4 The cards, upright

- **Results.** Upright, the card stacks:
  - the header: the title, Play again and the badge;
  - the mural at the card's width, its height capped at 22% of the screen, with the share row
    under it;
  - the awards;
  - the table, with narrower columns and head labels that may wrap.

  It must fit, all four columns on the card, on 390×844, 360×800 and 375×667. The line-up
  above it is framed by `ResultsStage.setPanelShare`, which already measures the card, so it
  should follow without changes. I'll confirm that in a screenshot.
- **Pause.** The legend gets an upright version: `drag · look` and `fire · hold, drag to aim`,
  with no left hand. Both versions are rendered, and the same orientation media query shows
  one. The card already fits.
- **The poster.** When the canvas is narrower than 16:9, the capture frame is drawn at the
  poster's own size.
  - **How:** `RenderSystem.drawAt(1600, 900, draw)` sets pixel ratio 1, the buffer size and
    `camera.aspect = 16/9`. It draws, and `PosterCapture` reads the frame back in the same
    task, as it does now. Then it restores everything through the existing resize path.
  - **The cost** is two render-target reallocations at the whistle, upright only. Landscape
    keeps its crop.
  - **No blank frame.** The capture runs from `match:ended`, inside the sim step, so the
    normal render that follows in the same rAF draws at the restored size.
  - See Decision 4.

### 2.5 Considered and left out

- **Shifting the view so the horizon sits higher, above the thumbs.** The crosshair would leave
  the centre of the screen, and every aim path assumes it's there.
- **Two rows in the line-up, upright.** Seven figures across 390px are about 65px tall: small,
  but readable. It's worth doing if a full room makes them too small.
- **Drag-from-fire in landscape too.** It's one condition to widen, but the landscape layout
  was playtested by hand and already has a trigger for this.
- **Tilt (gyro) aiming.** Same reason `PLAN_3.md` gave.

---

## 3. Files

| file | change |
| --- | --- |
| `src/gameplay/CameraRig.ts` | `fitFov`: the FOV target fitted to the aspect (§2.1). |
| `src/core/Config.ts` | `camera.minHorizontalFov`, `camera.maxVerticalFov`, `touch.fireLookSlop`. |
| `src/ui/TouchControls.ts` | The gate is removed. The lock follows the orientation and is released when the controls are let go. A rotation mid-round pauses. Fire becomes a look pad upright. New start hint. The class comment loses "landscape". |
| `src/style.css` | Portrait rules: zones, aim, the left trigger hidden, HUD counters, the stacked results card, the pause legend. The gate's CSS goes. The section comments and the layer list are updated. |
| `src/ui/PauseOverlay.ts` | The upright legend next to the sideways one. |
| `src/render/Renderer.ts` | `drawAt(width, height, draw)`. The size code in `observeResize` becomes a method it can restore through. |
| `src/ui/PosterCapture.ts` | Draws through `drawAt` when the canvas is narrower than 16:9. Otherwise it crops as today. |
| `public/manifest.webmanifest` | `"orientation": "any"`. |
| `tools/touch-test.mjs` | The three gate checks are replaced by an upright section (§4). |

---

## 4. Tests

In `touch-test`, the three gate checks ("portrait raises the rotate gate", "holds the round",
"turning back clears the gate") go. In their place is a section in a 390×844 context, with
checks that fail on today's build:

- **Starting upright:** there's no gate, and a tap takes the controls.
- **The view:** upright, the camera sees at least 48° across. Sideways, its FOV is still exactly
  62°. Aim upright still narrows the view.
- **The stick:** a stick in the lower left walks the player, and a drag in the upper half turns
  the camera.
- **Fire:**
  - holding fire spends paint;
  - dragging from fire turns the camera while the ammo keeps falling;
  - resting on fire with 3px of wobble doesn't turn it.
- **The left trigger:** it's hidden upright and back sideways.
- **The layout:**
  - no touch button overlaps another button, the counters or the clock;
  - each one is wholly on screen.

  This fails today on AIM against the counters, and I'll run it sideways too.
- **The cards:**
  - the pause card fits without scrolling;
  - the results card fits, with no horizontal overflow in the table or the share row;
  - Play again clears every touch button.

  Each at 390×844, 360×800 and 375×667.
- **Turning mid-round:** it pauses, and drops a held stick and trigger. A tap resumes in the
  new orientation.
- **The poster:** the upright poster is a picture of the park, not a crop of the board.
  - **How it's compared:** a 32×18 thumbnail of the upright poster against a sideways one from
    the same round, with the bots sent to the far corner first, as `ui-test` does. The mean
    difference must stay under a threshold set from the two.
  - Today's beige rectangle fails it by a wide margin.

The desktop page at the end of `touch-test` gets one more check: a 600×1000 window widens its
view too.

The other twelve suites shouldn't move. None of them resizes to portrait. The whole of
`npm test` runs on an idle machine, with `net-test` on the GPU, as before.

**Load budget:** I'll compare entry JS and CSS gzip -9 against HEAD in `NEXT_11.md`. I expect a
few hundred bytes of CSS, partly offset by the gate going. Nothing new runs per frame except
two tangents in `CameraRig`.

---

## 5. Order of work

1. Write the upright section of `touch-test`, and see it fail on today's build.
2. Fit the FOV in `CameraRig`, and check the table in §1 against the live camera.
3. Remove the gate. Make the lock follow the orientation, and make a rotation pause.
4. Add the portrait CSS for the controls and HUD, then fire as a look pad.
5. Restyle the results and pause cards upright.
6. Draw the poster at its own size upright.
7. `npm run build`, then `npm test`. Take screenshots upright and sideways of play, pause,
   results and the poster. Then write `NEXT_11.md`.
8. **By hand, which nothing headless replaces:**
   - **On an Android phone:** play upright and sideways, with system rotation both locked and
     unlocked.
   - **On an iPhone in Safari:** play upright. Check whether the bottom toolbar or the
     home-indicator swipe gets in the way of the stick.
   - **On both:** the feel of drag-from-fire.

---

## Decisions for you

These are the defaults I'll go with unless you say otherwise:

1. **Upright, the left trigger is replaced by dragging from fire, in portrait only.**
   - The other option is to have fire drag in both orientations. That's more consistent when
     the phone is turned between rounds, but it changes the playtested landscape scheme.
   - Keeping a left trigger upright, mid-left, would mean letting go of the stick to use it.
2. **Turning the phone mid-round pauses.** The alternative keeps the round running through the
   turn and only drops the held controls.
3. **50° across and a 90° vertical ceiling, for any tall screen.** That includes a desktop
   window dragged tall, not just touch. Both numbers are in `Config.ts`.
4. **The upright poster is drawn at 1600×900, at a one-off cost at the whistle.** The other
   option is to crop with a wider lens: no hitch, but a 585×329 picture blown up 2.7×.

## Not in this plan

- **Carried from `NEXT_10.md`:** the phone's share row when the browser can't share files, and
  Play again not returning to fullscreen. Upright, the share row gets more room. The fit check
  in §4 will show whether that's enough.
- **A tablet-specific layout.** An iPad upright gets the phone's upright layout at its own size.
- **Two rows in the results line-up** (§2.5).
