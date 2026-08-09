import { Vector3 } from 'three';
import { ballistics as config, paintColors } from '../core/Config';
import { clamp } from '../core/MathUtils';
import type { GameContext, System } from '../core/System';
import { AimSolver, spreadConeRadius } from './Aim';
import type { BallisticsSystem } from './Ballistics';
import type { PlayerState } from './PlayerState';

/** Pitch kick per shot, in radians. Deliberately tiny — this is a calm game. */
const RECOIL = 0.0045;

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
  readonly color: number;

  private readonly muzzle = new Vector3();
  private readonly shotDirection = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();

  constructor(
    private readonly state: PlayerState,
    private readonly ballistics: BallisticsSystem,
    private readonly aim: AimSolver,
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

    // Nudging pitch directly is a crude recoil — no recovery curve, the player
    // just re-aims. Enough to give the shot weight; phase 7 can do better.
    state.pitch = clamp(state.pitch + RECOIL, -Math.PI / 2, Math.PI / 2);
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
