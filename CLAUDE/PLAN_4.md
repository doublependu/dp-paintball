# Plan 4 — what the playtest asked for

`CLAUDE/FEEDBACK_3.md`, from playing iteration 3 on an actual iPhone. Six items;
only the fifth is iOS-specific, the rest are the touch scheme generally.

## 1–4: the controls, as a hand actually holds them

The four button items are one change. The layout shipped with a single big
trigger under the right thumb — and that thumb is also the one that turns the
camera, so it could aim *or* shoot, never both. Hence:

- **A second fire button, top-left.** Not a duplicate for convenience: it is the
  point. The index finger of the hand gripping the phone already rests there, so
  the left hand can hold the trigger while the right thumb keeps dragging. Both
  buttons drive the same `fire` action, reference-counted, so releasing one
  while the other is held does not stop the marker.
- **Crouch, wave and scores removed.** Three buttons in the way of a game that
  needs a few. The scoreboard is no loss — the pause card carries the same
  numbers — and the other two are keyboard luxuries.
- **Jump removed, then put back.** It went with the other three, on the same
  argument. It came back because the argument does not survive the park: there
  is a great deal of it between the 0.45m the character controller steps up
  unaided and the 1.15m a jump clears — benches, low walls, the lip of the
  fountain basin — and without a jump a bench is a wall. It sits above the right
  trigger, a thumb's roll from it. See `NEXT_4.md` for the auto-hop that was
  briefly tried in its place and dropped.
- **Aim, as a toggle.** Reversing the call made before iteration 3, which was
  made on the theory that a thumb cannot hold aim and fire together. That was
  true and is now beside the point: with a trigger under the other hand, aim
  only has to be *set*, not held.
- **Both triggers smaller and identical.** 96px was sized for being the only
  button on screen; 76px is right for one of a pair.

## 5: iOS has no fullscreen, so it gets an app instead

Safari on an iPhone has no Fullscreen API at all — the toolbars stay, they eat a
third of a landscape screen, and they sit exactly where the triggers want to be.
The only way to be rid of them is a page added to the home screen, which iOS
runs without browser chrome.

So the start card carries an install offer:

- Where the browser has its own flow (Chrome and friends, via
  `beforeinstallprompt`) it is **one tap** — captured at module scope in
  `src/core/Install.ts`, because the event fires long before the park has
  finished loading.
- On iOS, which has no such flow, the steps are spelled out with the actual
  Share glyph rather than a description of it.

Supporting cast: `public/manifest.webmanifest` (fullscreen, landscape), an
`apple-touch-icon` — iOS ignores SVG icons and falls back to a screenshot of
whatever was on screen without one — generated from `public/icon.svg` by
`tools/make-icon.mjs`. Shown once, before the first round, and never again on
the play-again card.

## 6: the blue wash

Two thumbs sliding around a page look, to a browser, exactly like somebody
trying to select something, and iOS answers with a selection highlight, a
magnifier, or a callout — none of which a game can dismiss. Fixed from both
ends: `user-select`, `-webkit-touch-callout` and `-webkit-tap-highlight-color`
off across the whole document on touch, and `selectstart`, `dragstart` and
Safari's non-standard `gesturestart` cancelled at the document.

## Tests

`tools/touch-test.mjs` grew the cases the change is actually about: that the
left trigger fires, that releasing one trigger leaves the other firing, that aim
latches on and off, and that the four removed buttons are gone.
