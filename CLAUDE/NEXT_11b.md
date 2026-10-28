# Next, after iteration 11b (the left trigger upright, and the zoom)

Two things from playing iteration 11 on a phone, asked in chat rather than in a prompt file:

1. "need a second fire button on the top left";
2. "tap screen sometimes zoom into one area with no way of zooming out".

Both are done. Nothing is committed.

## What was done

### The left trigger upright

- **It's back, in the same top-left corner as sideways.** Iteration 11 hid it upright, on the
  argument that no finger reaches the top of a phone held that way. That was wrong for this
  player.
- **It isn't a look pad.**
  - Upright, the right trigger still is: a thumb that goes down on it and drags turns the
    camera (`TouchControls.onPointerDown`).
  - The left one only fires. If it took the look pointer, the right thumb couldn't turn the
    camera while the left one held fire, and that combination is the point of a second
    trigger.
- **The counters moved down,** from 76px to 106px below the top. The trigger's shadow ends at
  100px, and the centred row reached in over it: 7px at 390 wide, 22px at 360.
- **The pause legend,** upright: "fire · either hand, right one drags to aim".

### The zoom

**The likely cause.** This is reasoned from Safari's rules. Nobody has seen it happen on a
phone in a test.

- **Safari ignores `user-scalable=no`.** Since iOS 10, Safari zooms whatever the viewport tag
  says. What stops a double tap zooming is `touch-action`.
- **The body is `touch-action: none`,** but Safari starts touch-action over at an element that
  scrolls. The pause card and the results card both scroll (`overflow-y: auto`), so inside them
  it was `auto` again, and a double tap zoomed.
- **The results card goes up under the fire thumb at the whistle.** A thumb still tapping
  fire as the round ends taps twice on the card.
- **There was no way back,** because zooming out takes a pinch. Every surface in the game is
  `touch-action: none`, and `TouchControls` also cancels Safari's `gesturestart`.

Chrome on Android is unlikely to be the browser here. It honours `user-scalable=no`, and it
carries `none`'s zoom half through scrollers.

**The fix,** in three layers:

- **The cards** (`style.css`): `.pause__card` and `.results__card` are `touch-action: pan-y`
  on touch. They still scroll, but they can't zoom.
- **The loading card** (`index.html`): `html, body` are `touch-action: manipulation` in the
  inline style. The touch layer's rules only arrive with the stylesheet and the `is-touch`
  class.
- **A double-tap guard on iOS** (`TouchControls`):
  - a `touchend` within 350ms of the last one is `preventDefault`ed (`DOUBLE_TAP_MS`). That is
    what Safari's double-tap zoom needs;
  - it's a backstop for anything `touch-action` misses, such as the p3p2 panel's own scrolling
    lists;
  - the cost is that tap's click. Every control and the pause card work on `pointerdown`.
    Play again and the share row lose only a tap that follows another within 350ms.

**Not done: a way out once zoomed.** If the page ends up zoomed anyway, it still can't be
pinched back. Making that possible means letting a pinch through somewhere. Mid-round there's
nowhere for one: the touch layer covers the screen, and on the pause card a pinch's first
finger resumes the round. That's worth doing only if a zoom is still seen after this.

## Tests

**`touch-test`: 69/69** (61 before):

- **A new helper, `zoomableSpots`.** It samples every 16px of the screen and applies Safari's
  rule up the tree from the element under each point: `auto` all the way up to a scroller or
  the root means a double tap can zoom there.
- **Five new zoom checks.** Nothing zooms on:
  - the start prompt;
  - the screen in play;
  - the pause card;
  - the results card, sideways and upright.
- **On iteration 11's build,** the pause and results card checks fail. Every element on both
  cards is a spot that zooms.
- **The left trigger:**
  - "the left trigger is put away" is now "there is a trigger for each hand";
  - a new check holds the left trigger while a second thumb drags the look zone. Paint goes
    down (200 → 197) and the camera turns 1.62 rad.
- **The layout check, upright,** runs at all three phone sizes, not only 390×844. That's the
  check that caught the counters on the trigger.
- **Changed wording:** the legend check looks for the new upright line, and the "resumed
  sideways" check no longer says the left trigger "is back".

**`npm test`: 13 suites, 323 checks, all pass.** `net-test` ran on the GPU against Docker
`p3p2/p3p2:0.2.0`.

**Not tested:** the iOS guard. It is only installed when `isIos()` is true, and the headless
Chrome here isn't an iPhone. Nothing in the headless tests can produce Safari's double-tap
zoom either. The zoom checks above test Safari's rule as written, not Safari.

## Still open

- **Hold it on an iPhone.** Hammer fire across the whistle, double-tap the pause card, and
  double-tap Play again.
- **If the zoom was on Android,** the cause is somewhere else. Chrome there doesn't zoom with
  this viewport tag unless "Force enable zoom" is on in its accessibility settings. Android's
  own magnification, if it's turned on, zooms on a triple tap. Which phone and browser it was
  decides what to look at next.
- **Everything still open in `NEXT_11.md`.**
