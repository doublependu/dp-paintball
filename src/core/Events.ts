import type { Vector3 } from 'three';

/**
 * Every cross-system signal in the game. Systems talk through this rather than
 * holding references to each other, which is what lets phases 3-6 be built
 * independently against a stable surface.
 */
export interface GameEventMap {
  /** A paintball landed on a character. */
  'hit:character': {
    targetId: string;
    shooterId: string;
    color: number;
    point: Vector3;
    normal: Vector3;
    impactSpeed: number;
  };
  /** A paintball landed on the world. */
  'hit:world': {
    shooterId: string;
    color: number;
    point: Vector3;
    normal: Vector3;
    impactSpeed: number;
    /** Rapier collider handle, so the paint system can find the receiving mesh. */
    colliderHandle: number;
  };
  /** A paintball was fired. */
  'shot:fired': { shooterId: string; color: number; origin: Vector3; direction: Vector3 };
  /** The trigger was pulled with nothing left to fire. */
  'weapon:dry': { shooterId: string };
  /** A paint crate was placed in the world. */
  'loot:spawned': { position: Vector3; rounds: number };
  /** Somebody reached a crate first. */
  'loot:taken': { characterId: string; rounds: number; position: Vector3 };
  /** Score counters changed for someone. */
  'score:changed': { characterId: string; hitsTaken: number; hitsGiven: number };
  /** Loading progress, 0..1. */
  'load:progress': { phase: string; progress: number };
  /** Everything is ready and the game is playable. */
  'game:ready': Record<string, never>;
  /** Pointer lock gained or lost. */
  'input:lockChanged': { locked: boolean };
}

export type GameEvent = keyof GameEventMap;

type Handler<K extends GameEvent> = (payload: GameEventMap[K]) => void;

/**
 * Minimal typed pub/sub. Handlers added during a dispatch are not called until
 * the next dispatch, and removal during dispatch is safe (we iterate a copy).
 */
export class EventBus {
  private handlers = new Map<GameEvent, Set<Handler<GameEvent>>>();

  on<K extends GameEvent>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<GameEvent>);
    return () => this.off(event, handler);
  }

  once<K extends GameEvent>(event: K, handler: Handler<K>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends GameEvent>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as Handler<GameEvent>);
  }

  emit<K extends GameEvent>(event: K, payload: GameEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      (handler as Handler<K>)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
