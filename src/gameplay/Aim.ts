import { Vector3 } from 'three';
import { ballistics as ballisticsConfig, player as playerConfig } from '../core/Config';
import { DEG2RAD } from '../core/MathUtils';
import type { GameContext } from '../core/System';
import type { PlayerState } from './PlayerState';

/** How far ahead we look for something to aim at. */
export const AIM_RANGE = 200;

const UP = new Vector3(0, 1, 0);

/**
 * Tangent of the current spread cone's half-angle.
 *
 * Tightens when aiming or crouched, opens up when sprinting or airborne — so
 * standing still and aiming is rewarded without ever making the gun feel
 * unreliable. Shared with the reticle, which draws its ring at exactly this
 * radius: the ring is then literally the shot's uncertainty at that range
 * rather than a decorative circle, and it visibly tightens as you settle.
 */
export function spreadConeRadius(state: PlayerState): number {
  let multiplier = 1;
  if (state.aiming) multiplier *= 0.4;
  if (state.crouching) multiplier *= 0.7;
  multiplier *= 1 + (state.horizontalSpeed / 7.2) * 0.8;
  if (!state.grounded) multiplier *= 1.5;
  return Math.tan(ballisticsConfig.baseSpread * DEG2RAD * multiplier);
}

/**
 * Where a shot starts and which way it points.
 *
 * Split out of the weapon because the reticle has to answer the same question
 * every frame that the gun answers on every trigger pull, and they have to
 * answer it identically. A reticle solving its own muzzle offset would sit a
 * few centimetres off the real one and drift further with every tweak — the
 * same duplication that already put the player's aim and the bots' aim on
 * different physics.
 *
 * The subtlety it encapsulates is convergent aiming. The muzzle sits at the
 * character's shoulder, but the player aims with a camera offset behind and to
 * the side of that. Firing straight down the muzzle's forward axis would send
 * shots wide of the crosshair by the whole shoulder offset. So we trace from
 * the camera to find what the player is actually pointing at, then aim the
 * muzzle at *that point*.
 *
 * A useful consequence: the launch direction always passes through the point
 * under the centre of the screen, so the fixed crosshair is honest about the
 * direction of initial velocity without any correction of its own.
 */
export class AimSolver {
  readonly muzzle = new Vector3();
  readonly direction = new Vector3();
  readonly aimPoint = new Vector3();

  private readonly cameraForward = new Vector3();
  private readonly forward = new Vector3();
  private readonly lateral = new Vector3();

  /** Recomputes `muzzle`, `aimPoint` and `direction` for the current state. */
  solve(state: PlayerState, ctx: GameContext): void {
    this.computeMuzzle(state);

    const { camera, physics } = ctx;
    this.cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);

    const hit = physics.isReady
      ? physics.raycast(
          camera.position,
          this.cameraForward,
          AIM_RANGE,
          state.collider ?? undefined,
        )
      : null;

    if (hit) this.aimPoint.set(hit.point.x, hit.point.y, hit.point.z);
    else this.aimPoint.copy(camera.position).addScaledVector(this.cameraForward, AIM_RANGE);

    this.direction.subVectors(this.aimPoint, this.muzzle).normalize();
  }

  /** Muzzle sits at the character's right shoulder, facing where they look. */
  private computeMuzzle(state: PlayerState): void {
    const yaw = state.yaw;
    const heightRatio = state.height / playerConfig.height;

    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.lateral.set(Math.cos(yaw), 0, -Math.sin(yaw));

    // Simulation position, not renderPosition: this runs in fixedUpdate, where
    // the interpolated visual transform is a frame stale.
    this.muzzle
      .copy(state.position)
      .addScaledVector(UP, 1.35 * heightRatio)
      .addScaledVector(this.lateral, 0.26)
      .addScaledVector(this.forward, 0.34);
  }
}
