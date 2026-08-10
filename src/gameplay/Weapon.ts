import { Vector3 } from 'three';
import { ballistics as config, camera as cameraConfig, paintColors } from '../core/Config';
import { DEG2RAD, clamp, damp } from '../core/MathUtils';
import type { GameContext, System } from '../core/System';
import { AimSolver, spreadConeRadius } from './Aim';
import type { BallisticsSystem } from './Ballistics';
import { consume, type MatchState } from './MatchState';
import type { PlayerState } from './PlayerState';

/** Pitch kick per shot, in radians. Deliberately tiny — this is a calm game. */
const RECOIL = 0.0045;
/** How fast the kick is given back. */
const RECOIL_RECOVERY = 9;
/** The camera rig's own limits, which recoil has to respect — see `shoot()`. */
const PITCH_MIN = cameraConfig.pitchMin * DEG2RAD;
const PITCH_MAX = cameraConfig.pitchMax * DEG2RAD;

/**
 * Turns fire input into paintballs.
 *
 * Where a shot starts and which way it points is `AimSolver`'s job, shared with
 * the scene crosshair so the mark on the ground is solved from the same muzzle
 * the ball actually leaves.
 */
export class WeaponSystem implements System {
  readonly name = 'weapon';

  private cooldown = 0;
  /** Kick applied by past shots and not yet given back. See `recover()`. */
  private recoil = 0;
  /** Latches the empty-marker click to one per trigger pull. */
  private dryClicked = false;
  readonly color: number;

  private readonly muzzle = new Vector3();
  private readonly shotDirection = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();

  constructor(
    private readonly state: PlayerState,
    private readonly ballistics: BallisticsSystem,
    private readonly aim: AimSolver,
    private readonly match: MatchState,
    private readonly shooterId = 'player',
    colorIndex = 0,
  ) {
    this.color = paintColors[colorIndex % paintColors.length]!;
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recover(dt);

    if (!ctx.input.isDown('fire')) {
      this.dryClicked = false;
      return;
    }
    if (this.cooldown > 0) return;

    // The only gate on shooting. Spending the round here rather than inside
    // `shoot()` keeps the empty case from paying for an aim solve.
    if (!consume(this.match, this.shooterId)) {
      // One click per trigger pull, not one per fire interval: an empty marker
      // should sound empty rather than like a slower marker. Tracked with a
      // latch instead of `wasPressed`, because a single frame can run several
      // fixed steps and every one of them would see the same press.
      if (!this.dryClicked) {
        this.dryClicked = true;
        ctx.events.emit('weapon:dry', { shooterId: this.shooterId });
      }
      return;
    }

    this.cooldown = config.fireInterval;
    this.shoot(ctx);
  }

  /**
   * Gives back the accumulated kick.
   *
   * Without this, sustained fire walks the camera upward and never hands it
   * back — the player ends every burst dragging the mouse down to where they
   * were already pointing. Only the *decayed amount* is subtracted from pitch,
   * not the absolute pre-shot pitch, so re-aiming mid-burst still wins: the
   * recovery is applied relative to wherever the player has since pointed.
   */
  private recover(dt: number): void {
    if (this.recoil <= 1e-5) return;
    const next = damp(this.recoil, 0, RECOIL_RECOVERY, dt);
    this.state.pitch = clamp(this.state.pitch - (this.recoil - next), PITCH_MIN, PITCH_MAX);
    this.recoil = next;
  }

  private shoot(ctx: GameContext): void {
    const { events, rng } = ctx;
    const { state } = this;

    // The scene crosshair has already solved this step; solving again is a
    // handful of vector ops and one raycast, and it keeps the gun correct
    // whatever order the systems end up registered in.
    this.aim.solve(state, ctx);
    this.muzzle.copy(this.aim.muzzle);
    this.shotDirection.copy(this.aim.direction);
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

    // Kick the view up, and remember how much so `recover()` can give it back.
    //
    // Against the *camera's* pitch limits, not a looser pair of our own: the
    // camera rig re-clamps pitch every step and runs before this system, so a
    // kick past its ceiling would be thrown away there while still being
    // remembered here — and `recover()` would then hand back elevation the
    // player never got, walking the view down.
    const before = state.pitch;
    state.pitch = clamp(before + RECOIL, PITCH_MIN, PITCH_MAX);
    this.recoil += state.pitch - before;
  }

  /** Scatters the shot within the cone the scene crosshair is drawing. */
  private applySpread(rng: GameContext['rng']): void {
    const coneRadius = spreadConeRadius(this.state);
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
