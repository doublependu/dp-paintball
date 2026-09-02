import { FIXED_DT, WORLD_SEED, debug } from './Config';
import { EventBus } from './Events';
import { Input } from './Input';
import { Loop } from './Loop';
import { PerfHud } from './Perf';
import { Rng } from './Random';
import type { GameContext, System } from './System';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { RenderSystem } from '../render/Renderer';

/**
 * Top-level orchestrator. Owns the subsystems, wires the context they share,
 * and drives them from the fixed-timestep loop.
 *
 * Systems are stepped in registration order and never hold references to each
 * other — everything crossing a boundary goes over the event bus.
 */
export class Game {
  readonly render: RenderSystem;
  readonly physics = new PhysicsWorld();
  readonly events = new EventBus();
  readonly input: Input;
  readonly rng = new Rng(WORLD_SEED);

  private readonly loop: Loop;
  private readonly perfHud: PerfHud;
  private readonly systems: System[] = [];
  private readonly context: GameContext;
  private booted = false;

  /** Wall-clock cost of each boot phase, for the performance pass. */
  readonly bootTimings: Array<{ phase: string; ms: number }> = [];

  constructor(container: HTMLElement) {
    this.render = new RenderSystem(container);
    this.input = new Input(this.render.canvas, this.events);
    this.perfHud = new PerfHud(debug.showPerfHud);

    this.loop = new Loop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, alpha) => this.update(dt, alpha),
      draw: () => this.draw(),
    });

    // Systems hold this object for their lifetime, so `elapsed` is a getter
    // rather than a snapshot.
    const loop = this.loop;
    this.context = {
      scene: this.render.scene,
      camera: this.render.camera,
      renderer: this.render.renderer,
      physics: this.physics,
      input: this.input,
      events: this.events,
      rng: this.rng,
      get elapsed() {
        return loop.elapsed;
      },
    };
  }

  /** Simulated seconds elapsed — see Loop.simElapsed. */
  get simElapsed(): number {
    return this.loop.simElapsed;
  }

  /**
   * Hands the simulation clock to stepSim instead of to rendered frames.
   * Test-only; see Loop.manual for why the headless harnesses need it.
   */
  setManualSim(on: boolean): void {
    this.loop.manual = on;
  }

  /**
   * Advances the simulation by `seconds` immediately, in one synchronous run,
   * and returns the number of fixed steps taken.
   *
   * Each step gets its own visual update, because animation and camera
   * smoothing read frame dt and the tests assert on both — stepping physics
   * alone would let them drift apart. Nothing is drawn: the draw is the whole
   * reason a headless frame is expensive, and the rAF tick is still there to
   * paint the current state whenever a test wants a screenshot.
   *
   * Only meaningful under setManualSim(true); calling it while frames are
   * still driving the loop would advance time twice.
   */
  stepSim(seconds: number): number {
    const steps = Math.max(1, Math.round(seconds / FIXED_DT));
    for (let i = 0; i < steps; i++) {
      this.fixedUpdate(FIXED_DT);
      this.loop.bookExternalStep(FIXED_DT);
      this.update(FIXED_DT, 0, false);
    }
    return steps;
  }

  /** Registers a system. Must be called before boot(). */
  add(system: System): this {
    if (this.booted) {
      throw new Error(`Game: cannot add "${system.name}" after boot()`);
    }
    this.systems.push(system);
    return this;
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;

    const bootStart = performance.now();
    let mark = bootStart;
    const record = (phase: string) => {
      const now = performance.now();
      this.bootTimings.push({ phase, ms: now - mark });
      mark = now;
    };

    this.events.emit('load:progress', { phase: 'physics', progress: 0 });
    await this.physics.init((progress) => {
      this.events.emit('load:progress', { phase: 'physics', progress: progress * 0.4 });
    });
    record('physics');

    this.input.attach();
    // Clicking the canvas is the user gesture that grants pointer lock; browsers
    // won't hand it over without one. On a touch device there is no lock to
    // grant and `TouchControls` owns the tap that starts a round — it has to,
    // because the same gesture is the one fullscreen and orientation lock
    // require, and a second handler here would race it.
    if (!this.input.isTouch) {
      this.render.canvas.addEventListener('click', () => {
        if (!this.input.isLocked) this.input.requestLock();
      });
    }

    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i]!;
      await system.init?.(this.context);
      record(system.name);
      this.events.emit('load:progress', {
        phase: system.name,
        progress: 0.4 + (0.6 * (i + 1)) / this.systems.length,
      });
    }
    this.bootTimings.push({ phase: 'TOTAL', ms: performance.now() - bootStart });

    this.events.emit('game:ready', {});
    this.loop.start();
  }

  private fixedUpdate(dt: number): void {
    this.physics.step(dt);
    for (const system of this.systems) {
      system.fixedUpdate?.(dt, this.context);
    }
  }

  private update(dt: number, alpha: number, draw = true): void {
    if (this.input.wasPressed('togglePerf')) this.perfHud.toggle();

    for (const system of this.systems) {
      system.update?.(dt, alpha, this.context);
    }

    if (draw) {
      // Flagged as a real frame, which is what lets the renderer pace its
      // adaptive resolution off it. `draw()` below is not one: it paints the
      // current state for a screenshot without the loop having advanced.
      this.render.render(this.loop.elapsed, true);
      this.perfHud.update(dt, this.render.renderer, this.loop.lastStepCount);
    }

    // Must be last: systems read edge-triggered input during update.
    this.input.endFrame();
  }

  private draw(): void {
    this.render.render(this.loop.elapsed);
  }

  dispose(): void {
    this.loop.stop();
    for (const system of this.systems) system.dispose?.();
    this.systems.length = 0;
    this.input.dispose();
    this.perfHud.dispose();
    this.render.dispose();
    this.physics.dispose();
    this.events.clear();
  }
}
