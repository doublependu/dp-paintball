# Plan 3 — the game on a phone

The prompt: *"Implement control mechanism on mobile phone: horizontal only. It's
probably best to open the game page in full screen mode."*

Confirmed with the human before starting:

- **No aim button.** One thumb cannot hold aim and fire at once, and a toggle
  buys a narrower FOV at the cost of a control nobody would find. Touch play is
  hip-fire only; `state.aiming` simply never goes true.
- **Fire is a dedicated button**, held to keep firing. Nothing fires on a tap in
  the look area — repositioning a thumb must never cost paint.
- **Fullscreen is automatic** on the first tap, which is the user gesture the
  Fullscreen and Screen Orientation APIs both require.

## What the existing code decides for us

Two facts in the codebase shape everything below.

**`src/core/Input.ts` is the only place bindings live.** Every consumer asks it
for a logical `Action`, a move vector, or an accumulated mouse delta —
`PlayerController`, `CameraRig`, `WeaponSystem`, `HudSystem`, `CharactersSystem`.
So touch is a third *source* feeding those same three surfaces, and not one
gameplay system needs to know a phone exists.

**The whole session flow hangs off pointer lock.** `MatchSystem.init` pauses on
lock loss, resumes on regain, and restarts a finished round on regain;
`PauseSystem` asks for the lock back; `Game.boot` requests it on a canvas click.
A phone has no pointer lock at all. Rather than teach four systems about a second
kind of session, `requestLock`/`releaseLock` become *engage*/*disengage* on a
touch device: they flip a flag and emit the same `input:lockChanged`. Pause,
resume and play-again then work unchanged, and "the pointer is ours" and "the
player is holding the phone" stay one concept.

## The pieces

**`src/core/Device.ts`** — `isTouchDevice()`: `(pointer: coarse)` and
`maxTouchPoints > 0`, overridable with `?touch=1` / `?touch=0` so the mode is
drivable from a desktop browser and from the headless tests. A laptop with a
touchscreen reports a fine primary pointer and stays on keyboard and mouse.

**`src/core/Input.ts`** — a touch source alongside keys and mouse:

- `setTouchAction(action, down)` writes into the same held / pressed / released
  sets, so fire, jump, crouch, wave and scores need no new plumbing.
- `setTouchMove(x, y)` from the stick; `getMoveVector` prefers it when a thumb is
  on the stick and falls back to the keys when it is not.
- `addTouchLook(dxPx, dyPx)` folds a drag into the same delta buffer
  `CameraRig` drains, scaled by `touch.lookScale` — drag pixels are far coarser
  than mouse counts.
- `requestLock` / `releaseLock` engage and disengage as described above.

**`src/ui/TouchControls.ts`** — one system, built only on a touch device,
registered after the HUD. Owns:

- A floating thumbstick in the left third: it plants where the thumb lands rather
  than sitting in a fixed ring nobody's hand agrees with. Past 85% of its travel
  it also sets `sprint`, so there is no separate sprint button.
- A look zone over the rest of the screen: drag to turn.
- A thumb arc of buttons on the right — fire (hold), jump, crouch (a toggle,
  because holding a crouch and firing is two thumbs' work), wave, scores (hold)
  — and pause in the top corner.
- The tap-to-play state. While disengaged the controls are hidden and any tap
  engages, which covers both the first round and every play-again; the pause card
  sits above this layer and keeps its own tap handling.
- The portrait gate and the fullscreen request (below).

Pointer events with `pointerId` tracking throughout, so stick, look and fire work
at the same time. Buttons take a pointer capture of their own; the zones claim
whatever is left.

**Horizontal only.** A portrait gate over everything asks for the phone to be
turned, and disengages the session while it is up — the round holds rather than
running unwatched. On the first tap, `requestFullscreen` on the document element
followed by `screen.orientation.lock('landscape')`. Android Chrome honours both.
**iOS Safari on iPhone supports neither**, so there the gate plus
`viewport-fit=cover` and safe-area insets are the whole answer, and the code says
so rather than pretending the lock took.

**`visibilitychange` → hidden** disengages, which is what alt-tab already does on
a desktop by way of losing the lock.

**Fitting the screen** — `index.html` gets `viewport-fit=cover` and a
non-scalable viewport; the HUD, pause, results and loading cards get safe-area
padding and a compressed layout under the ~390px height a landscape phone has;
selection, callouts and double-tap zoom are turned off.

**Phone performance** — the pixel ratio cap and the shadow map come down on a
touch device. Measured with `tools/perf.mjs` rather than guessed at.

**Tests** — `tools/touch-test.mjs`, Chromium with `hasTouch` at 844×390 and
`?touch=1`: the stick moves the player, a drag turns the camera, the fire button
spends paint, the pause button holds the round, and a portrait viewport raises
the gate and pauses. Wired into `npm test`.

## Deliberately not doing

Gyro aiming, haptics, a separate mobile landing page, and any second control
scheme to choose between. One layout that works with two thumbs.
