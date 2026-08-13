import { touch as touchConfig } from '../core/Config';
import { isTouchDevice } from '../core/Device';
import type { Action } from '../core/Input';
import type { GameContext, System } from '../core/System';
import type { MatchState } from '../gameplay/MatchState';

/** One button in the right-hand thumb arc. */
interface ButtonSpec {
  action: Action;
  label: string;
  /** `hold` is down while touched; `toggle` flips and stays. */
  mode: 'hold' | 'toggle';
  /** Modifier suffix for the element's class. */
  key: string;
}

/**
 * The buttons, in the order they are laid out from the corner outward.
 *
 * No aim button, deliberately. One thumb cannot hold aim and fire at once, so
 * an aim control would be a control that costs you the trigger — touch play is
 * hip-fire, and `state.aiming` simply never goes true.
 *
 * Crouch is the one toggle. Holding a crouch is a second thumb the player does
 * not have, and unlike the rest it is a state you sit in rather than a thing
 * you do.
 */
const BUTTONS: readonly ButtonSpec[] = [
  { action: 'fire', label: 'fire', mode: 'hold', key: 'fire' },
  { action: 'jump', label: 'jump', mode: 'hold', key: 'jump' },
  { action: 'crouch', label: 'crouch', mode: 'toggle', key: 'crouch' },
  { action: 'taunt', label: 'wave', mode: 'hold', key: 'wave' },
  { action: 'scoreboard', label: 'scores', mode: 'hold', key: 'scores' },
];

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
  private crouched = false;

  /** Pointer driving the stick, and where it first landed. */
  private movePointer: number | null = null;
  private moveOrigin = { x: 0, y: 0 };
  /** Pointer driving the camera, and where it was last seen. */
  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  /** Every pointer currently holding a button down, and which one. */
  private buttonPointers = new Map<number, ButtonSpec>();
  private buttonElements = new Map<string, HTMLElement>();

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
          `<div class="touch__btn touch__btn--${button.key}" data-action="${button.action}">` +
          `${button.label}</div>`,
      ).join('')}
      <div class="touch__btn touch__btn--pause" data-pause aria-label="pause">❚❚</div>
    `;
    this.container.append(root);
    this.root = root;

    this.stick = root.querySelector('[data-stick]')!;
    this.knob = root.querySelector('[data-knob]')!;
    for (const button of BUTTONS) {
      this.buttonElements.set(
        button.action,
        root.querySelector(`[data-action="${button.action}"]`)!,
      );
    }

    // The start prompt is a sibling, not a child: it covers the controls it
    // replaces, and it is the only thing on this layer that takes a tap while
    // the game is not engaged.
    const start = document.createElement('div');
    start.className = 'touch-start';
    start.innerHTML = `
      <div class="touch-start__card">
        <div class="touch-start__label" data-start-label>tap to play</div>
        <div class="touch-start__hint">landscape &nbsp;·&nbsp; fullscreen</div>
      </div>
    `;
    this.container.append(start);
    this.startLayer = start;
    this.startLabel = start.querySelector('[data-start-label]')!;

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

    this.disposers = [
      () => start.removeEventListener('pointerdown', onStart),
      () => root.removeEventListener('pointerdown', onDown),
      () => window.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onUp),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => portrait.removeEventListener('change', onOrientation),
    ];
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
    this.crouched = false;
    input?.clearTouchMove();
    for (const button of BUTTONS) {
      input?.setTouchAction(button.action, false);
      this.buttonElements.get(button.action)?.classList.remove('is-down');
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

    const buttonElement = target.closest<HTMLElement>('[data-action]');
    if (buttonElement) {
      const spec = BUTTONS.find((b) => b.action === buttonElement.dataset.action);
      if (!spec) return;
      event.preventDefault();
      this.pressButton(spec, buttonElement);
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
    this.ctx?.input.setTouchAction(spec.action, false);
    this.buttonElements.get(spec.action)?.classList.remove('is-down');
  }

  private pressButton(spec: ButtonSpec, element: HTMLElement): void {
    if (spec.mode === 'toggle') {
      this.crouched = !this.crouched;
      this.ctx?.input.setTouchAction(spec.action, this.crouched);
      element.classList.toggle('is-down', this.crouched);
      return;
    }
    this.ctx?.input.setTouchAction(spec.action, true);
    element.classList.add('is-down');
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
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.releaseEverything();
    this.root?.remove();
    this.startLayer?.remove();
    this.rotateGate?.remove();
    document.documentElement.classList.remove('is-touch');
  }
}
