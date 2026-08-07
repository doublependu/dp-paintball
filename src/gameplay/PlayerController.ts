import type * as RapierNS from '@dimforge/rapier3d';
import { Vector3 } from 'three';
import { physics as physicsConfig, player as playerConfig } from '../core/Config';
import { damp, dampAngle } from '../core/MathUtils';
import type { GameContext, System } from '../core/System';
import type { PlayerState } from './PlayerState';

/** Grace window after walking off a ledge during which a jump still works. */
const COYOTE_TIME = 0.12;
/** A jump pressed this long before landing still fires on touchdown. */
const JUMP_BUFFER = 0.15;
/** Downward bias kept while grounded so snap-to-ground keeps its contact. */
const GROUND_STICK_SPEED = 2;

/**
 * Kinematic character controller.
 *
 * Movement is authored as a velocity we *want*, handed to Rapier as a desired
 * translation, and corrected by whatever Rapier says actually fits. Coyote time
 * and jump buffering are what make it feel forgiving rather than precise — this
 * is a relaxing game, not a precision platformer.
 */
export class PlayerController implements System {
  readonly name = 'player';

  private body?: RapierNS.RigidBody;
  private collider?: RapierNS.Collider;
  private controller?: RapierNS.KinematicCharacterController;

  private prevPosition = new Vector3();
  private currPosition = new Vector3();

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private wantsCrouch = false;

  /** Scratch vectors — allocating per frame here would churn the GC hard. */
  private readonly wishDir = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly desired = new Vector3();

  constructor(private readonly state: PlayerState) {}

  init(ctx: GameContext): void {
    const { physics } = ctx;
    const spawn = this.state.position;

    const centerY = spawn.y + playerConfig.height / 2;
    this.body = physics.w.createRigidBody(
      physics.api.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.x,
        centerY,
        spawn.z,
      ),
    );

    this.collider = physics.w.createCollider(
      physics.api.ColliderDesc.capsule(
        halfHeightFor(playerConfig.height),
        playerConfig.radius,
      ),
      this.body,
    );

    this.controller = physics.createCharacterController();

    // Published so camera pullback and the player's own shots can exclude it.
    this.state.collider = this.collider;

    this.prevPosition.copy(spawn);
    this.currPosition.copy(spawn);
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    const { input, physics } = ctx;
    const { state } = this;
    const body = this.body;
    const collider = this.collider;
    const controller = this.controller;
    if (!body || !collider || !controller) return;

    this.prevPosition.copy(this.currPosition);

    // --- Intent ---------------------------------------------------------
    const move = input.getMoveVector();
    state.sprinting = input.isDown('sprint') && move.y > 0 && !state.crouching;
    this.wantsCrouch = input.isDown('crouch');

    if (input.wasPressed('jump')) this.jumpBufferTimer = JUMP_BUFFER;
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    this.coyoteTimer = state.grounded
      ? COYOTE_TIME
      : Math.max(0, this.coyoteTimer - dt);

    this.updateCrouch(physics, collider, body);

    // --- Horizontal velocity --------------------------------------------
    // Yaw is owned by the camera, so movement is always camera-relative.
    const { yaw } = state;
    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    this.wishDir
      .copy(this.right)
      .multiplyScalar(move.x)
      .addScaledVector(this.forward, move.y);

    const hasInput = this.wishDir.lengthSq() > 1e-6;
    if (hasInput) this.wishDir.normalize();

    const targetSpeed = state.crouching
      ? playerConfig.crouchSpeed
      : state.sprinting
        ? playerConfig.sprintSpeed
        : playerConfig.walkSpeed;

    const targetVx = this.wishDir.x * targetSpeed;
    const targetVz = this.wishDir.z * targetSpeed;

    // Air control is deliberately weak: you commit to a jump's trajectory.
    const lambda = state.grounded
      ? hasInput
        ? playerConfig.groundAccel
        : playerConfig.groundFriction
      : playerConfig.airAccel * playerConfig.airControl;

    state.velocity.x = damp(state.velocity.x, targetVx, lambda, dt);
    state.velocity.z = damp(state.velocity.z, targetVz, lambda, dt);

    // --- Vertical velocity ----------------------------------------------
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0 && !state.crouching) {
      // Solve for the launch speed that peaks at exactly jumpHeight.
      state.velocity.y = Math.sqrt(2 * Math.abs(physicsConfig.gravity) * playerConfig.jumpHeight);
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      state.grounded = false;
    } else if (state.grounded && state.velocity.y <= 0) {
      // A small downward bias keeps snap-to-ground engaged over crests.
      state.velocity.y = -GROUND_STICK_SPEED;
    } else {
      state.velocity.y += physicsConfig.gravity * dt;
    }

    // --- Resolve against the world ---------------------------------------
    this.desired.copy(state.velocity).multiplyScalar(dt);
    controller.computeColliderMovement(collider, this.desired);
    const applied = controller.computedMovement();

    const translation = body.translation();
    const nextCenter = {
      x: translation.x + applied.x,
      y: translation.y + applied.y,
      z: translation.z + applied.z,
    };
    body.setNextKinematicTranslation(nextCenter);

    state.grounded = controller.computedGrounded();

    // If we asked to rise but barely moved, we clipped a ceiling — kill the
    // upward velocity so we don't hang there for the rest of the arc.
    if (this.desired.y > 0 && applied.y < this.desired.y * 0.5) {
      state.velocity.y = 0;
    }
    if (state.grounded && state.velocity.y < 0) {
      state.velocity.y = -GROUND_STICK_SPEED;
    }

    // --- Publish ---------------------------------------------------------
    this.currPosition.set(
      nextCenter.x,
      nextCenter.y - state.height / 2,
      nextCenter.z,
    );
    state.position.copy(this.currPosition);
    state.horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);

    // Facing: snap to the camera while aiming, otherwise turn toward travel.
    const targetYaw =
      state.aiming || !hasInput
        ? yaw
        : Math.atan2(-this.wishDir.x, -this.wishDir.z);
    state.bodyYaw = dampAngle(state.bodyYaw, targetYaw, 14, dt);
  }

  update(_dt: number, alpha: number): void {
    this.state.renderPosition.lerpVectors(this.prevPosition, this.currPosition, alpha);
  }

  /**
   * Hard-sets the character's position, clearing momentum and interpolation
   * history so the move doesn't smear across a frame. Used by respawn logic and
   * by the automated movement tests.
   */
  teleport(feetPosition: Vector3): void {
    if (!this.body) return;
    this.body.setTranslation(
      {
        x: feetPosition.x,
        y: feetPosition.y + this.state.height / 2,
        z: feetPosition.z,
      },
      true,
    );
    this.state.velocity.set(0, 0, 0);
    this.state.position.copy(feetPosition);
    this.prevPosition.copy(feetPosition);
    this.currPosition.copy(feetPosition);
    this.state.renderPosition.copy(feetPosition);
  }

  /**
   * Swaps the capsule between standing and crouched heights, refusing to stand
   * up when there is something overhead.
   */
  private updateCrouch(
    physics: GameContext['physics'],
    collider: RapierNS.Collider,
    body: RapierNS.RigidBody,
  ): void {
    const { state } = this;
    if (this.wantsCrouch === state.crouching) return;

    if (!this.wantsCrouch && !this.hasHeadroom(physics, body)) return;

    const nextHeight = this.wantsCrouch ? playerConfig.crouchHeight : playerConfig.height;
    const delta = nextHeight - state.height;

    collider.setShape(
      new physics.api.Capsule(halfHeightFor(nextHeight), playerConfig.radius),
    );

    // The capsule grows and shrinks about its centre, so shifting the centre by
    // half the delta keeps the feet planted instead of sinking or popping.
    const t = body.translation();
    body.setTranslation({ x: t.x, y: t.y + delta / 2, z: t.z }, true);

    state.height = nextHeight;
    state.crouching = this.wantsCrouch;
  }

  private hasHeadroom(physics: GameContext['physics'], body: RapierNS.RigidBody): boolean {
    const t = body.translation();
    const clearanceNeeded = playerConfig.height - playerConfig.crouchHeight + 0.05;
    const origin = new Vector3(t.x, t.y + playerConfig.crouchHeight / 2, t.z);
    const hit = physics.raycast(origin, UP, clearanceNeeded, this.collider);
    return hit === null;
  }

  dispose(): void {
    this.body = undefined;
    this.collider = undefined;
    this.controller = undefined;
  }
}

const UP = new Vector3(0, 1, 0);

/**
 * Rapier capsules are described by the half-height of the *cylinder*, excluding
 * the hemispherical caps — so total height is 2*(halfHeight + radius).
 */
function halfHeightFor(totalHeight: number): number {
  return Math.max(0.01, totalHeight / 2 - playerConfig.radius);
}
