import type * as RapierNS from '@dimforge/rapier3d';
import { Vector3 } from 'three';
import { player as playerConfig } from '../core/Config';

/**
 * Transform and movement state shared between the player controller and the
 * camera rig.
 *
 * These two systems have a genuine mutual data dependency — the camera follows
 * the body, and the body moves relative to where the camera is looking — but
 * routing a per-frame transform through the event bus would be silly. So they
 * share this object instead of referencing each other: the controller owns
 * everything except `yaw`/`pitch`/`aiming`, which the camera owns.
 */
export interface PlayerState {
  /** Simulation position of the character's feet, updated at the fixed rate. */
  position: Vector3;
  /** Feet position interpolated for the current frame. Read this for visuals. */
  renderPosition: Vector3;
  velocity: Vector3;

  /** Camera-owned. Look direction in radians; the body moves relative to yaw. */
  yaw: number;
  /** Camera-owned. Clamped elevation in radians. */
  pitch: number;
  /** Camera-owned. True while the aim button is held. */
  aiming: boolean;

  /** Controller-owned. The character's visual facing, which eases toward yaw. */
  bodyYaw: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  /** Current capsule height — changes when crouching. */
  height: number;
  /** Horizontal speed in m/s, for animation blending in phase 5. */
  horizontalSpeed: number;

  /**
   * Camera-owned. Drops toward 0 when the camera is pulled in close, so we
   * don't render the inside of the character's head. Whatever draws the avatar
   * reads this — the camera never touches the mesh itself.
   */
  avatarOpacity: number;

  /**
   * The character's own collider, published so queries can exclude it — camera
   * pullback and the player's own paintballs must not hit the player.
   * Null until the controller has initialised.
   */
  collider: RapierNS.Collider | null;
}

export function createPlayerState(spawn: Vector3): PlayerState {
  return {
    position: spawn.clone(),
    renderPosition: spawn.clone(),
    velocity: new Vector3(),
    yaw: 0,
    pitch: -0.12,
    aiming: false,
    bodyYaw: 0,
    grounded: false,
    crouching: false,
    sprinting: false,
    height: playerConfig.height,
    horizontalSpeed: 0,
    avatarOpacity: 1,
    collider: null,
  };
}
