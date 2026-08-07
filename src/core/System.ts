import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { EventBus } from './Events';
import type { Input } from './Input';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Rng } from './Random';

/**
 * Everything a system is handed on init. This is the contract phases 1-7 build
 * against — keep additions backward-compatible so parallel work doesn't collide.
 */
export interface GameContext {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly physics: PhysicsWorld;
  readonly input: Input;
  readonly events: EventBus;
  readonly rng: Rng;
  /** Seconds since the loop started. */
  readonly elapsed: number;
}

/**
 * A slice of game behaviour. Systems are registered with the Game, stepped in
 * registration order, and must not reference each other directly — cross-system
 * communication goes through the event bus.
 */
export interface System {
  readonly name: string;

  /** Async setup: asset loads, render target allocation, physics body creation. */
  init?(ctx: GameContext): Promise<void> | void;

  /** Fixed-rate simulation. Never read frame dt here. */
  fixedUpdate?(dt: number, ctx: GameContext): void;

  /**
   * Per-frame work: visual interpolation, camera, animation sampling.
   * `alpha` is the fraction of a fixed step elapsed since the last one.
   */
  update?(dt: number, alpha: number, ctx: GameContext): void;

  dispose?(): void;
}
