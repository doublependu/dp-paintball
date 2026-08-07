import { clamp, damp, lerp, saturate } from '../core/MathUtils';
import { JOINT, type VoxelRig } from './VoxelRig';

export interface AnimationInput {
  /** Horizontal speed in m/s. */
  speed: number;
  /** Speed at which the run cycle is fully blended in. */
  runSpeed: number;
  grounded: boolean;
  crouching: boolean;
  aiming: boolean;
  /** Signed vertical velocity, for the rise/fall pose. */
  verticalVelocity: number;
  /** Movement direction in body-local space. x is strafe, y is forward. */
  moveLocalX: number;
  moveLocalY: number;
  /** Camera pitch in radians, for aiming the upper body. */
  aimPitch: number;
}

/** Seconds a fired-shot pose stays fully on before decaying. */
const SHOOT_HOLD = 0.09;
const SHOOT_DECAY = 0.22;
const FLINCH_DURATION = 0.45;
const TAUNT_DURATION = 1.5;

/**
 * Procedural character animation.
 *
 * Poses are computed from trigonometric cycles rather than sampled from
 * keyframed clips. For a rigid blocky figure that is not a compromise — a walk
 * cycle genuinely *is* a pair of counter-phased sine curves — and it means the
 * whole animation set costs zero bytes of download, blends continuously at any
 * speed, and can be retuned by changing a number instead of re-exporting.
 */
export class CharacterAnimator {
  /** Locomotion cycle phase, in radians. */
  private phase = 0;
  private shootTimer = 0;
  private flinchTimer = 0;
  private tauntTimer = 0;

  /** Smoothed pose values, so state changes ease rather than snap. */
  private legSwing = 0;
  private armSwing = 0;
  private crouchAmount = 0;
  private leanAmount = 0;
  private strafeAmount = 0;
  private airAmount = 0;

  /** Idle drift, so a standing character is never perfectly still. */
  private idleTime = 0;

  triggerShot(): void {
    this.shootTimer = SHOOT_HOLD + SHOOT_DECAY;
  }

  triggerFlinch(): void {
    this.flinchTimer = FLINCH_DURATION;
  }

  triggerTaunt(): void {
    this.tauntTimer = TAUNT_DURATION;
  }

  get isTaunting(): boolean {
    return this.tauntTimer > 0;
  }

  update(dt: number, input: AnimationInput, rig: VoxelRig): void {
    this.idleTime += dt;
    this.shootTimer = Math.max(0, this.shootTimer - dt);
    this.flinchTimer = Math.max(0, this.flinchTimer - dt);
    this.tauntTimer = Math.max(0, this.tauntTimer - dt);

    const speedRatio = saturate(input.speed / input.runSpeed);
    const moving = input.speed > 0.35;

    // Stride frequency rises with speed, but sub-linearly — legs do not
    // cartwheel at a sprint, they lengthen their stride.
    const strideRate = 2.2 + speedRatio * 5.2;
    if (moving && input.grounded) {
      this.phase += dt * strideRate;
    } else {
      // Ease the cycle back to a neutral stance rather than freezing mid-stride.
      this.phase = damp(this.phase % (Math.PI * 2), 0, 6, dt);
    }

    // --- blend weights ----------------------------------------------------
    const targetLeg = moving && input.grounded ? lerp(0.42, 0.86, speedRatio) : 0;
    const targetArm = moving && input.grounded ? lerp(0.32, 0.72, speedRatio) : 0;
    this.legSwing = damp(this.legSwing, targetLeg, 10, dt);
    this.armSwing = damp(this.armSwing, targetArm, 10, dt);
    this.crouchAmount = damp(this.crouchAmount, input.crouching ? 1 : 0, 12, dt);
    this.leanAmount = damp(this.leanAmount, moving ? speedRatio : 0, 7, dt);
    this.strafeAmount = damp(this.strafeAmount, clamp(input.moveLocalX, -1, 1), 8, dt);
    this.airAmount = damp(this.airAmount, input.grounded ? 0 : 1, 9, dt);

    const swing = Math.sin(this.phase);
    const counterSwing = Math.sin(this.phase + Math.PI);
    // Bob runs at twice stride frequency — one dip per footfall, not per cycle.
    const bob = Math.abs(Math.sin(this.phase)) * 0.055 * this.legSwing;

    const breathe = Math.sin(this.idleTime * 1.6) * 0.012 * (1 - this.legSwing);

    // --- pelvis -----------------------------------------------------------
    const pelvis = rig.joints[JOINT.PELVIS]!;
    pelvis.position.y = 0.75 - this.crouchAmount * 0.36 - bob;
    pelvis.rotation.z = -this.strafeAmount * 0.06;
    pelvis.rotation.y = this.strafeAmount * 0.12;

    // --- torso ------------------------------------------------------------
    const torso = rig.joints[JOINT.TORSO]!;
    const flinch = this.flinchCurve();
    torso.rotation.x =
      this.leanAmount * 0.20 +
      this.crouchAmount * 0.24 +
      breathe -
      flinch * 0.28;
    torso.rotation.y = -this.strafeAmount * 0.18 + swing * 0.05 * this.armSwing;
    torso.rotation.z = flinch * 0.14;

    // --- head -------------------------------------------------------------
    const head = rig.joints[JOINT.HEAD]!;
    // Counter-rotate against the torso so the head stays level, then look along
    // the aim pitch. Heads staying level under body motion is most of what
    // makes a walk read as deliberate rather than floppy.
    head.rotation.x = clamp(-input.aimPitch * 0.55 - torso.rotation.x * 0.7, -0.7, 0.7);
    head.rotation.y = -torso.rotation.y * 0.5;
    head.rotation.z = -torso.rotation.z * 0.6 + Math.sin(this.idleTime * 0.7) * 0.02;

    // --- legs -------------------------------------------------------------
    const legL = rig.joints[JOINT.LEG_L]!;
    const legR = rig.joints[JOINT.LEG_R]!;
    const tuck = this.airAmount * (input.verticalVelocity > 0 ? 0.55 : 0.28);

    // Without knee joints a large hip rotation folds the figure in half, so the
    // crouch leans mostly on the pelvis drop and only tips the legs slightly.
    legL.rotation.x = swing * this.legSwing - this.crouchAmount * 0.26 - tuck;
    legR.rotation.x = counterSwing * this.legSwing - this.crouchAmount * 0.26 - tuck * 0.6;
    // Legs splay slightly when strafing, so sidestepping doesn't look like
    // sliding on rails.
    legL.rotation.z = -this.strafeAmount * 0.14;
    legR.rotation.z = -this.strafeAmount * 0.14;

    // --- arms -------------------------------------------------------------
    const armL = rig.joints[JOINT.ARM_L]!;
    const armR = rig.joints[JOINT.ARM_R]!;
    const shoot = this.shootCurve();
    const taunt = this.tauntCurve();
    const aimBlend = Math.max(input.aiming ? 1 : 0, shoot);

    // Left arm swings with the gait unless taunting.
    armL.rotation.x = lerp(
      counterSwing * this.armSwing - this.crouchAmount * 0.2,
      -2.4,
      taunt,
    );
    armL.rotation.z = lerp(0.06 + this.crouchAmount * 0.1, -0.5 + Math.sin(this.idleTime * 9) * 0.25, taunt);

    // Right arm holds the marker: swings when idle, comes up to aim when
    // aiming or firing, and kicks back on the shot itself.
    const rightSwing = swing * this.armSwing - this.crouchAmount * 0.2;
    const aimPose = -1.35 - input.aimPitch * 0.6;
    armR.rotation.x = lerp(lerp(rightSwing, aimPose, aimBlend), -2.4, taunt);
    armR.rotation.z = lerp(-0.06 - aimBlend * 0.22, 0.5 - Math.sin(this.idleTime * 9) * 0.25, taunt);
    // Recoil kick, additive on top of whatever pose the arm is in.
    armR.rotation.x += this.shootKick() * 0.35;

    rig.updateMatrices();
  }

  /** 1 during the hold, decaying to 0 afterwards. */
  private shootCurve(): number {
    if (this.shootTimer <= 0) return 0;
    if (this.shootTimer > SHOOT_DECAY) return 1;
    return this.shootTimer / SHOOT_DECAY;
  }

  /** Sharp spike on the shot, for the recoil kick. */
  private shootKick(): number {
    if (this.shootTimer <= SHOOT_DECAY) return 0;
    return (this.shootTimer - SHOOT_DECAY) / SHOOT_HOLD;
  }

  /** Quick jolt that settles — a hit should read instantly and be gone. */
  private flinchCurve(): number {
    if (this.flinchTimer <= 0) return 0;
    const t = 1 - this.flinchTimer / FLINCH_DURATION;
    return Math.sin(t * Math.PI) * Math.exp(-t * 2.5);
  }

  private tauntCurve(): number {
    if (this.tauntTimer <= 0) return 0;
    const t = 1 - this.tauntTimer / TAUNT_DURATION;
    // Ease in and out so the arms don't snap up and drop.
    return saturate(Math.sin(t * Math.PI) * 2.2);
  }
}
