import {
  CircleGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { paintColors, reticle as config } from '../core/Config';
import { damp } from '../core/MathUtils';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import type { GameContext, System } from '../core/System';
import { AimSolver, spreadConeRadius } from './Aim';
import { BallisticsSystem, type TrajectoryPrediction } from './Ballistics';
import type { PlayerState } from './PlayerState';

/**
 * The world-space half of the aiming pair.
 *
 * The fixed crosshair at screen centre says where you are pointing, which is
 * also the direction the ball leaves the muzzle. It cannot say where the ball
 * ends up, because the ball arcs: 0.46 m low at 8 m, 1.73 m at 15 m. This
 * system traces the real flight and marks the ground where it lands.
 *
 * The deliberate choice is to show the arc rather than cancel it. Compensating
 * the shot would make the fixed crosshair truthful and hide the trajectory
 * entirely — but the lazy readable arc is the thing this game is built around,
 * and a player who can see it can learn to lead with it. So the shot is left
 * exactly as it was and the truth is drawn into the world instead.
 *
 * The dotted arc between the two is the same traced path, sampled. It costs
 * nothing extra to draw — the points are already computed to find the impact —
 * and it turns "your shot went somewhere below the crosshair" into a shape you
 * can actually read while you fire.
 */
export class AimReticleSystem implements System {
  readonly name = 'aim-reticle';

  private ring?: Mesh;
  private ringMaterial?: MeshBasicMaterial;
  /** The player's own paint colour — what is about to land on that spot. */
  private readonly color: number;
  private dot?: Mesh;
  private dotMaterial?: MeshBasicMaterial;
  private arc?: InstancedMesh;
  private prediction!: TrajectoryPrediction;

  /** Damped ring position, so a trace that steps off a ledge does not snap. */
  private readonly smoothed = new Vector3();
  private smoothedValid = false;
  private ringRadius = 0;

  private locked = false;

  private readonly orientation = new Quaternion();
  private readonly matrix = new Matrix4();
  private readonly scale = new Vector3();

  constructor(
    private readonly state: PlayerState,
    private readonly ballistics: BallisticsSystem,
    private readonly aim: AimSolver,
    colorIndex = 0,
  ) {
    this.color = paintColors[colorIndex % paintColors.length]!;
  }

  init(ctx: GameContext): void {
    this.prediction = this.ballistics.newPrediction();

    // A ring, matching the fixed crosshair's language — paint arcs, so a
    // precise cross would be a lie in either place.
    //
    // In the player's own paint colour rather than ink. Ink is the right
    // vocabulary for outlines but the wrong one for a marker: it is nearly
    // black, so on shadowed stone or under the arcade it disappeared entirely.
    // A saturated paint colour reads against every surface in a deliberately
    // muted park, and it says whose paint is about to land there.
    this.ringMaterial = new MeshBasicMaterial({
      color: new Color(this.color),
      transparent: true,
      opacity: 0.95,
      // Lying flat on the ground it is often edge-on to the sun; unlit and
      // double-sided keeps it legible from every approach.
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    });

    // A wide band, not a hairline. At 0.82 the annulus was 7cm across on a 40cm
    // ring and vanished to two pixels by 25m; the marker has to survive being
    // small far more than it has to look delicate up close.
    this.ring = new Mesh(new RingGeometry(0.62, 1, 32), this.ringMaterial);
    this.ring.castShadow = false;
    this.ring.receiveShadow = false;
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    // Off the outline prepass: a marker is not scenery, and an ink line around
    // it would fight the ink line it is drawn with.
    this.ring.layers.set(NO_OUTLINE_LAYER);
    ctx.scene.add(this.ring);

    // The always-legible half of the marker: a small disc turned to face the
    // camera, so it holds its shape however grazing the view of the surface is.
    this.dotMaterial = new MeshBasicMaterial({
      color: new Color(this.color),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    });
    this.dot = new Mesh(new CircleGeometry(1, 16), this.dotMaterial);
    this.dot.castShadow = false;
    this.dot.receiveShadow = false;
    this.dot.visible = false;
    this.dot.renderOrder = 3;
    this.dot.layers.set(NO_OUTLINE_LAYER);
    ctx.scene.add(this.dot);

    // Droplets rather than a line: `LineBasicMaterial` is a one-pixel hairline
    // on every platform that matters, which reads as a technical overlay. A
    // dotted trail of paint is both legible at any resolution and the right
    // material for a game about flinging paint.
    const dotMaterial = new MeshBasicMaterial({
      color: new Color(this.color),
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      fog: false,
    });
    this.arc = new InstancedMesh(
      new SphereGeometry(config.arcDotRadius, 6, 4),
      dotMaterial,
      config.arcMaxDots,
    );
    this.arc.count = 0;
    this.arc.castShadow = false;
    this.arc.receiveShadow = false;
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.arc.layers.set(NO_OUTLINE_LAYER);
    ctx.scene.add(this.arc);

    // Nothing to aim at behind the menu.
    ctx.events.on('input:lockChanged', ({ locked }) => {
      this.locked = locked;
    });
  }

  fixedUpdate(_dt: number, ctx: GameContext): void {
    if (!this.locked) return;
    this.aim.solve(this.state, ctx);
    this.ballistics.predict(
      ctx.physics,
      this.aim.muzzle,
      this.aim.direction,
      this.prediction,
      this.state.collider ?? undefined,
    );
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    const ring = this.ring;
    const arc = this.arc;
    const dot = this.dot;
    if (!ring || !arc || !dot) return;

    const prediction = this.prediction;
    if (!this.locked || !prediction.hit) {
      ring.visible = false;
      dot.visible = false;
      arc.visible = false;
      this.smoothedValid = false;
      return;
    }

    // Snap on the first solve, damp after: a fresh marker should appear where
    // it belongs rather than fly in from wherever the last one died.
    if (!this.smoothedValid) {
      this.smoothed.copy(prediction.point);
      this.smoothedValid = true;
    } else {
      this.smoothed.x = damp(this.smoothed.x, prediction.point.x, config.lambda, dt);
      this.smoothed.y = damp(this.smoothed.y, prediction.point.y, config.lambda, dt);
      this.smoothed.z = damp(this.smoothed.z, prediction.point.z, config.lambda, dt);
    }

    // Scaling the radius with range holds the ring at a roughly constant size
    // on screen, and folding spread in on top keeps the reticle honest about
    // accuracy — it opens at a sprint and tightens the moment you aim.
    this.ringRadius =
      (config.ringAngularSize + spreadConeRadius(this.state)) * prediction.distance;

    // Lie the ring on the surface it marks.
    this.orientation.setFromUnitVectors(RING_NORMAL, prediction.normal);
    ring.position
      .copy(this.smoothed)
      .addScaledVector(prediction.normal, config.surfaceOffset);
    ring.quaternion.copy(this.orientation);
    ring.scale.setScalar(this.ringRadius);
    ring.visible = true;

    // Same point, but turned to the camera and lifted clear of the surface so
    // a grazing view never buries half of it in the ground.
    dot.position
      .copy(this.smoothed)
      .addScaledVector(prediction.normal, config.surfaceOffset * 2);
    dot.quaternion.copy(ctx.camera.quaternion);
    dot.scale.setScalar(config.dotAngularSize * prediction.distance);
    dot.visible = true;

    // Lined up on a person is the outcome worth calling out, so the marker
    // goes white — the one value that separates cleanly from every paint colour
    // in the roster as well as from the park.
    const target = prediction.characterId;
    const hex = target !== undefined && target !== 'player' ? 0xffffff : this.color;
    this.ringMaterial?.color.setHex(hex);
    this.dotMaterial?.color.setHex(hex);

    this.drawArc();
  }

  /**
   * Lays droplets along the traced path.
   *
   * The near end is skipped: the first few steps are inside and behind the
   * character's own body from a third-person camera, and dots there just
   * clutter the shoulder. Dots fade and shrink toward the muzzle so the eye is
   * led along the arc toward the impact rather than away from it.
   */
  private drawArc(): void {
    const arc = this.arc;
    const prediction = this.prediction;
    if (!arc) return;

    const stride = Math.max(1, config.arcStride);
    let count = 0;
    for (
      let i = config.arcSkipSteps;
      i < prediction.pointCount && count < config.arcMaxDots;
      i += stride
    ) {
      const point = prediction.points[i]!;
      // Grow toward the impact end, which also hides the fact that the last
      // dot may not land exactly on the surface.
      const t = i / Math.max(1, prediction.pointCount - 1);
      this.scale.setScalar(0.45 + 0.55 * t);
      this.matrix.compose(point, FLAT, this.scale);
      arc.setMatrixAt(count, this.matrix);
      count++;
    }

    arc.count = count;
    arc.visible = count > 0;
    if (count > 0) arc.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.ring) {
      this.ring.removeFromParent();
      this.ring.geometry.dispose();
    }
    this.ringMaterial?.dispose();
    if (this.dot) {
      this.dot.removeFromParent();
      this.dot.geometry.dispose();
    }
    this.dotMaterial?.dispose();
    if (this.arc) {
      this.arc.removeFromParent();
      this.arc.geometry.dispose();
      (this.arc.material as MeshBasicMaterial).dispose();
      this.arc.dispose();
    }
  }
}

/** RingGeometry is built in the XY plane, so its normal is +Z. */
const RING_NORMAL = new Vector3(0, 0, 1);
const FLAT = new Quaternion();
