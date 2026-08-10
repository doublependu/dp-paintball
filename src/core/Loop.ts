import { FIXED_DT, MAX_FRAME_DT, MAX_SUB_STEPS } from './Config';

export interface LoopCallbacks {
  /** Runs at exactly FIXED_HZ. All simulation belongs here. */
  fixedUpdate(dt: number): void;
  /**
   * Runs once per rendered frame. `alpha` is the fraction of a fixed step that
   * has elapsed since the last one — use it to interpolate visuals so rendering
   * stays smooth when the display rate isn't a multiple of the sim rate.
   */
  update(dt: number, alpha: number): void;
  /**
   * Paints the current state without advancing anything. Used for frames in
   * manual mode, where time and input belong to whoever drives stepSim.
   */
  draw(): void;
}

/**
 * Fixed-timestep loop with an accumulator and render interpolation.
 *
 * Decoupling simulation from frame rate is what keeps movement and ballistics
 * feeling identical on a 60Hz laptop and a 240Hz desktop, and it's why hit
 * detection stays consistent.
 */
export class Loop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Wall-clock seconds since start(), excluding paused time. */
  elapsed = 0;
  /**
   * Simulated seconds since start() — advanced only by completed fixed steps.
   *
   * This diverges from `elapsed` whenever the frame rate is low enough to hit
   * MAX_SUB_STEPS: the backlog is dropped rather than paid off, so the game
   * runs in slow motion instead of destabilising physics. Gameplay timing and
   * anything asserting on simulation behaviour must use this, not wall clock.
   */
  simElapsed = 0;
  /** Fixed steps taken in the most recent frame — surfaced to the perf HUD. */
  lastStepCount = 0;
  /**
   * When true, frames only paint: they advance neither time nor input, and
   * something outside the loop drives the whole update via Game.stepSim.
   *
   * This exists for the headless tests. They assert on simulated time, and the
   * software rasteriser they run under is slow enough to sit under the ~12fps
   * needed to keep `simElapsed` up with the wall clock, so waiting on frames
   * made every test many times longer than the behaviour it checks.
   *
   * Frames must stay inert rather than merely skipping the fixed steps: a
   * frame that ran the normal update would end the input frame, swallowing a
   * keypress before the stepped simulation ever saw it.
   */
  manual = false;

  constructor(private readonly callbacks: LoopCallbacks) {}

  /**
   * Books a fixed step that was driven from outside the frame loop, so both
   * clocks stay consistent with the simulation that actually ran.
   */
  bookExternalStep(dt: number): void {
    this.elapsed += dt;
    this.simElapsed += dt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // Clamp before accumulating: a backgrounded tab or a long GC pause would
    // otherwise hand us a multi-second delta and demand hundreds of steps.
    const frameDt = Math.min((now - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = now;

    if (this.manual) {
      // Paint only, so the page stays live for screenshots while the stepped
      // simulation keeps sole ownership of time and input.
      this.callbacks.draw();
      return;
    }

    this.elapsed += frameDt;
    this.accumulator += frameDt;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUB_STEPS) {
      this.callbacks.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      this.simElapsed += FIXED_DT;
      steps++;
    }
    this.lastStepCount = steps;

    // If we hit the substep ceiling we're running behind; drop the backlog
    // rather than carrying a debt we'll never pay off.
    if (steps === MAX_SUB_STEPS && this.accumulator > FIXED_DT) {
      this.accumulator = 0;
    }

    this.callbacks.update(frameDt, this.accumulator / FIXED_DT);
  };
}
