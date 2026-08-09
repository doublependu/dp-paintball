import type * as RapierNS from '@dimforge/rapier3d';
import {
  Color,
  InstancedMesh,
  type MeshToonMaterial,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import {
  FIXED_DT,
  ballistics as config,
  physics as physicsConfig,
  reticle as reticleConfig,
} from '../core/Config';
import type { CharacterRegistry } from '../character/CharacterRegistry';
import { createCelMaterial } from '../render/CelMaterial';
import type { GameContext, System } from '../core/System';

interface Projectile {
  active: boolean;
  readonly position: Vector3;
  readonly previous: Vector3;
  readonly velocity: Vector3;
  /** Interpolation source, so fast projectiles don't stutter between steps. */
  readonly renderFrom: Vector3;
  readonly renderTo: Vector3;
  age: number;
  color: number;
  shooterId: string;
  exclude?: RapierNS.Collider;
}

/**
 * A traced flight path and where it ends. Callers own one and hand it back in,
 * so the solver allocates nothing after the first call and two callers can
 * never scribble over each other's answer.
 */
export class TrajectoryPrediction {
  /** True if the trace found a surface inside the time budget. */
  hit = false;
  readonly point = new Vector3();
  readonly normal = new Vector3();
  /** Straight-line muzzle-to-impact distance. Not the arc length. */
  distance = 0;
  flightTime = 0;
  /** Set when the impact lands on a registered character. */
  characterId?: string;

  /**
   * The traced path, muzzle first. Only the first `pointCount` are meaningful —
   * the array is retained at its high-water mark rather than reallocated.
   */
  readonly points: Vector3[] = [];
  pointCount = 0;

  /** Appends a point, growing the buffer only the first time it is needed. */
  pushPoint(x: number, y: number, z: number): void {
    const existing = this.points[this.pointCount];
    if (existing) existing.set(x, y, z);
    else this.points.push(new Vector3(x, y, z));
    this.pointCount++;
  }
}

/**
 * Paintball flight and impact.
 *
 * Paintballs are not rigid bodies. At this fire rate a body per pellet would
 * cost far more than it's worth, and Rapier's solver would still tunnel them
 * through thin geometry at 42 m/s. Instead each projectile is integrated by
 * hand — gravity plus linear drag, which is what produces the lazy readable arc
 * the game is built around — and the step is resolved with a swept sphere cast,
 * which cannot tunnel by construction.
 */
export class BallisticsSystem implements System {
  readonly name = 'ballistics';

  /**
   * Optional: without it every impact is treated as world geometry. With it,
   * hits on a registered character collider are routed to hit:character
   * instead, which is what separates painting a person from painting a wall.
   */
  constructor(private readonly characters?: CharacterRegistry) {}

  private pool: Projectile[] = [];
  private mesh?: InstancedMesh;
  private nextIndex = 0;

  private readonly delta = new Vector3();
  private readonly direction = new Vector3();
  private readonly hitPoint = new Vector3();
  private readonly hitNormal = new Vector3();
  private readonly renderPosition = new Vector3();
  // Prediction scratch. Kept apart from the live-step scratch above: the
  // reticle predicts from its own fixedUpdate, and sharing would let one
  // overwrite the other mid-trace.
  private readonly predictPosition = new Vector3();
  private readonly predictVelocity = new Vector3();
  private readonly predictChordStart = new Vector3();
  private readonly predictChord = new Vector3();
  private readonly predictDirection = new Vector3();
  private readonly matrix = new Matrix4();
  private readonly scratchColor = new Color();
  private static readonly NO_ROTATION = new Quaternion();
  private static readonly UNIT_SCALE = new Vector3(1, 1, 1);

  init(ctx: GameContext): void {
    for (let i = 0; i < config.maxActive; i++) {
      this.pool.push({
        active: false,
        position: new Vector3(),
        previous: new Vector3(),
        velocity: new Vector3(),
        renderFrom: new Vector3(),
        renderTo: new Vector3(),
        age: 0,
        color: 0xffffff,
        shooterId: '',
      });
    }

    // One instanced draw call for every paintball in flight.
    const geometry = new SphereGeometry(config.radius, 8, 6);
    // Paintballs in flight get a hot rim so they read against foliage.
    const material = createCelMaterial({ color: 0xffffff, rimStrength: 0.55, rimPower: 2.0 });
    this.mesh = new InstancedMesh(geometry, material, config.maxActive);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    ctx.scene.add(this.mesh);
  }

  /** Launches a paintball. Recycles the oldest slot if the pool is exhausted. */
  fire(
    origin: Vector3,
    direction: Vector3,
    shooterId: string,
    color: number,
    exclude?: RapierNS.Collider,
  ): void {
    const projectile = this.acquire();
    projectile.active = true;
    projectile.position.copy(origin);
    projectile.previous.copy(origin);
    projectile.renderFrom.copy(origin);
    projectile.renderTo.copy(origin);
    projectile.velocity.copy(direction).normalize().multiplyScalar(config.muzzleSpeed);
    projectile.age = 0;
    projectile.color = color;
    projectile.shooterId = shooterId;
    projectile.exclude = exclude;
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    const { physics, events } = ctx;

    for (const projectile of this.pool) {
      if (!projectile.active) continue;

      projectile.age += dt;
      if (projectile.age > config.maxLifetime) {
        projectile.active = false;
        continue;
      }

      projectile.previous.copy(projectile.position);
      projectile.renderFrom.copy(projectile.position);

      BallisticsSystem.advance(projectile.velocity, dt);

      this.delta.copy(projectile.velocity).multiplyScalar(dt);
      const distance = this.delta.length();
      if (distance < 1e-6) continue;
      this.direction.copy(this.delta).divideScalar(distance);

      const hit = this.sweep(physics, projectile, distance);
      if (hit) {
        projectile.active = false;
        this.emitImpact(events, projectile, hit);
        continue;
      }

      projectile.position.add(this.delta);
      projectile.renderTo.copy(projectile.position);
    }
  }

  update(_dt: number, alpha: number): void {
    const mesh = this.mesh;
    if (!mesh) return;

    let count = 0;
    for (const projectile of this.pool) {
      if (!projectile.active) continue;
      this.renderPosition.lerpVectors(projectile.renderFrom, projectile.renderTo, alpha);
      this.matrix.compose(
        this.renderPosition,
        BallisticsSystem.NO_ROTATION,
        BallisticsSystem.UNIT_SCALE,
      );
      mesh.setMatrixAt(count, this.matrix);
      mesh.setColorAt(count, this.scratchColor.setHex(projectile.color));
      count++;
    }

    mesh.count = count;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * A fresh prediction buffer for a caller to own.
   *
   * Exists so the headless suites can hold one without reaching into the module
   * graph, and so callers are steered away from sharing a single instance.
   */
  newPrediction(): TrajectoryPrediction {
    return new TrajectoryPrediction();
  }

  /**
   * One step of the flight model, applied in place.
   *
   * Gravity, then linear drag — cheaper than quadratic, unconditionally stable
   * at this timestep, and indistinguishable over a paintball's short flight.
   *
   * This is deliberately the *only* copy of the flight maths. The aiming
   * reticle has to trace exactly the path a real ball will take, and the moment
   * that integration exists twice the two drift apart and the reticle starts
   * lying — which is the same failure that already put the player's aim and the
   * bots' aim on different physics.
   */
  static advance(velocity: Vector3, dt: number): void {
    velocity.y += physicsConfig.gravity * config.gravityScale * dt;
    velocity.addScaledVector(velocity, -config.drag * dt);
  }

  /**
   * Traces where a shot fired right now would actually land.
   *
   * Integrates at exactly FIXED_DT, so the path is the one a real projectile
   * would fly, step for step. Collision, though, is resolved with a ray over a
   * *chord* of several steps rather than a swept sphere per step: a 40 m shot
   * is 74 steps, `sweep()` allocates a wasm-backed Ball per cast, and doing
   * that 74 times a frame is not affordable. Over a three-step chord the arc
   * sags under the chord by under 3 cm, and dropping the ball's 5.5 cm radius
   * costs less accuracy than the reticle's own line width.
   *
   * Returns false — and leaves `out.hit` false — if nothing is struck inside
   * the time budget, which is the case when you aim at the sky.
   */
  predict(
    physics: GameContext['physics'],
    origin: Vector3,
    direction: Vector3,
    out: TrajectoryPrediction,
    exclude?: RapierNS.Collider,
  ): boolean {
    out.hit = false;
    out.pointCount = 0;
    out.characterId = undefined;
    out.distance = 0;
    out.flightTime = 0;
    if (!physics.isReady) return false;

    const position = this.predictPosition.copy(origin);
    const velocity = this.predictVelocity
      .copy(direction)
      .normalize()
      .multiplyScalar(config.muzzleSpeed);
    const chordStart = this.predictChordStart.copy(origin);

    out.pushPoint(origin.x, origin.y, origin.z);

    const maxSteps = Math.ceil(reticleConfig.maxFlightTime / FIXED_DT);
    const chordSteps = Math.max(1, reticleConfig.chordSteps);
    let sinceChord = 0;
    let elapsed = 0;
    // Where the open chord began, in both the path buffer and the clock, so a
    // hit inside it can be placed exactly.
    let chordStartIndex = 0;
    let chordStartTime = 0;

    for (let step = 0; step < maxSteps; step++) {
      BallisticsSystem.advance(velocity, FIXED_DT);
      position.addScaledVector(velocity, FIXED_DT);
      elapsed += FIXED_DT;
      sinceChord++;
      out.pushPoint(position.x, position.y, position.z);

      // Resolve the accumulated chord, and always resolve the final one so the
      // tail of the budget is never left untested.
      if (sinceChord < chordSteps && step < maxSteps - 1) continue;

      this.predictChord.subVectors(position, chordStart);
      const chordLength = this.predictChord.length();
      const hit =
        chordLength < 1e-6
          ? null
          : physics.raycast(
              chordStart,
              this.predictDirection.copy(this.predictChord).divideScalar(chordLength),
              chordLength,
              exclude,
            );

      if (hit) {
        const fraction = hit.distance / chordLength;
        out.hit = true;
        out.point.set(hit.point.x, hit.point.y, hit.point.z);
        out.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        out.distance = out.point.distanceTo(origin);
        out.flightTime = chordStartTime + (elapsed - chordStartTime) * fraction;
        out.characterId = this.characters?.getId(hit.collider.handle);
        // Drop every step past the surface and end the path on it, or the drawn
        // arc pokes out the far side of whatever it just hit.
        out.pointCount = chordStartIndex + 1;
        out.pushPoint(out.point.x, out.point.y, out.point.z);
        return true;
      }

      chordStart.copy(position);
      chordStartIndex = out.pointCount - 1;
      chordStartTime = elapsed;
      sinceChord = 0;
    }

    return false;
  }

  /** Swept sphere cast over this step's motion. Returns the hit, or null. */
  private sweep(
    physics: GameContext['physics'],
    projectile: Projectile,
    distance: number,
  ): RapierNS.ColliderShapeCastHit | null {
    const shape = new physics.api.Ball(config.radius);
    return physics.w.castShape(
      projectile.position,
      IDENTITY_ROTATION,
      this.direction,
      shape,
      0,
      distance,
      true,
      undefined,
      undefined,
      projectile.exclude,
    );
  }

  private emitImpact(
    events: GameContext['events'],
    projectile: Projectile,
    hit: RapierNS.ColliderShapeCastHit,
  ): void {
    this.hitPoint
      .copy(projectile.position)
      .addScaledVector(this.direction, hit.time_of_impact);
    this.hitNormal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);

    // A grazing hit should splash less than a square one; impact speed alone
    // would miss that, so fold in the angle of incidence.
    const speed = projectile.velocity.length();
    const incidence = Math.abs(this.direction.dot(this.hitNormal));

    const impactSpeed = speed * (0.4 + 0.6 * incidence);
    const targetId = this.characters?.getId(hit.collider.handle);

    if (targetId !== undefined) {
      events.emit('hit:character', {
        targetId,
        shooterId: projectile.shooterId,
        color: projectile.color,
        point: this.hitPoint.clone(),
        normal: this.hitNormal.clone(),
        impactSpeed,
      });
      return;
    }

    events.emit('hit:world', {
      shooterId: projectile.shooterId,
      color: projectile.color,
      point: this.hitPoint.clone(),
      normal: this.hitNormal.clone(),
      impactSpeed,
      colliderHandle: hit.collider.handle,
    });
  }

  /**
   * Round-robin allocation. Once the pool is full the oldest shot is stolen,
   * which is unnoticeable at a 4 second lifetime and 256 slots.
   */
  private acquire(): Projectile {
    for (let i = 0; i < this.pool.length; i++) {
      const index = (this.nextIndex + i) % this.pool.length;
      if (!this.pool[index]!.active) {
        this.nextIndex = (index + 1) % this.pool.length;
        return this.pool[index]!;
      }
    }
    const stolen = this.pool[this.nextIndex]!;
    this.nextIndex = (this.nextIndex + 1) % this.pool.length;
    return stolen;
  }

  get activeCount(): number {
    return this.pool.reduce((n, p) => n + (p.active ? 1 : 0), 0);
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      (this.mesh.material as MeshToonMaterial).dispose();
      this.mesh.dispose();
    }
    this.pool = [];
  }
}

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
