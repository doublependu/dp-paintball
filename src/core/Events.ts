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
    /**
     * In a room: a ball this page does not judge (`net/`). It is heard and seen to
     * burst, and nothing else: the page that judges it says what it did.
     */
    cosmetic?: boolean;
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
    /** As on `hit:character`: a ball this page does not judge, so it leaves no paint. */
    cosmetic?: boolean;
    /** Paint from the room's log, landed on another page: painted, and not heard again. */
    quiet?: boolean;
    /**
     * The splat's shape and roll, when they are already chosen: in a room every page
     * has to draw the same one. Without them the paint draws its own.
     */
    variant?: number;
    roll?: number;
  };
  /** A paintball was fired. `remote`: by another page in the room, and flown here too. */
  'shot:fired': {
    shooterId: string;
    color: number;
    origin: Vector3;
    direction: Vector3;
    remote?: boolean;
  };
  /**
   * A tag from the room's log was counted. `judgedHere`: this page judged the ball,
   * and has already shown the hit as `hit:character`.
   */
  'tag:applied': { targetId: string; shooterId: string; color: number; judgedHere: boolean };
  /** The trigger was pulled with nothing left to fire. */
  'weapon:dry': { shooterId: string };
  /**
   * A paint crate was placed in the world.
   *
   * `where` is the hand-written name of the hiding place from `LOOT_SPOTS` —
   * "the arcade undercroft, west bay" — which is what the HUD says out loud.
   * The park's places have names and the game already knew them; it used to
   * throw this one away at the point of spawning.
   */
  'loot:spawned': { position: Vector3; rounds: number; where: string; announce: boolean };
  /** Somebody reached a crate first. */
  'loot:taken': { characterId: string; rounds: number; position: Vector3 };
  /** Score counters changed for someone. */
  'score:changed': { characterId: string; hitsTaken: number; hitsGiven: number };
  /** A round is under way. Fires on the first round and on every restart. */
  'match:started': { duration: number };
  /** The clock is running down — sent once per threshold, not per step. */
  'match:warning': { secondsLeft: number };
  /** Time up, or the last paintball in the park has been spent. */
  'match:ended': { reason: 'time' | 'ammo' };
  /** The round is on hold — the pointer was handed back mid-play. */
  'match:paused': Record<string, never>;
  /** Back in. Fires on the lock that ends a pause, never on a fresh round. */
  'match:resumed': Record<string, never>;
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
