import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Euler,
  Fog,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { DEG2RAD } from '../core/MathUtils';
import { palette, player as playerConfig, render as renderConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';

/**
 * A gym for movement, not a level. Every piece here exists to falsify a
 * specific claim about the controller, and it's replaced by the Central Park
 * arena in phase 4.
 *
 * Laid out west to east:
 *   - ramps at 15/30/45/60 degrees, straddling the 50 degree climb limit
 *   - steps at 0.2/0.35/0.5m, straddling the 0.45m autostep height
 *   - a 1.4m overhang, passable only while crouched
 *   - a pillar thicket and a corridor, for camera pullback
 */
export class TestCourseSystem implements System {
  readonly name = 'test-course';

  private disposables: Array<{ dispose(): void }> = [];

  init(ctx: GameContext): void {
    const { scene } = ctx;

    scene.background = new Color(palette.skyHorizon);
    // Aerial perspective: distant geometry drifts toward the sky colour. Ghibli
    // leans on this hard for depth.
    scene.fog = new Fog(palette.fogNear, 40, 190);

    this.addLights(scene);
    this.addGround(ctx);
    this.addRamps(ctx);
    this.addSteps(ctx);
    this.addOverhang(ctx);
    this.addPillars(ctx);
    this.addCorridor(ctx);
  }

  private addLights(scene: GameContext['scene']): void {
    const hemi = new HemisphereLight(palette.skyZenith, palette.grassShade, 1.15);
    scene.add(hemi);

    const sun = new DirectionalLight(palette.sunWarm, 2.2);
    sun.position.set(30, 42, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(renderConfig.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    sun.shadow.bias = -0.0008;
    scene.add(sun);
    this.disposables.push(sun);
  }

  private addGround(ctx: GameContext): void {
    this.addBox(ctx, new Vector3(0, -0.5, 0), new Vector3(100, 1, 100), palette.grassLit);
  }

  private addRamps(ctx: GameContext): void {
    // 50 degrees is the climb limit and 55 the slide threshold, so the 45 ramp
    // must be walkable and the 60 must reject us.
    //
    // Each ramp gets its own lane in X. Laying them out along Z instead put the
    // steep ramps' high ends in front of the shallow ramps' low ends, so you
    // could never actually walk onto one from the bottom.
    const angles = [15, 30, 45, 60];
    const length = 9;
    const centerZ = -10;
    angles.forEach((deg, i) => {
      const rad = deg * DEG2RAD;
      // Rotating -rad about X lifts the +Z end, so the low lip faces -Z and
      // every lane is approached walking in +Z.
      const height = (Math.sin(rad) * length) / 2;
      this.addBox(
        ctx,
        new Vector3(-40 + i * 8, height, centerZ),
        new Vector3(6, 0.5, length),
        deg > playerConfig.maxSlopeClimb ? palette.stoneShade : palette.stoneLit,
        new Euler(-rad, 0, 0),
      );
    });
  }

  private addSteps(ctx: GameContext): void {
    // Autostep is 0.45m: the 0.2 and 0.35 flights should be walkable, the 0.5
    // flight should require jumping.
    const flights = [0.2, 0.35, 0.5];
    flights.forEach((rise, flightIndex) => {
      const x = -4 + flightIndex * 7;
      for (let step = 0; step < 5; step++) {
        const y = rise * (step + 1);
        this.addBox(
          ctx,
          new Vector3(x, y / 2, -20 + step * 1.4),
          new Vector3(5, y, 1.4),
          rise > playerConfig.maxStepHeight ? palette.stoneShade : palette.stoneLit,
        );
      }
    });
  }

  private addOverhang(ctx: GameContext): void {
    // A tunnel with 1.4m of clearance: passable crouched (1.15m), blocked
    // standing (1.8m), and the place to check that standing back up underneath
    // is refused.
    //
    // The side walls run along Z, parallel to the direction of travel. Running
    // them across the path instead just sealed the tunnel at both ends.
    const gap = 1.4;
    const halfLength = 4;
    this.addBox(
      ctx,
      new Vector3(14, gap + 0.4, -6),
      new Vector3(5, 0.8, halfLength * 2),
      palette.stoneShade,
    );
    this.addBox(
      ctx,
      new Vector3(11.6, gap / 2, -6),
      new Vector3(0.8, gap, halfLength * 2),
      palette.stoneLit,
    );
    this.addBox(
      ctx,
      new Vector3(16.4, gap / 2, -6),
      new Vector3(0.8, gap, halfLength * 2),
      palette.stoneLit,
    );
  }

  private addPillars(ctx: GameContext): void {
    // Thin verticals are the classic third-person camera failure: a ray slips
    // between them where a sphere cast does not.
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const radius = 9;
      this.addBox(
        ctx,
        new Vector3(Math.cos(angle) * radius + 6, 2, Math.sin(angle) * radius + 14),
        new Vector3(0.7, 4, 0.7),
        palette.stoneLit,
      );
    }
  }

  private addCorridor(ctx: GameContext): void {
    // A tight slot: the camera should ride the walls and fade the avatar out
    // rather than clipping through.
    this.addBox(ctx, new Vector3(-14, 1.75, 14), new Vector3(0.8, 3.5, 14), palette.stoneShade);
    this.addBox(ctx, new Vector3(-9, 1.75, 14), new Vector3(0.8, 3.5, 14), palette.stoneShade);
  }

  /** Adds a matching mesh and static collider. `size` is full extent, not half. */
  private addBox(
    ctx: GameContext,
    position: Vector3,
    size: Vector3,
    color: number,
    rotation?: Euler,
  ): void {
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    const material = new MeshLambertMaterial({ color });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const quaternion = new Quaternion();
    if (rotation) {
      quaternion.setFromEuler(rotation);
      mesh.quaternion.copy(quaternion);
    }

    ctx.scene.add(mesh);
    ctx.physics.createStaticBox(
      position,
      { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
      rotation ? quaternion : undefined,
    );

    this.disposables.push(geometry, material);
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
  }
}
