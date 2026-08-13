import { touch as touchConfig } from './Config';
import { isTouchDevice } from './Device';
import type { EventBus } from './Events';

/** Logical actions, so key bindings live in exactly one place. */
export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'taunt'
  | 'scoreboard'
  | 'mute'
  | 'togglePerf';

const KEY_BINDINGS: Record<string, Action> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  ShiftLeft: 'sprint',
  KeyR: 'reload',
  KeyT: 'taunt',
  Tab: 'scoreboard',
  KeyM: 'mute',
  F3: 'togglePerf',
};

/** Mouse buttons map to actions too. 0 = left, 2 = right. */
const MOUSE_BINDINGS: Record<number, Action> = {
  0: 'fire',
  2: 'aim',
};

/**
 * Keyboard + mouse state with pointer lock, and the same three surfaces fed by
 * touch on a phone.
 *
 * Mouse movement accumulates between frames and is drained by `consumeMouseDelta`
 * — reading it as a per-frame delta rather than sampling the last event avoids
 * dropping motion when the browser coalesces events.
 *
 * Touch enters through `setTouchAction`, `setTouchMove` and `addTouchLook`,
 * which write into those same buffers. Everything downstream — the controller,
 * the camera, the weapon, the HUD — asks the same questions and never learns
 * which kind of machine it is running on.
 */
export class Input {
  private held = new Set<Action>();
  private pressedThisFrame = new Set<Action>();
  private releasedThisFrame = new Set<Action>();

  private mouseDx = 0;
  private mouseDy = 0;

  private locked = false;
  private disposers: Array<() => void> = [];

  /** Whether the pointer-lock APIs are in play at all. See `requestLock`. */
  private readonly touch = isTouchDevice();
  /** Stick deflection, or null while no thumb is on it. */
  private touchMove: { x: number; y: number } | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly events: EventBus,
  ) {}

  attach(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = KEY_BINDINGS[e.code];
      if (!action) return;
      // F3 and Tab are browser shortcuts; claim them. Without this, Tab moves
      // focus out of the canvas and the game silently stops receiving input.
      if (action === 'togglePerf' || action === 'scoreboard') e.preventDefault();
      if (e.repeat) return;
      this.held.add(action);
      this.pressedThisFrame.add(action);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const action = KEY_BINDINGS[e.code];
      if (!action) return;
      if (action === 'scoreboard') e.preventDefault();
      this.held.delete(action);
      this.releasedThisFrame.add(action);
    };

    // Browsers synthesise a mouse event pair from a tap, so on a touch device
    // these have to stand down entirely: a tap anywhere in the look zone would
    // otherwise read as a trigger pull, and the whole point of the dedicated
    // fire button is that repositioning a thumb costs no paint.
    const onMouseDown = (e: MouseEvent) => {
      if (this.touch || !this.locked) return;
      const action = MOUSE_BINDINGS[e.button];
      if (!action) return;
      this.held.add(action);
      this.pressedThisFrame.add(action);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (this.touch) return;
      const action = MOUSE_BINDINGS[e.button];
      if (!action) return;
      this.held.delete(action);
      this.releasedThisFrame.add(action);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (this.touch || !this.locked) return;
      this.mouseDx += e.movementX;
      this.mouseDy += e.movementY;
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    const onPointerLockChange = () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) {
        // Dropping lock (alt-tab, Esc) must not leave inputs stuck down.
        this.held.clear();
        this.mouseDx = 0;
        this.mouseDy = 0;
      }
      this.events.emit('input:lockChanged', { locked: this.locked });
    };

    const onBlur = () => {
      this.held.clear();
      this.mouseDx = 0;
      this.mouseDy = 0;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('blur', onBlur);
    this.element.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    this.disposers = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => window.removeEventListener('blur', onBlur),
      () => this.element.removeEventListener('contextmenu', onContextMenu),
      () => document.removeEventListener('pointerlockchange', onPointerLockChange),
    ];
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  /**
   * Asks for the pointer back — or, on a touch device, takes the controls.
   *
   * There is no pointer to lock on a phone, but there is exactly the same
   * question underneath: is the player at the controls right now? The round
   * pauses when the answer goes false and resumes when it comes back, and
   * `MatchSystem` and `PauseSystem` both read that from `input:lockChanged`.
   * Answering it here rather than inventing a second kind of session is what
   * keeps those two files ignorant of phones.
   *
   * The refusal is swallowed on purpose. Browsers reject a lock requested in
   * the second or so after the user pressed Esc to leave one — it is an
   * anti-trap measure, not a fault, and an unhandled rejection in the console
   * for it is noise. Callers that care whether it took should watch
   * `input:lockChanged` and ask again.
   */
  requestLock(): void {
    if (this.touch) {
      this.setEngaged(true);
      return;
    }
    const request = this.element.requestPointerLock() as unknown;
    if (request instanceof Promise) request.catch(() => {});
  }

  /**
   * Hands the cursor back.
   *
   * Held keys are cleared with it. Without that, a key still down at the moment
   * the lock goes — the fire button, or a movement key — stays "held" forever,
   * because the keyup arrives while the document is no longer receiving input
   * for it.
   */
  releaseLock(): void {
    if (this.touch) this.setEngaged(false);
    else if (document.pointerLockElement === this.element) document.exitPointerLock();
    this.held.clear();
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.touchMove = null;
    this.mouseDx = 0;
    this.mouseDy = 0;
  }

  /**
   * The touch equivalent of a pointer-lock change. Emitted synchronously,
   * where the real one arrives as a document event — every listener treats it
   * as a fact about the present, so there is nothing to wait for.
   */
  private setEngaged(engaged: boolean): void {
    if (this.locked === engaged) return;
    this.locked = engaged;
    if (!engaged) {
      this.held.clear();
      this.touchMove = null;
      this.mouseDx = 0;
      this.mouseDy = 0;
    }
    this.events.emit('input:lockChanged', { locked: engaged });
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Whether this machine is being played with thumbs. */
  get isTouch(): boolean {
    return this.touch;
  }

  /**
   * Presses or releases an action from the touch overlay.
   *
   * Buttons write into the very sets the keyboard writes into, which is why
   * `wasPressed('jump')` works for a thumb without `PlayerController` knowing
   * one exists.
   */
  setTouchAction(action: Action, down: boolean): void {
    if (down === this.held.has(action)) return;
    if (down) {
      this.held.add(action);
      this.pressedThisFrame.add(action);
    } else {
      this.held.delete(action);
      this.releasedThisFrame.add(action);
    }
  }

  /**
   * Stick deflection, already clamped to the unit disc, or null when the thumb
   * has left it. Sprint rides along on the same gesture: pushed past
   * `sprintThreshold` the stick asks for one, so the layout needs no button for
   * it.
   */
  setTouchMove(x: number, y: number): void {
    const lengthSq = x * x + y * y;
    if (lengthSq <= 1e-6) {
      this.touchMove = null;
      this.setTouchAction('sprint', false);
      return;
    }
    if (lengthSq > 1) {
      const inv = 1 / Math.sqrt(lengthSq);
      x *= inv;
      y *= inv;
    }
    this.touchMove = { x, y };
    this.setTouchAction('sprint', Math.hypot(x, y) >= touchConfig.sprintThreshold);
  }

  /** Ends the current stick gesture. */
  clearTouchMove(): void {
    this.touchMove = null;
    this.setTouchAction('sprint', false);
  }

  /**
   * Feeds a look drag, in CSS pixels, into the same buffer mouse motion uses —
   * scaled into mouse counts, because the camera converts counts to radians and
   * a pixel is worth several of them. See `touch.lookScale`.
   */
  addTouchLook(dxPx: number, dyPx: number): void {
    this.mouseDx += dxPx * touchConfig.lookScale;
    this.mouseDy += dyPx * touchConfig.lookScale;
  }

  isDown(action: Action): boolean {
    return this.held.has(action);
  }

  wasPressed(action: Action): boolean {
    return this.pressedThisFrame.has(action);
  }

  wasReleased(action: Action): boolean {
    return this.releasedThisFrame.has(action);
  }

  /**
   * Normalized movement intent. x is strafe (+right), y is forward (+forward).
   *
   * The stick wins while a thumb is on it, and the keys answer otherwise —
   * which is not only for `?touch=1` on a desktop: a phone with a keyboard
   * attached should take either, and neither should cancel the other out.
   */
  getMoveVector(): { x: number; y: number } {
    if (this.touchMove) return this.touchMove;
    let x = 0;
    let y = 0;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    if (this.isDown('forward')) y += 1;
    if (this.isDown('back')) y -= 1;
    const lengthSq = x * x + y * y;
    if (lengthSq > 1) {
      const inv = 1 / Math.sqrt(lengthSq);
      x *= inv;
      y *= inv;
    }
    return { x, y };
  }

  /** Returns accumulated mouse motion and resets it. Call once per frame. */
  consumeMouseDelta(): { dx: number; dy: number } {
    const delta = { dx: this.mouseDx, dy: this.mouseDy };
    this.mouseDx = 0;
    this.mouseDy = 0;
    return delta;
  }

  /** Clears edge-triggered state. Call at the very end of a frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }
}
