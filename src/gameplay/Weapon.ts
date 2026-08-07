import { Vector3 } from 'three';
import { ballistics as config, paintColors, player as playerConfig } from '../core/Config';
import { DEG2RAD, clamp } from '../core/MathUtils';
import type { GameContext, System } from '../core/System';
import type { BallisticsSystem } from './Ballistics';
import type { PlayerState } from './PlayerState';

/** How far ahead we look for something to aim at. */
const AIM_RANGE = 200;
/** Pitch kick per shot, in radians. Deliberately tiny — this is a calm game. */
const RECOIL = 0.0045;

/**
 * Turns fire input into paintballs.
 *
 * The subtlety is where a shot actually starts. The muzzle sits at the
 * character's shoulder, but the player is aiming with a camera offset behind
 * and to the side of that. Firing straight down the muzzle's forward axis would
 * send shots wide of the crosshair by the whole shoulder offset. So we trace
 * from the camera to find what the player is actually pointing at, then aim the
 * muzzle at *that point* — convergent aiming, the standard fix.
 */
export class WeaponSystem implements System {
  readonly name = 'weapon';

  private cooldown = 0;
  readonly color: number;

  private readonly muzzle = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly aimPoint = new Vector3();
  private readonly shotDirection = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly lateral = new Vector3();

  constructor(
    private readonly state: PlayerState,
    private readonly ballistics: BallisticsSystem,
    private readonly shooterId = 'player',
    colorIndex = 0,
  ) {
    this.color = paintColors[colorIndex % paintColors.length]!;
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!ctx.input.isDown('fire') || this.cooldown > 0) return;

    this.cooldown = config.fireInterval;
    this.shoot(ctx);
  }

  private shoot(ctx: GameContext): void {
    const { camera, physics, events, rng } = ctx;
    const { state } = this;

    this.computeMuzzle();

    // Where is the player actually pointing?
    this.cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const hit = physics.raycast(
      camera.position,
      this.cameraForward,
      AIM_RANGE,
      state.collider ?? undefined,
    );
    if (hit) {
      this.aimPoint.set(hit.point.x, hit.point.y, hit.point.z);
    } else {
      this.aimPoint.copy(camera.position).addScaledVector(this.cameraForward, AIM_RANGE);
    }

    this.shotDirection.subVectors(this.aimPoint, this.muzzle).normalize();
    this.applySpread(rng);

    this.ballistics.fire(
      this.muzzle,
      this.shotDirection,
      this.shooterId,
      this.color,
      state.collider ?? undefined,
    );

    events.emit('shot:fired', {
      shooterId: this.shooterId,
      color: this.color,
      origin: this.muzzle.clone(),
      direction: this.shotDirection.clone(),
    });

    // Nudging pitch directly is a crude recoil — no recovery curve, the player
    // just re-aims. Enough to give the shot weight; phase 7 can do better.
    state.pitch = clamp(state.pitch + RECOIL, -Math.PI / 2, Math.PI / 2);
  }

  /** Muzzle sits at the character's right shoulder, facing where they look. */
  private computeMuzzle(): void {
    const { state } = this;
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

  /**
   * Scatters the shot within a cone. Tightens when aiming or crouched, opens up
   * when sprinting — so standing still and aiming is rewarded without ever
   * making the gun feel unreliable.
   */
  private applySpread(rng: GameContext['rng']): void {
    const { state } = this;
    let multiplier = 1;
    if (state.aiming) multiplier *= 0.4;
    if (state.crouching) multiplier *= 0.7;
    multiplier *= 1 + (state.horizontalSpeed / 7.2) * 0.8;
    if (!state.grounded) multiplier *= 1.5;

    const coneRadius = Math.tan(config.baseSpread * DEG2RAD * multiplier);
    if (coneRadius <= 0) return;

    // Build a basis around the shot direction so the offset is always
    // perpendicular to it.
    this.right.crossVectors(this.shotDirection, UP);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.right, this.shotDirection).normalize();

    // sqrt keeps the distribution uniform over the disc rather than clustered
    // in the middle.
    const angle = rng.range(0, Math.PI * 2);
    const radius = Math.sqrt(rng.next()) * coneRadius;
    this.shotDirection
      .addScaledVector(this.right, Math.cos(angle) * radius)
      .addScaledVector(this.up, Math.sin(angle) * radius)
      .normalize();
  }
}

const UP = new Vector3(0, 1, 0);
