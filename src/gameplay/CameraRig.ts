import type * as RapierNS from '@dimforge/rapier3d';
import { Euler, Quaternion, Vector3 } from 'three';
import { camera as cameraConfig, player as playerConfig } from '../core/Config';
import { DEG2RAD, clamp, damp, saturate } from '../core/MathUtils';
import type { GameContext, System } from '../core/System';
import type { PlayerState } from './PlayerState';

/** Below this arm length the avatar starts fading out. */
const FADE_START = 1.1;
/** At or below this, the avatar is fully hidden. */
const FADE_END = 0.55;

/**
 * Third-person spring arm.
 *
 * The arm wants to sit at `armLength` behind the character's shoulder. A sphere
 * cast finds the first thing in the way and the arm shortens to clear it. The
 * asymmetry matters: pulling *in* is instant, because a frame spent inside a
 * wall is a frame of garbage; easing back *out* is slow, because snapping out
 * the moment cover ends reads as a camera glitch.
 */
export class CameraRig implements System {
  readonly name = 'camera';

  // Annotated: Config is `as const`, so these would otherwise infer as literal
  // types and reject any other value.
  private currentArm: number = cameraConfig.armLength;
  private currentShoulder: number = cameraConfig.shoulderOffset * 0.75;
  private currentFov: number = cameraConfig.fov;
  private readonly smoothedPivot = new Vector3();
  private pivotInitialised = false;

  /** Scratch — this runs every frame and must not allocate. */
  private readonly pivot = new Vector3();
  /** smoothedPivot displaced to the shoulder; what the camera actually orbits. */
  private readonly orbitPoint = new Vector3();
  private readonly rightDir = new Vector3();
  private readonly backDir = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly quat = new Quaternion();

  constructor(private readonly state: PlayerState) {}

  init(ctx: GameContext): void {
    this.state.yaw = 0;
    this.state.pitch = -0.12;
    ctx.camera.fov = this.currentFov;
    ctx.camera.updateProjectionMatrix();
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    const { input, camera, physics } = ctx;
    const { state } = this;

    // --- Look ------------------------------------------------------------
    const { dx, dy } = input.consumeMouseDelta();
    state.yaw -= dx * cameraConfig.sensitivity;
    state.pitch = clamp(
      state.pitch - dy * cameraConfig.sensitivity,
      cameraConfig.pitchMin * DEG2RAD,
      cameraConfig.pitchMax * DEG2RAD,
    );
    state.aiming = input.isDown('aim');

    // --- Pivot -----------------------------------------------------------
    // Track the crouch so the camera settles with the character rather than
    // hovering at standing height.
    const heightRatio = state.height / playerConfig.height;
    this.pivot
      .copy(state.renderPosition)
      .addScaledVector(UP, cameraConfig.heightOffset * heightRatio);

    if (!this.pivotInitialised) {
      this.smoothedPivot.copy(this.pivot);
      this.pivotInitialised = true;
    } else {
      // Smoothing the pivot rather than the camera position keeps the follow
      // lag from fighting the collision pullback.
      const lambda = cameraConfig.followLambda;
      this.smoothedPivot.x = damp(this.smoothedPivot.x, this.pivot.x, lambda, dt);
      this.smoothedPivot.y = damp(this.smoothedPivot.y, this.pivot.y, lambda, dt);
      this.smoothedPivot.z = damp(this.smoothedPivot.z, this.pivot.z, lambda, dt);
    }

    // --- Orientation ------------------------------------------------------
    this.euler.set(state.pitch, state.yaw, 0);
    this.quat.setFromEuler(this.euler);
    this.backDir.set(0, 0, 1).applyQuaternion(this.quat);
    this.rightDir.set(1, 0, 0).applyQuaternion(this.quat);

    // Over-the-shoulder: offset the point we orbit, not just the camera, so the
    // character sits off-centre and the aim line stays clear. This must go to a
    // separate vector — folding it back into smoothedPivot would re-apply the
    // offset every frame and walk the camera sideways.
    const wantShoulder = state.aiming
      ? cameraConfig.shoulderOffset
      : cameraConfig.shoulderOffset * 0.75;

    // --- Collision --------------------------------------------------------
    // The shoulder first. The arm below is cast *from* the shoulder point, so
    // a shoulder that is already inside something — a trunk or a sign board
    // at the player's right elbow — starts the arm's cast inside it too, and
    // the camera stayed there: the autopilot's playtests caught it in tree
    // trunks and in the fountain's sign, one to a hundred frames a round.
    const allowedShoulder = this.castBall(physics, this.smoothedPivot, this.rightDir, wantShoulder, 0);
    this.currentShoulder = damp(
      this.currentShoulder,
      allowedShoulder,
      allowedShoulder < this.currentShoulder
        ? cameraConfig.collisionInLambda
        : cameraConfig.collisionOutLambda,
      dt,
    );
    this.orbitPoint.copy(this.smoothedPivot).addScaledVector(this.rightDir, this.currentShoulder);

    const wantArm = state.aiming ? cameraConfig.armLengthAimed : cameraConfig.armLength;
    const allowedArm = this.castBall(physics, this.orbitPoint, this.backDir, wantArm, 0.25);

    // Instant in, slow out.
    const armLambda =
      allowedArm < this.currentArm
        ? cameraConfig.collisionInLambda
        : cameraConfig.collisionOutLambda;
    this.currentArm = damp(this.currentArm, allowedArm, armLambda, dt);

    camera.quaternion.copy(this.quat);
    camera.position
      .copy(this.orbitPoint)
      .addScaledVector(this.backDir, this.currentArm);

    // --- Field of view ----------------------------------------------------
    const targetFov = state.aiming
      ? cameraConfig.fovAimed
      : state.sprinting
        ? cameraConfig.fovSprint
        : cameraConfig.fov;
    if (Math.abs(this.currentFov - targetFov) > 0.01) {
      this.currentFov = damp(this.currentFov, targetFov, cameraConfig.fovLambda, dt);
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }

    // --- Avatar fade ------------------------------------------------------
    // Pulled in tight against a wall, we'd otherwise be looking through the
    // back of the character's skull.
    state.avatarOpacity = saturate(
      (this.currentArm - FADE_END) / (FADE_START - FADE_END),
    );
  }

  /** The arm's collision shape, made once. See `castArm`. */
  private armShape?: RapierNS.Ball;

  /**
   * Sphere-casts from `origin` along `direction` and returns how far the
   * camera may go, up to `want` and never under `floor`. A sphere rather than a
   * ray, so the near plane never pokes through a wall the ray happened to miss.
   * Used for the arm, backward from the shoulder, and for the shoulder itself,
   * sideways from the pivot.
   */
  private castBall(
    physics: GameContext['physics'],
    origin: Vector3,
    direction: Vector3,
    want: number,
    floor: number,
  ): number {
    if (!physics.isReady) return want;

    // Made once rather than per frame: this is the only per-frame wasm
    // allocation left in the render path, and at 240Hz it was thousands of
    // shapes a second for a sphere whose radius never changes.
    const shape =
      this.armShape ?? (this.armShape = new physics.api.Ball(cameraConfig.collisionRadius));
    const hit = physics.w.castShape(
      origin,
      IDENTITY_ROTATION,
      direction,
      shape,
      0,
      want,
      true,
      undefined,
      undefined,
      this.state.collider ?? undefined,
    );

    if (!hit) return want;
    // Back off slightly so the camera sits proud of the surface rather than
    // z-fighting flush against it.
    return Math.max(floor, hit.time_of_impact - 0.08);
  }
}

const UP = new Vector3(0, 1, 0);
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
