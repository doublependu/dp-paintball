import type * as RapierNS from '@dimforge/rapier3d';
import { Vector3 } from 'three';
import {
  ballistics as ballisticsConfig,
  match as matchConfig,
  physics as physicsConfig,
  player as playerConfig,
} from '../core/Config';
import { DEG2RAD, clamp, damp, dampAngle } from '../core/MathUtils';
import type { Rng } from '../core/Random';
import type { GameContext } from '../core/System';
import type { Character } from '../character/Character';
import type { AnimationInput } from '../character/CharacterAnimator';
import type { BallisticsSystem } from '../gameplay/Ballistics';
import {
  isCrateLive,
  nearestCrate,
  type LootCrate,
  type LootState,
} from '../gameplay/LootSystem';
import { ammoOf, consume, isPlaying, type MatchState } from '../gameplay/MatchState';
import type { NavGrid } from './NavGrid';
import type { Personality } from './Personality';

export type BotState = 'wander' | 'loiter' | 'engage' | 'reposition' | 'startled' | 'restock';

export interface BotTarget {
  id: string;
  /** Chest position, in world space. */
  position: Vector3;
  collider?: RapierNS.Collider;
}

/** How close counts as arriving at a waypoint. */
const ARRIVE_RADIUS = 1.1;
/** Repath at most this often, in seconds. */
const REPATH_INTERVAL = 0.9;
/** Bots hold roughly this far apart. */
const SEPARATION_RADIUS = 1.8;
/** How long a bot will keep trying to reach a crate before giving up on it. */
const RESTOCK_TIMEOUT = 14;
/** And how long it then leaves the crate alone. */
const RESTOCK_COOLDOWN = 10;

/**
 * One NPC paintballer: navigation, a small behaviour state machine, and aim.
 *
 * Bots move kinematically along navgrid paths rather than through a character
 * controller. The grid already guarantees every cell is standable and every
 * edge is climbable, so a full controller would re-derive, per frame, a fact
 * the pathfinder established once. Their capsule is still a real collider, so
 * paintballs hit them exactly as they hit the player.
 */
export class Bot {
  readonly id: string;
  readonly personality: Personality;
  readonly character: Character;

  state: BotState = 'wander';
  readonly position = new Vector3();
  yaw = 0;

  private readonly velocity = new Vector3();
  private readonly body: RapierNS.RigidBody;
  readonly collider: RapierNS.Collider;

  private path: Vector3[] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  private stateTimer = 0;
  private reactionTimer = 0;
  private fireCooldown = 0;
  private target: BotTarget | null = null;
  private lastSeenTargetAt = -Infinity;
  /** Elapsed time before which this bot will not try for a crate again. */
  private restockBlockedUntil = -Infinity;
  /**
   * The crate this errand is for, held for as long as the errand lasts.
   *
   * Latched rather than resolved per step. Re-asking "which crate is nearest"
   * every step makes a bot standing between two of them dither on the spot,
   * and it repaths to a new target every time the answer flips. Dropped when
   * somebody else takes it — see `isCrateLive`.
   */
  private restockTarget: LootCrate | null = null;

  private readonly desired = new Vector3();
  private readonly eye = new Vector3();
  private readonly toTarget = new Vector3();
  private readonly aimDirection = new Vector3();
  private readonly muzzle = new Vector3();
  private readonly aimRight = new Vector3();
  private readonly aimUp = new Vector3();
  private readonly forward = new Vector3();

  private readonly animation: AnimationInput = {
    speed: 0,
    runSpeed: playerConfig.sprintSpeed,
    grounded: true,
    crouching: false,
    aiming: false,
    verticalVelocity: 0,
    moveLocalX: 0,
    moveLocalY: 1,
    aimPitch: 0,
  };

  constructor(
    id: string,
    personality: Personality,
    character: Character,
    spawn: Vector3,
    ctx: GameContext,
    /**
     * Shared, lifetime-stable state, so these are constructor arguments rather
     * than two more parameters on `fixedUpdate` — which already takes six.
     */
    private readonly match: MatchState,
    private readonly loot: LootState,
  ) {
    this.id = id;
    this.personality = personality;
    this.character = character;
    this.position.copy(spawn);

    const halfHeight = playerConfig.height / 2 - playerConfig.radius;
    this.body = ctx.physics.w.createRigidBody(
      ctx.physics.api.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.x,
        spawn.y + playerConfig.height / 2,
        spawn.z,
      ),
    );
    this.collider = ctx.physics.w.createCollider(
      ctx.physics.api.ColliderDesc.capsule(halfHeight, playerConfig.radius),
      this.body,
    );
    character.attachCollider(this.collider);
  }

  /**
   * Chest height, used as both an aim point and an eye position.
   * Returns a shared scratch vector — copy it if you need to keep it.
   */
  get chest(): Vector3 {
    return this.eye.set(this.position.x, this.position.y + 1.25, this.position.z);
  }

  /**
   * Puts this bot back where it started, for a fresh round.
   *
   * Everything derived from where it *was* has to go with it: a path across the
   * park from the old position walks the bot straight back to the fight that
   * just ended, and a retained target makes it open fire on someone it can no
   * longer see.
   */
  respawn(spawn: Vector3): void {
    this.position.copy(spawn);
    this.body.setTranslation(
      { x: spawn.x, y: spawn.y + playerConfig.height / 2, z: spawn.z },
      true,
    );
    this.velocity.set(0, 0, 0);
    this.path = [];
    this.pathIndex = 0;
    this.target = null;
    this.state = 'wander';
    this.stateTimer = 0;
    this.repathTimer = 0;
    this.lastSeenTargetAt = -Infinity;
    this.restockBlockedUntil = -Infinity;
    this.restockTarget = null;
  }

  /** Called when this bot is hit, to make it react. */
  onHit(rng: Rng): void {
    this.state = 'startled';
    this.stateTimer = rng.range(0.9, 1.8);
    this.path = [];
  }

  /** Called when this bot lands a hit, so it can celebrate. */
  onScored(rng: Rng): void {
    if (rng.bool(this.personality.tauntChance)) {
      this.character.animator.triggerTaunt();
    }
  }

  fixedUpdate(
    dt: number,
    ctx: GameContext,
    nav: NavGrid,
    candidates: BotTarget[],
    others: Bot[],
    ballistics: BallisticsSystem,
  ): void {
    this.stateTimer -= dt;
    this.repathTimer -= dt;
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);

    this.sense(ctx, candidates);
    this.decide(ctx, nav, dt);
    this.act(dt, ctx, nav, others, ballistics);
  }

  // --- perception ----------------------------------------------------------

  /** Picks the nearest visible candidate, or keeps none. */
  private sense(ctx: GameContext, candidates: BotTarget[]): void {
    let best: BotTarget | null = null;
    let bestDistance = Infinity;
    const eye = this.chest;

    for (const candidate of candidates) {
      if (candidate.id === this.id) continue;
      const distance = eye.distanceTo(candidate.position);
      if (distance > this.personality.sightRange || distance >= bestDistance) continue;

      this.toTarget.subVectors(candidate.position, eye);
      const range = this.toTarget.length();
      if (range < 0.01) continue;
      this.toTarget.divideScalar(range);

      // Line of sight. Excluding our own collider is essential or every bot
      // sees only itself.
      const hit = ctx.physics.raycast(eye, this.toTarget, range - 0.35, this.collider);
      if (hit && hit.collider.handle !== candidate.collider?.handle) continue;

      best = candidate;
      bestDistance = distance;
    }

    this.target = best;
    if (best) this.lastSeenTargetAt = ctx.elapsed;
  }

  // --- decision ------------------------------------------------------------

  private decide(ctx: GameContext, nav: NavGrid, dt: number): void {
    const { rng } = ctx;

    if (this.state === 'startled') {
      this.reactionTimer = this.personality.reactionTime;
      if (this.stateTimer <= 0) this.enterWander(nav, rng);
      return;
    }

    // Paint before fighting. Checked after `startled` — being shot at while
    // fetching ammo should still make a bot scurry — and before targets,
    // because a bot with nothing to shoot has no business in `engage`: it would
    // stand there aiming and never fire, which reads as a stalled agent rather
    // than an empty one.
    if (this.state === 'restock' && this.stateTimer <= 0) {
      // Been trying too long: the crate is behind something the navgrid cannot
      // route around, or we are wedged. Give up for a while — without the
      // cooldown, `wantsRestock` is still true next step and the bot goes
      // straight back to failing at it.
      this.restockBlockedUntil = ctx.elapsed + RESTOCK_COOLDOWN;
      this.enterWander(nav, rng);
    } else if (this.wantsRestock(ctx)) {
      this.driveRestock(nav);
      return;
    } else if (this.state === 'restock') {
      // Topped up, or somebody else got there first.
      this.enterWander(nav, rng);
    }

    if (this.target && ammoOf(this.match, this.id) > 0) {
      this.reactionTimer = Math.max(0, this.reactionTimer - dt);
      if (this.state !== 'engage' && this.state !== 'reposition') {
        // Hesitate before committing, so bots don't snap onto targets.
        this.reactionTimer = this.personality.reactionTime;
        this.state = rng.next() < this.personality.aggression ? 'engage' : 'reposition';
        this.stateTimer = this.personality.engageDuration;
        this.path = [];
      }
      if (this.stateTimer <= 0) {
        // Alternate between standing ground and moving, so fights breathe.
        this.state = this.state === 'engage' ? 'reposition' : 'engage';
        this.stateTimer = this.personality.engageDuration;
        this.path = [];
      }
      return;
    }

    // Nothing in sight.
    if (this.state === 'engage' || this.state === 'reposition') {
      this.enterWander(nav, rng);
      return;
    }
    if (this.state === 'loiter') {
      if (this.stateTimer <= 0) this.enterWander(nav, rng);
      return;
    }
    // Wandering: on arrival, either loiter a while or pick a new errand.
    if (this.pathIndex >= this.path.length) {
      if (rng.bool(this.personality.idleChance)) {
        this.state = 'loiter';
        this.stateTimer = rng.range(2.0, 6.0);
        // Occasionally stretch or wave while idling — the flourish that makes a
        // bot read as a person taking a break rather than a stalled agent.
        if (rng.bool(this.personality.tauntChance * 0.5)) {
          this.character.animator.triggerTaunt();
        }
      } else {
        this.enterWander(nav, rng);
      }
    }
  }

  /**
   * Whether there is a crate worth walking to.
   *
   * Gated on range as well as on ammo. Bots read crate positions from the same
   * shared state the pickup check uses, so without the range test all six would
   * set off the instant one spawned and it would be gone before the player had
   * looked around. `sightRange` is generous enough that a bot which has
   * genuinely run dry will usually find one by wandering into range.
   */
  private wantsRestock(ctx: GameContext): boolean {
    if (ctx.elapsed < this.restockBlockedUntil) return false;
    if (ammoOf(this.match, this.id) >= matchConfig.botSeekAmmo) return false;
    const crate = this.currentCrate();
    if (!crate) return false;
    const notice = this.personality.sightRange * matchConfig.botLootSightScale;
    return this.position.distanceTo(crate.position) <= notice;
  }

  /**
   * The crate this bot is walking to, picking one if the errand is new and the
   * latched one has not been taken out from under it.
   */
  private currentCrate(): LootCrate | null {
    if (!isCrateLive(this.loot, this.restockTarget)) {
      this.restockTarget = nearestCrate(this.loot, this.position);
    }
    return this.restockTarget;
  }

  /**
   * Heads for the crate, repathing on a timer.
   *
   * Deliberately *only* on the timer, unlike `repositionAround`. There, running
   * out of path means the errand is finished and a new one is due; here the last
   * couple of metres are walked by `approachLoot` rather than by path, so an
   * exhausted path is the normal state on arrival. Repathing on it as well would
   * mean a full A* every step for a bot standing next to the crate — and every
   * step forever for one whose crate cannot be routed to at all, which is what
   * `RESTOCK_TIMEOUT` now catches.
   */
  private driveRestock(nav: NavGrid): void {
    const crate = this.currentCrate();
    if (!crate) return;
    const target = crate.position;

    const fresh = this.state !== 'restock';
    if (fresh) {
      this.state = 'restock';
      this.stateTimer = RESTOCK_TIMEOUT;
    }
    if (fresh || this.repathTimer <= 0) {
      const walkable = nav.nearestWalkable(target.x, target.z);
      this.setPath(walkable ? nav.findPath(this.position, walkable) : null);
    }
  }

  private enterWander(nav: NavGrid, rng: Rng): void {
    this.state = 'wander';
    this.stateTimer = 12;
    const destination = nav.randomWalkablePoint(rng);
    this.setPath(destination ? nav.findPath(this.position, destination) : null);
  }

  private setPath(path: Vector3[] | null): void {
    this.path = path ?? [];
    this.pathIndex = this.path.length > 1 ? 1 : 0;
    this.repathTimer = REPATH_INTERVAL;
  }

  // --- action --------------------------------------------------------------

  private act(
    dt: number,
    ctx: GameContext,
    nav: NavGrid,
    others: Bot[],
    ballistics: BallisticsSystem,
  ): void {
    const speedLimit = playerConfig.walkSpeed * this.personality.speed;
    this.desired.set(0, 0, 0);

    if (this.state === 'startled' && this.target) {
      // Scurry directly away — no pathfinding, it's a panic.
      this.desired
        .subVectors(this.position, this.target.position)
        .setY(0)
        .normalize()
        .multiplyScalar(speedLimit * 1.25);
    } else if (this.state === 'restock') {
      this.approachLoot(speedLimit);
    } else if (this.state === 'reposition' && this.target) {
      this.repositionAround(nav, ctx, speedLimit);
    } else if (this.state === 'engage' && this.target) {
      // Strafe rather than stand still, so a firefight has movement in it.
      this.toTarget.subVectors(this.target.position, this.position).setY(0);
      const range = this.toTarget.length();
      this.toTarget.normalize();
      const strafe = Math.sin(ctx.elapsed * 1.3 + this.yaw) * 0.7;
      this.desired
        .set(-this.toTarget.z, 0, this.toTarget.x)
        .multiplyScalar(strafe * speedLimit * 0.5);
      // Close the gap if we're a long way off, back off if we're on top of them.
      const ideal = 14;
      this.desired.addScaledVector(this.toTarget, clamp((range - ideal) * 0.3, -1, 1) * speedLimit * 0.5);
    } else {
      this.followPath(speedLimit);
    }

    this.applySeparation(others, speedLimit);
    this.integrate(dt, nav, speedLimit);
    this.aimAndFire(dt, ctx, ballistics);
    this.pose(dt);
  }

  /** Walks the current path, advancing as each waypoint is reached. */
  private followPath(speedLimit: number): void {
    if (this.pathIndex >= this.path.length) return;
    const waypoint = this.path[this.pathIndex]!;
    this.toTarget.subVectors(waypoint, this.position).setY(0);
    if (this.toTarget.length() < ARRIVE_RADIUS) {
      this.pathIndex++;
      return;
    }
    this.desired.copy(this.toTarget).normalize().multiplyScalar(speedLimit);
  }

  /**
   * Walks the path to the crate, then closes the last stretch by hand.
   *
   * The path cannot finish the job on its own: its final waypoint is a navgrid
   * cell centre, cells are 2m, and `followPath` considers a waypoint reached
   * from `ARRIVE_RADIUS` away — so a bot can run out of path while still
   * standing outside the 1.4m pickup radius, and stand there next to the paint
   * it came for.
   */
  private approachLoot(speedLimit: number): void {
    const crate = this.currentCrate();
    if (!crate) return;

    this.toTarget.subVectors(crate.position, this.position).setY(0);
    if (this.toTarget.length() > 2.5) {
      this.followPath(speedLimit);
      return;
    }
    this.desired.copy(this.toTarget).normalize().multiplyScalar(speedLimit * 0.8);
  }

  /** Picks a fresh vantage point at a sensible range from the target. */
  private repositionAround(nav: NavGrid, ctx: GameContext, speedLimit: number): void {
    if (this.pathIndex >= this.path.length || this.repathTimer <= 0) {
      const angle = ctx.rng.range(0, Math.PI * 2);
      const radius = ctx.rng.range(9, 18);
      const spot = new Vector3(
        this.target!.position.x + Math.cos(angle) * radius,
        0,
        this.target!.position.z + Math.sin(angle) * radius,
      );
      const walkable = nav.nearestWalkable(spot.x, spot.z);
      this.setPath(walkable ? nav.findPath(this.position, walkable) : null);
    }
    this.followPath(speedLimit);
  }

  /** Keeps bots from piling into one another. */
  private applySeparation(others: Bot[], speedLimit: number): void {
    for (const other of others) {
      if (other === this) continue;
      const dx = this.position.x - other.position.x;
      const dz = this.position.z - other.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > SEPARATION_RADIUS || distance < 1e-4) continue;
      const push = (SEPARATION_RADIUS - distance) / SEPARATION_RADIUS;
      this.desired.x += (dx / distance) * push * speedLimit;
      this.desired.z += (dz / distance) * push * speedLimit;
    }
  }

  /** Moves, sticks to the ground, and updates the physics body. */
  private integrate(dt: number, nav: NavGrid, speedLimit: number): void {
    const desiredSpeed = Math.hypot(this.desired.x, this.desired.z);
    if (desiredSpeed > speedLimit) {
      this.desired.multiplyScalar(speedLimit / desiredSpeed);
    }

    this.velocity.x = damp(this.velocity.x, this.desired.x, 9, dt);
    this.velocity.z = damp(this.velocity.z, this.desired.z, 9, dt);

    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.z * dt;

    // The navgrid is the authority on where a bot may stand. Refusing a step
    // into a blocked cell is cheaper and more reliable than resolving a
    // collision after the fact.
    if (nav.isWalkable(nextX, nextZ)) {
      this.position.x = nextX;
      this.position.z = nextZ;
    } else {
      // Try each axis alone, so a bot grazing a wall slides instead of sticking.
      if (nav.isWalkable(nextX, this.position.z)) this.position.x = nextX;
      else if (nav.isWalkable(this.position.x, nextZ)) this.position.z = nextZ;
      else this.velocity.set(0, 0, 0);
      this.path = [];
    }

    this.position.y = nav.groundAt(this.position.x, this.position.z);

    this.body.setNextKinematicTranslation({
      x: this.position.x,
      y: this.position.y + playerConfig.height / 2,
      z: this.position.z,
    });

    // Face the target when fighting, otherwise face where we're going.
    const facing = this.target
      ? Math.atan2(
          -(this.target.position.x - this.position.x),
          -(this.target.position.z - this.position.z),
        )
      : Math.hypot(this.velocity.x, this.velocity.z) > 0.2
        ? Math.atan2(-this.velocity.x, -this.velocity.z)
        : this.yaw;
    this.yaw = dampAngle(this.yaw, facing, 7, dt);
  }

  /**
   * Aims and fires.
   *
   * Paintballs arc, so the shot is lifted by the drop it will accumulate over
   * the flight. The error cone is then applied deliberately wide — bots that
   * never miss would make this a tense game, and it is not meant to be one.
   */
  private aimAndFire(dt: number, ctx: GameContext, ballistics: BallisticsSystem): void {
    // Bots keep wandering after the round ends — a park that freezes solid is a
    // worse thing to look at than one still going about its business — but
    // nobody scores after the whistle, so nobody shoots either.
    if (!isPlaying(this.match)) return;
    if (this.state !== 'engage' || !this.target) return;
    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      return;
    }
    if (this.fireCooldown > 0) return;

    // On the barrel, not in the chest: bots hold a marker out in front now, and
    // a ball leaving the middle of the ribcage reads wrong once you can see the
    // gun it should have come out of. Matches `AimSolver.computeMuzzle`, minus
    // its lateral term — the aim pose tucks the marker onto the centre line, so
    // a bot needs no shoulder offset to sit on its own barrel.
    this.muzzle
      .set(this.position.x, this.position.y + 1.18, this.position.z)
      .addScaledVector(this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 0.56);
    this.aimDirection.subVectors(this.target.position, this.muzzle);
    const range = this.aimDirection.length();
    if (range < 0.5) return;

    // Spent last, once this is definitely a shot: an early return past this
    // point would throw the round away without firing it.
    if (!consume(this.match, this.id)) return;

    // Ballistic lift: the drop over the flight time, added to the aim point.
    const flightTime = range / ballisticsConfig.muzzleSpeed;
    const drop = 0.5 * Math.abs(physicsConfig.gravity) * flightTime * flightTime;
    this.aimDirection.y += drop;
    this.aimDirection.normalize();

    // Error cone, widening with range.
    const errorRad = this.personality.aimErrorDeg * DEG2RAD * (0.6 + range / 40);
    const angle = ctx.rng.range(0, Math.PI * 2);
    const spread = Math.tan(errorRad) * Math.sqrt(ctx.rng.next());
    this.aimRight.set(-this.aimDirection.z, 0, this.aimDirection.x).normalize();
    this.aimUp.crossVectors(this.aimRight, this.aimDirection).normalize();
    this.aimDirection
      .addScaledVector(this.aimRight, Math.cos(angle) * spread)
      .addScaledVector(this.aimUp, Math.sin(angle) * spread)
      .normalize();

    ballistics.fire(this.muzzle, this.aimDirection, this.id, this.character.color, this.collider);
    this.character.animator.triggerShot();
    ctx.events.emit('shot:fired', {
      shooterId: this.id,
      color: this.character.color,
      origin: this.muzzle.clone(),
      direction: this.aimDirection.clone(),
    });

    this.fireCooldown = ballisticsConfig.fireInterval * ctx.rng.range(1.6, 3.4);
  }

  /**
   * Feeds the animator and moves the visual body.
   *
   * Skipped entirely once the round is over: the body has been reparented onto
   * the results stage, and writing a park position into it would drag the figure
   * off its plinth. The bot itself carries on wandering — its collider and
   * navigation are unaffected — it just no longer drives anything you can see.
   */
  private pose(_dt: number): void {
    if (!isPlaying(this.match)) return;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.animation.speed = speed;
    this.animation.aiming = this.state === 'engage' && this.target !== null;
    this.animation.crouching = this.state === 'loiter' && this.personality.name === 'camper';
    this.animation.aimPitch = 0;
    // Direction of travel in the body's own frame, so strafing reads correctly.
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const inv = speed > 0.001 ? 1 / speed : 0;
    this.animation.moveLocalX = (this.velocity.x * rightX + this.velocity.z * rightZ) * inv;
    this.animation.moveLocalY = (this.velocity.x * forwardX + this.velocity.z * forwardZ) * inv;

    this.character.setTransform(this.position, this.yaw);
  }

  get animationInput(): AnimationInput {
    return this.animation;
  }

  get hasTarget(): boolean {
    return this.target !== null;
  }

  get lastSeen(): number {
    return this.lastSeenTargetAt;
  }
}
