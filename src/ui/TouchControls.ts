import { touch as touchConfig } from '../core/Config';
import { isIos, isTouchDevice } from '../core/Device';
import { installOffer, onInstallOfferChange, promptInstall } from '../core/Install';
import type { Action } from '../core/Input';
import type { GameContext, System } from '../core/System';
import type { MatchState } from '../gameplay/MatchState';

/** One button on the touch layer. */
interface ButtonSpec {
  action: Action;
  label: string;
  /** `hold` is down while touched; `toggle` flips and stays. */
  mode: 'hold' | 'toggle';
  /** Its own name, and the modifier suffix for its class. Unique per button. */
  key: string;
}

/**
 * The buttons, as playtesting on a phone left them.
 *
 * **Two fire buttons, one per hand.** The right thumb is the one that turns the
 * camera, and a thumb that is dragging cannot also be holding a trigger — so
 * the whole reason to fire from the left is that it leaves the right free to
 * aim while shooting. The left one sits in the top corner, where the index
 * finger of the hand holding the phone already rests; the right one is under
 * the thumb. Same size, and smaller than the single button they replace, since
 * neither is now the only trigger on screen.
 *
 * **Aim is a toggle.** Held, it would cost a thumb the layout does not have.
 *
 * **Jump stays.** It was cut once, on the argument that four extra buttons were
 * in the way of a game that needs two — but the park is full of things between
 * the 0.45m the controller steps up on its own and the 1.15m a jump clears, and
 * without it a bench is a wall. It sits above the right trigger, a thumb's roll
 * away from it.
 *
 * Crouch, wave and the scoreboard are gone and stay gone. The scoreboard is no
 * loss — the pause card carries the same numbers — and the other two are
 * keyboard luxuries.
 */
const BUTTONS: readonly ButtonSpec[] = [
  { action: 'fire', label: 'fire', mode: 'hold', key: 'fire' },
  { action: 'fire', label: 'fire', mode: 'hold', key: 'fire-left' },
  { action: 'jump', label: 'jump', mode: 'hold', key: 'jump' },
  { action: 'aim', label: 'aim', mode: 'toggle', key: 'aim' },
];

/**
 * What the start card promises.
 *
 * Not fullscreen on an iPhone, because Safari will not give it — saying so
 * there would be a promise the browser breaks a second later. The install
 * offer below the card is what covers that case.
 */
const START_HINT = isIos()
  ? 'landscape &nbsp;·&nbsp; two thumbs'
  : 'landscape &nbsp;·&nbsp; fullscreen';

/**
 * iOS's Share mark, inline so the instruction can point at the actual button
 * rather than describe it. A box with an arrow leaving the top.
 */
const SHARE_GLYPH =
  `<svg class="touch-install__glyph" viewBox="0 0 24 24" aria-label="Share" role="img">` +
  `<path d="M12 3.2 8.4 6.8l1.1 1.1 1.7-1.7v8.3h1.6V6.2l1.7 1.7 1.1-1.1L12 3.2Z"/>` +
  `<path d="M6 10.4h2.2V12H7.6v7.2h8.8V12h-.6v-1.6H18a.8.8 0 0 1 .8.8v9.2a.8.8 0 0 1-.8.8H6a.8.8 0 0 1-.8-.8v-9.2a.8.8 0 0 1 .8-.8Z"/>` +
  `</svg>`;

/**
 * The phone build: two thumbs, landscape, fullscreen.
 *
 * Everything here writes into `Input` and nothing else — the stick becomes a
 * move vector, a drag becomes look delta, the buttons become the same logical
 * actions the keyboard produces. No gameplay system is aware this file exists.
 *
 * The layer is also where a touch session begins and ends. A phone has no
 * pointer to lock, so `Input.requestLock` and `releaseLock` stand in for
 * "the player is at the controls", and the tap that engages is the same user
 * gesture the Fullscreen and Screen Orientation APIs demand. That is why the
 * start prompt is a real element covering the screen rather than a hint: the
 * browser will only go fullscreen from a genuine touch on something.
 */
export class TouchControlsSystem implements System {
  readonly name = 'touch';

  private ctx?: GameContext;
  private root?: HTMLDivElement;
  private startLayer?: HTMLDivElement;
  private startLabel?: HTMLElement;
  private rotateGate?: HTMLDivElement;
  private stick?: HTMLDivElement;
  private knob?: HTMLElement;

  private engaged = false;
  /** Whether a round has been started yet, which retires the install offer. */
  private hasPlayed = false;
  /** Buttons currently held, by key. Two of them share the `fire` action. */
  private downButtons = new Set<string>();
  /** Toggle buttons currently latched on, by key. */
  private toggledButtons = new Set<string>();

  /** Pointer driving the stick, and where it first landed. */
  private movePointer: number | null = null;
  private moveOrigin = { x: 0, y: 0 };
  /** Pointer driving the camera, and where it was last seen. */
  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  /** Every pointer currently holding a button down, and which one. */
  private buttonPointers = new Map<number, ButtonSpec>();
  /** Button elements by key — not by action, since `fire` has two of them. */
  private buttonElements = new Map<string, HTMLElement>();
  private installPanel?: HTMLElement;
  private stopWatchingInstall?: () => void;

  private portraitQuery?: MediaQueryList;
  private disposers: Array<() => void> = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly match: MatchState,
  ) {}

  init(ctx: GameContext): void {
    if (!isTouchDevice()) return;
    this.ctx = ctx;

    // Read by the stylesheet to make room for thumbs — see the touch section
    // of style.css. On the root element rather than the body so it is set
    // before anything below it lays out.
    document.documentElement.classList.add('is-touch');

    this.build();
    this.listen(ctx);

    // Nothing is engaged at boot: the first tap is what buys fullscreen.
    this.setEngaged(false);
    this.applyOrientation();
  }

  // -- Construction ---------------------------------------------------------

  private build(): void {
    const root = document.createElement('div');
    root.className = 'touch';
    root.innerHTML = `
      <div class="touch__zone touch__zone--move" data-zone="move"></div>
      <div class="touch__zone touch__zone--look" data-zone="look"></div>
      <div class="touch__stick" data-stick><span class="touch__knob" data-knob></span></div>
      ${BUTTONS.map(
        (button) =>
          `<div class="touch__btn touch__btn--${button.key}" data-button="${button.key}">` +
          `${button.label}</div>`,
      ).join('')}
      <div class="touch__btn touch__btn--pause" data-pause aria-label="pause">❚❚</div>
    `;
    this.container.append(root);
    this.root = root;

    this.stick = root.querySelector('[data-stick]')!;
    this.knob = root.querySelector('[data-knob]')!;
    for (const button of BUTTONS) {
      this.buttonElements.set(button.key, root.querySelector(`[data-button="${button.key}"]`)!);
    }

    // The start prompt is a sibling, not a child: it covers the controls it
    // replaces, and it is the only thing on this layer that takes a tap while
    // the game is not engaged.
    const start = document.createElement('div');
    start.className = 'touch-start';
    start.innerHTML = `
      <div class="touch-start__card">
        <div class="touch-start__label" data-start-label>tap to play</div>
        <div class="touch-start__hint">${START_HINT}</div>
      </div>
      <div class="touch-install" data-install hidden></div>
    `;
    this.container.append(start);
    this.startLayer = start;
    this.startLabel = start.querySelector('[data-start-label]')!;
    this.installPanel = start.querySelector('[data-install]')!;

    const gate = document.createElement('div');
    gate.className = 'rotate-gate';
    gate.innerHTML = `
      <div class="rotate-gate__phone" aria-hidden="true"></div>
      <div class="rotate-gate__title">Turn your phone sideways</div>
      <div class="rotate-gate__note">the park is wider than it is tall</div>
    `;
    this.container.append(gate);
    this.rotateGate = gate;
  }

  private listen(ctx: GameContext): void {
    const root = this.root!;
    const start = this.startLayer!;

    const onStart = (event: PointerEvent) => {
      event.preventDefault();
      this.engage();
    };
    // pointerdown rather than click: a click on a phone arrives up to 300ms
    // after the touch on some browsers, and Safari has been known to treat a
    // delayed handler as no longer being "in" the gesture that permits
    // fullscreen.
    start.addEventListener('pointerdown', onStart);

    const onDown = (event: PointerEvent) => this.onPointerDown(event);
    const onMove = (event: PointerEvent) => this.onPointerMove(event);
    const onUp = (event: PointerEvent) => this.onPointerUp(event);

    root.addEventListener('pointerdown', onDown);
    // On the window, so a thumb that slides off the button it started on — or
    // off the screen edge entirely — still reports its release. Losing that is
    // how a stick gets stuck on full deflection.
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // The session, from the one place that owns it. Includes the pause card's
    // resume and the end of a round, neither of which comes through this file.
    ctx.events.on('input:lockChanged', ({ locked }) => this.setEngaged(locked));

    const onVisibility = () => {
      // A backgrounded tab is a player who has left, which on a desktop is
      // what losing the pointer lock already says.
      if (document.visibilityState === 'hidden' && this.engaged) ctx.input.releaseLock();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const portrait = window.matchMedia('(orientation: portrait)');
    const onOrientation = () => this.applyOrientation();
    portrait.addEventListener('change', onOrientation);
    this.portraitQuery = portrait;

    // The selection the player never asked for.
    //
    // Two thumbs moving over a page is, to a browser, a plausible attempt to
    // select something — and iOS answers with a blue wash over whatever it
    // decided you meant, plus a callout bubble if a thumb rests too long.
    // Neither is dismissable from inside a game. The CSS turns selection off;
    // these turn off the *gestures* that start one, which the CSS alone does
    // not always reach.
    const suppress = (event: Event) => event.preventDefault();
    document.addEventListener('selectstart', suppress);
    document.addEventListener('dragstart', suppress);
    // Safari's pinch-zoom, which is not a standard event and is the other way
    // a two-thumb game gets away from the player.
    document.addEventListener('gesturestart', suppress);

    this.stopWatchingInstall = onInstallOfferChange(() => this.renderInstallOffer());
    this.renderInstallOffer();

    this.disposers = [
      () => document.removeEventListener('selectstart', suppress),
      () => document.removeEventListener('dragstart', suppress),
      () => document.removeEventListener('gesturestart', suppress),
      () => start.removeEventListener('pointerdown', onStart),
      () => root.removeEventListener('pointerdown', onDown),
      () => window.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onUp),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => portrait.removeEventListener('change', onOrientation),
    ];
  }

  // -- Installing -----------------------------------------------------------

  /**
   * Offers to put the game on the home screen.
   *
   * This is the whole answer to iOS. Safari on an iPhone has no Fullscreen API
   * — the toolbars stay, and they take a third of a landscape screen and sit
   * exactly where the fire buttons want to be. A page added to the home screen
   * runs without them, which is the only way to get a full screen there.
   *
   * Where the browser has its own install flow (Chrome and friends) it is one
   * tap. Where it does not, the steps are spelled out, because "add to home
   * screen" is a thing everybody has heard of and nobody remembers the path to.
   */
  private renderInstallOffer(): void {
    const panel = this.installPanel;
    if (!panel) return;

    const offer = installOffer();
    // Once only. It belongs on the screen a player meets before their first
    // round, not on the one between every round after it.
    if (this.hasPlayed || offer === 'none') {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }

    panel.hidden = false;
    panel.innerHTML =
      offer === 'prompt'
        ? `<button class="touch-install__button" type="button" data-install-go>
             add to home screen
           </button>
           <div class="touch-install__note">plays full screen, without the browser bars</div>`
        : `<div class="touch-install__note">
             <strong>iPhone?</strong> Safari cannot go full screen. Tap
             ${SHARE_GLYPH} <strong>Share</strong>, then
             <strong>Add to Home Screen</strong> — the game then runs without
             the browser bars.
           </div>`;

    // Its own handler, and it stops there: the layer underneath starts the
    // round on any tap, and installing the game is not asking to play it.
    panel.onpointerdown = (event: PointerEvent) => {
      event.stopPropagation();
      const button = (event.target as HTMLElement | null)?.closest('[data-install-go]');
      if (button) void promptInstall();
    };
  }

  // -- Session --------------------------------------------------------------

  /**
   * Takes the controls, and the screen with them.
   *
   * The fullscreen request is fired and forgotten: it is a nicety, and a
   * browser that refuses it (every iPhone, to this day) must still get a
   * playable game. `requestLock` is what actually starts the round, and it
   * happens whether or not the screen cooperates.
   */
  private engage(): void {
    if (this.portraitQuery?.matches) return;
    void this.enterImmersive();
    this.ctx?.input.requestLock();
  }

  private async enterImmersive(): Promise<void> {
    const element = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    try {
      if (!document.fullscreenElement) {
        // navigationUI is a hint, not a promise: Android Chrome hides the URL
        // bar for it, others ignore it.
        if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' });
        // iPad Safari has the prefixed form; iPhone Safari has neither.
        else await element.webkitRequestFullscreen?.();
      }
    } catch {
      // Refused, or unsupported. The rotate gate is the fallback and is
      // already doing its job.
    }

    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: string) => Promise<void>;
      };
      await orientation?.lock?.('landscape');
    } catch {
      // Only Android honours this, and only from fullscreen. Everywhere else
      // the gate asks the player to turn the phone themselves.
    }
  }

  private setEngaged(engaged: boolean): void {
    this.engaged = engaged;
    if (engaged && !this.hasPlayed) {
      this.hasPlayed = true;
      this.renderInstallOffer();
    }
    this.root?.classList.toggle('is-live', engaged);
    this.releaseEverything();

    const gated = this.portraitQuery?.matches ?? false;
    this.startLayer?.classList.toggle('is-visible', !engaged && !gated);
    if (!engaged && this.startLabel) {
      // The same tap means "begin" and "again", and the card should say which.
      this.startLabel.textContent =
        this.match.phase === 'ended' ? 'tap to play again' : 'tap to play';
    }
  }

  /**
   * Drops every held control.
   *
   * Called whenever the session changes hands, because a thumb that was on the
   * trigger when the round ended has no release event coming — the overlay it
   * was touching is gone.
   */
  private releaseEverything(): void {
    const input = this.ctx?.input;
    this.movePointer = null;
    this.lookPointer = null;
    this.buttonPointers.clear();
    this.downButtons.clear();
    this.toggledButtons.clear();
    input?.clearTouchMove();
    for (const button of BUTTONS) {
      input?.setTouchAction(button.action, false);
      this.buttonElements.get(button.key)?.classList.remove('is-down');
    }
    this.stick?.classList.remove('is-visible');
  }

  private applyOrientation(): void {
    const portrait = this.portraitQuery?.matches ?? false;
    this.rotateGate?.classList.toggle('is-visible', portrait);
    if (!portrait) {
      this.startLayer?.classList.toggle('is-visible', !this.engaged);
      return;
    }
    this.startLayer?.classList.remove('is-visible');
    // Held, not merely hidden: a round running behind a card nobody can see is
    // a round being lost.
    if (this.engaged) this.ctx?.input.releaseLock();
  }

  // -- Pointers -------------------------------------------------------------

  private onPointerDown(event: PointerEvent): void {
    if (!this.engaged) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('[data-pause]')) {
      event.preventDefault();
      this.ctx?.input.releaseLock();
      return;
    }

    const buttonElement = target.closest<HTMLElement>('[data-button]');
    if (buttonElement) {
      const spec = BUTTONS.find((b) => b.key === buttonElement.dataset.button);
      if (!spec) return;
      event.preventDefault();
      this.pressButton(spec);
      if (spec.mode === 'hold') this.buttonPointers.set(event.pointerId, spec);
      return;
    }

    const zone = target.closest<HTMLElement>('[data-zone]')?.dataset.zone;
    if (zone === 'move' && this.movePointer === null) {
      event.preventDefault();
      this.movePointer = event.pointerId;
      this.moveOrigin = { x: event.clientX, y: event.clientY };
      this.placeStick(this.moveOrigin.x, this.moveOrigin.y, 0, 0);
      this.stick?.classList.add('is-visible');
      return;
    }
    if (zone === 'look' && this.lookPointer === null) {
      event.preventDefault();
      this.lookPointer = event.pointerId;
      this.lookLast = { x: event.clientX, y: event.clientY };
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerId === this.movePointer) {
      event.preventDefault();
      this.updateStick(event.clientX, event.clientY);
      return;
    }
    if (event.pointerId === this.lookPointer) {
      event.preventDefault();
      this.ctx?.input.addTouchLook(
        event.clientX - this.lookLast.x,
        event.clientY - this.lookLast.y,
      );
      this.lookLast = { x: event.clientX, y: event.clientY };
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId === this.movePointer) {
      this.movePointer = null;
      this.ctx?.input.clearTouchMove();
      this.stick?.classList.remove('is-visible');
      return;
    }
    if (event.pointerId === this.lookPointer) {
      // The last stretch of the drag, which pointermove may never have
      // reported: the browser coalesces moves onto animation frames, and a
      // flick that ends between two of them would otherwise lose its tail —
      // the part of the gesture with the most speed in it.
      this.ctx?.input.addTouchLook(
        event.clientX - this.lookLast.x,
        event.clientY - this.lookLast.y,
      );
      this.lookPointer = null;
      return;
    }
    const spec = this.buttonPointers.get(event.pointerId);
    if (!spec) return;
    this.buttonPointers.delete(event.pointerId);
    this.downButtons.delete(spec.key);
    this.buttonElements.get(spec.key)?.classList.remove('is-down');
    this.applyAction(spec.action);
  }

  private pressButton(spec: ButtonSpec): void {
    const element = this.buttonElements.get(spec.key);
    if (spec.mode === 'toggle') {
      const on = !this.toggledButtons.has(spec.key);
      if (on) this.toggledButtons.add(spec.key);
      else this.toggledButtons.delete(spec.key);
      element?.classList.toggle('is-down', on);
    } else {
      this.downButtons.add(spec.key);
      element?.classList.add('is-down');
    }
    this.applyAction(spec.action);
  }

  /**
   * Republishes an action from every button bound to it.
   *
   * The two fire buttons are why this is not a straight write: letting go of
   * one while the other is still held would otherwise release the trigger, and
   * firing with both hands — which is the entire point of the second button —
   * would be worse than firing with one.
   */
  private applyAction(action: Action): void {
    const down = BUTTONS.some(
      (button) =>
        button.action === action &&
        (this.downButtons.has(button.key) || this.toggledButtons.has(button.key)),
    );
    this.ctx?.input.setTouchAction(action, down);
  }

  // -- Stick ----------------------------------------------------------------

  private updateStick(x: number, y: number): void {
    const dx = x - this.moveOrigin.x;
    const dy = y - this.moveOrigin.y;
    let ax = dx / touchConfig.stickRadius;
    // Screen y grows downward; forward is up.
    let ay = -dy / touchConfig.stickRadius;

    const length = Math.hypot(ax, ay);
    if (length > 1) {
      ax /= length;
      ay /= length;
    }
    if (length < touchConfig.stickDeadzone) {
      ax = 0;
      ay = 0;
    }

    this.ctx?.input.setTouchMove(ax, ay);
    this.placeStick(this.moveOrigin.x, this.moveOrigin.y, ax, ay);
  }

  /** Draws the ring where the thumb landed, with the knob at its deflection. */
  private placeStick(originX: number, originY: number, ax: number, ay: number): void {
    const stick = this.stick;
    const knob = this.knob;
    if (!stick || !knob) return;
    stick.style.left = `${originX}px`;
    stick.style.top = `${originY}px`;
    knob.style.transform =
      `translate(-50%, -50%) translate(${ax * touchConfig.stickRadius}px, ` +
      `${-ay * touchConfig.stickRadius}px)`;
  }

  dispose(): void {
    this.stopWatchingInstall?.();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.releaseEverything();
    this.root?.remove();
    this.startLayer?.remove();
    this.rotateGate?.remove();
    document.documentElement.classList.remove('is-touch');
  }
}
