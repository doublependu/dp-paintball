import type * as RapierNS from '@dimforge/rapier3d-compat';
import {
  Color,
  InstancedMesh,
  MeshLambertMaterial,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { ballistics as config, physics as physicsConfig } from '../core/Config';
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

  private pool: Projectile[] = [];
  private mesh?: InstancedMesh;
  private nextIndex = 0;

  private readonly delta = new Vector3();
  private readonly direction = new Vector3();
  private readonly hitPoint = new Vector3();
  private readonly hitNormal = new Vector3();
  private readonly renderPosition = new Vector3();
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
    const material = new MeshLambertMaterial({ color: 0xffffff });
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

      // Linear drag. Cheaper than quadratic, unconditionally stable at this
      // timestep, and indistinguishable over a paintball's short flight.
      projectile.velocity.y += physicsConfig.gravity * config.gravityScale * dt;
      projectile.velocity.addScaledVector(projectile.velocity, -config.drag * dt);

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

    events.emit('hit:world', {
      shooterId: projectile.shooterId,
      color: projectile.color,
      point: this.hitPoint.clone(),
      normal: this.hitNormal.clone(),
      impactSpeed: speed * (0.4 + 0.6 * incidence),
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
      (this.mesh.material as MeshLambertMaterial).dispose();
      this.mesh.dispose();
    }
    this.pool = [];
  }
}

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
