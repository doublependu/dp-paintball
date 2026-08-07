import { WORLD_SEED, debug } from './Config';
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

  constructor(container: HTMLElement) {
    this.render = new RenderSystem(container);
    this.input = new Input(this.render.canvas, this.events);
    this.perfHud = new PerfHud(debug.showPerfHud);

    this.loop = new Loop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, alpha) => this.update(dt, alpha),
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

    this.events.emit('load:progress', { phase: 'physics', progress: 0 });
    await this.physics.init((progress) => {
      this.events.emit('load:progress', { phase: 'physics', progress: progress * 0.4 });
    });

    this.input.attach();
    // Clicking the canvas is the user gesture that grants pointer lock; browsers
    // won't hand it over without one.
    this.render.canvas.addEventListener('click', () => {
      if (!this.input.isLocked) this.input.requestLock();
    });

    for (let i = 0; i < this.systems.length; i++) {
      const system = this.systems[i]!;
      await system.init?.(this.context);
      this.events.emit('load:progress', {
        phase: system.name,
        progress: 0.4 + (0.6 * (i + 1)) / this.systems.length,
      });
    }

    this.events.emit('game:ready', {});
    this.loop.start();
  }

  private fixedUpdate(dt: number): void {
    this.physics.step(dt);
    for (const system of this.systems) {
      system.fixedUpdate?.(dt, this.context);
    }
  }

  private update(dt: number, alpha: number): void {
    if (this.input.wasPressed('togglePerf')) this.perfHud.toggle();

    for (const system of this.systems) {
      system.update?.(dt, alpha, this.context);
    }

    this.render.render(this.loop.elapsed);
    this.perfHud.update(dt, this.render.renderer, this.loop.lastStepCount);

    // Must be last: systems read edge-triggered input during update.
    this.input.endFrame();
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
