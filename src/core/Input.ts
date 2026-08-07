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
 * Keyboard + mouse state with pointer lock.
 *
 * Mouse movement accumulates between frames and is drained by `consumeMouseDelta`
 * — reading it as a per-frame delta rather than sampling the last event avoids
 * dropping motion when the browser coalesces events.
 */
export class Input {
  private held = new Set<Action>();
  private pressedThisFrame = new Set<Action>();
  private releasedThisFrame = new Set<Action>();

  private mouseDx = 0;
  private mouseDy = 0;

  private locked = false;
  private disposers: Array<() => void> = [];

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

    const onMouseDown = (e: MouseEvent) => {
      if (!this.locked) return;
      const action = MOUSE_BINDINGS[e.button];
      if (!action) return;
      this.held.add(action);
      this.pressedThisFrame.add(action);
    };

    const onMouseUp = (e: MouseEvent) => {
      const action = MOUSE_BINDINGS[e.button];
      if (!action) return;
      this.held.delete(action);
      this.releasedThisFrame.add(action);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.locked) return;
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

  requestLock(): void {
    void this.element.requestPointerLock();
  }

  get isLocked(): boolean {
    return this.locked;
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

  /** Normalized WASD vector. x is strafe (+right), y is forward (+forward). */
  getMoveVector(): { x: number; y: number } {
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
