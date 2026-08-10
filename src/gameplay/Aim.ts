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
 * unreliable. Shared with the scene crosshair, which folds it into its ring
 * radius, so the ring visibly tightens as you settle and opens at a sprint.
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
 * Split out of the weapon because the scene crosshair has to answer the same
 * question every frame that the gun answers on every trigger pull, and they
 * have to answer it identically. A crosshair solving its own muzzle offset
 * would sit a few centimetres off the real one and drift further with every
 * tweak — the same duplication that already put the player's aim and the bots'
 * aim on different physics.
 *
 * The subtlety it encapsulates is convergent aiming. The muzzle sits at the
 * character's shoulder, but the player aims with a camera offset behind and to
 * the side of that. Firing straight down the muzzle's forward axis would send
 * shots wide of the crosshair by the whole shoulder offset. So we trace from
 * the camera to find what the player is actually pointing at, then aim the
 * muzzle at *that point*.
 *
 * A useful consequence: the launch direction always passes through the point
 * under the centre of the screen, so the viewport crosshair is honest about the
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

  /**
   * Muzzle sits on the marker's barrel, facing where the player looks.
   *
   * These numbers sit on the barrel's own axis, extended back into the
   * receiver. Measured, not guessed: in the aim pose the barrel runs from
   * (0.12, 1.17, 0.67) to (0.04, 1.09, 0.93) in body-relative metres, which is
   * much closer to the centre line than the shoulder it hangs from — the aim
   * pose tucks the arm inward across the chest (`armR.rotation.z`), so a muzzle
   * placed at the shoulder would be 0.18m to the right of the gun.
   *
   * Deliberately *not* the barrel tip. Spawning a projectile 0.93m in front of
   * the body lets a player hugging cover fire from the far side of it, so the
   * muzzle stays just inside the receiver instead — on the same line, close
   * enough to the capsule to keep that from happening.
   *
   * It stays analytic rather than reading the posed joint matrix: the rig is
   * posed in `update()` and shots are fired from `fixedUpdate()`, so a matrix
   * read here would be a frame stale, and the scene crosshair traces from this
   * same point every step.
   */
  private computeMuzzle(state: PlayerState): void {
    const yaw = state.yaw;
    const heightRatio = state.height / playerConfig.height;

    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.lateral.set(Math.cos(yaw), 0, -Math.sin(yaw));

    // Simulation position, not renderPosition: this runs in fixedUpdate, where
    // the interpolated visual transform is a frame stale.
    this.muzzle
      .copy(state.position)
      .addScaledVector(UP, 1.18 * heightRatio)
      .addScaledVector(this.lateral, 0.15)
      .addScaledVector(this.forward, 0.56);
  }
}
