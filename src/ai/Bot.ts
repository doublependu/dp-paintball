import type * as RapierNS from '@dimforge/rapier3d';
import { Vector3 } from 'three';
import {
  ballistics as ballisticsConfig,
  match as matchConfig,
  mural as muralConfig,
  paint as paintConfig,
  physics as physicsConfig,
  player as playerConfig,
} from '../core/Config';
import { FIXED_DT } from '../core/Config';
import { DEG2RAD, clamp, damp, dampAngle } from '../core/MathUtils';
import type { Rng } from '../core/Random';
import type { GameContext } from '../core/System';
import type { Character } from '../character/Character';
import type { AnimationInput } from '../character/CharacterAnimator';
import { displayName } from '../character/Names';
import { BallisticsSystem } from '../gameplay/Ballistics';
import type { MuralBoard, MuralSlot } from '../world/PaintScreen';
import { designsForBox, dotsFor, letterDesign } from './MuralDesigns';
import {
  isCrateLive,
  nearestCrate,
  type LootCrate,
  type LootState,
} from '../gameplay/LootSystem';
import { ammoOf, consume, isPlaying, type MatchState } from '../gameplay/MatchState';
import type { NavGrid } from './NavGrid';
import type { Personality } from './Personality';

export type BotState =
  | 'wander'
  | 'loiter'
  | 'engage'
  | 'reposition'
  | 'startled'
  | 'restock'
  | 'muralist';

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
/** Fixed steps the arc solver will fly before giving up on reaching the board. */
const MAX_SOLVE_STEPS = 90;

/**
 * The speed scale a mark on the board actually lands at.
 *
 * Not `maxSplatScale`, which is what a square hit at the muzzle would give.
 * These shots arrive from ten metres having lost some speed to drag, and
 * `emitImpact` scales what it reports by the angle of incidence — a painter
 * stands off-axis and below its own marks, so a real one measures about here.
 * Overestimating it spaces the drawing out until the strokes come apart.
 */
const TYPICAL_SPLAT_SCALE = 1.0;

const UP = new Vector3(0, 1, 0);
/** How close to its firing stance a painter has to be before it starts. */
const STANCE_RADIUS = 1.4;
/** Iterations of the elevation solve. Three lands inside a centimetre. */
const AIM_SOLVE_STEPS = 3;

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
  /**
   * When somebody was last close enough to count as a fight.
   *
   * Distinct from `lastSeenTargetAt`, and the distinction is what makes the
   * mural errand reachable at all. Measured over a natural round, a bot has a
   * visible target 90% of the time and one within `mural.breakOffRange` for a
   * fraction of that — the park is 336m across and `sightRange` is generous.
   * Gating art on "nobody in sight" made the errand a lottery: in one sampled
   * match the designated painter had four clear seconds all round, while an
   * undesignated bot on the other side of the park had two hundred.
   */
  private lastThreatenedAt = -Infinity;
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

  /**
   * The drawing in progress: where the marks go, how far through it is, and
   * where to stand while making them.
   *
   * Held rather than recomputed because the whole point is that the picture
   * comes out the way it was laid out — re-deriving it mid-errand from a bot
   * that has drifted half a metre would redraw the same sun somewhere else.
   */
  private muralSlot: MuralSlot | null = null;
  private muralName: string | null = null;
  private muralDots: Vector3[] = [];
  private muralIndex = 0;
  private readonly muralStance = new Vector3();
  /** Elapsed time before which this bot will not think about painting again. */
  private muralBlockedUntil = -Infinity;
  /**
   * A drawing broken off but not thrown away, and when the lease on it lapses.
   *
   * The difference between a side quest and a wasted trip. A painter that has
   * arrived and started keeps its slot, its dots and its index through a fight,
   * so it comes back and finishes the same heart rather than starting a new one
   * from nothing forty-five seconds later. See `pauseMural`.
   */
  private muralPaused = false;
  private muralResumeBy = -Infinity;
  /**
   * Drawings this bot has carried to the last mark.
   *
   * For the suite, and it exists because the alternative does not work: a
   * corner drawing is eight seconds of firing, so sampling `muralProgress` from
   * outside the sim catches it somewhere in the middle and never at the end.
   * A test that has to poll fast enough to see completion is a test that has to
   * run the round four times slower than it needs to.
   */
  private muralsFinished = 0;

  /**
   * Whether this bot is one of the round's designated painters.
   *
   * Rolled once at the whistle by `CharactersSystem`, one to three of the
   * roster, and nothing else ever enters `muralist`. See `mural.minPainters`.
   */
  isPainter = false;

  /**
   * Simulation time as of this step, for the handful of things that need it
   * outside `fixedUpdate` — `onHit` arrives from the hit router, which has no
   * clock to hand and no business acquiring one.
   */
  private now = 0;

  private readonly desired = new Vector3();
  private readonly eye = new Vector3();
  private readonly toTarget = new Vector3();
  private readonly aimDirection = new Vector3();
  private readonly muzzle = new Vector3();
  private readonly aimRight = new Vector3();
  private readonly aimUp = new Vector3();
  private readonly forward = new Vector3();
  // Scratch for the elevation solve, which runs once per mark and must not
  // allocate on the fixed step.
  private readonly solveAim = new Vector3();
  private readonly solveVelocity = new Vector3();
  private readonly solvePosition = new Vector3();
  private readonly solvePrevious = new Vector3();
  private readonly solveHit = new Vector3();

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
    /** The painting wall, or null on the test course, which has none. */
    private readonly board: MuralBoard | null,
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
    this.lastThreatenedAt = -Infinity;
    this.restockBlockedUntil = -Infinity;
    this.restockTarget = null;
    this.abandonMural();
    this.muralBlockedUntil = -Infinity;
    this.muralsFinished = 0;
  }

  /** Called when this bot is hit, to make it react. */
  onHit(rng: Rng): void {
    // Whatever it was drawing, it is not drawing it now. Standing still in the
    // open with a paintball marker pointed at a wall is exactly the moment
    // somebody comes and tags you, and that is the best thing about it.
    //
    // Paused rather than abandoned: being tagged is a reason to stop painting
    // and a bad reason to lose the picture. The lease runs for `resumeSeconds`,
    // which is long enough to deal with whoever turned up and come back.
    this.pauseMural();
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
    this.now = ctx.elapsed;
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
    if (best) {
      this.lastSeenTargetAt = ctx.elapsed;
      if (bestDistance <= muralConfig.breakOffRange) this.lastThreatenedAt = ctx.elapsed;
    }
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

    // A paused drawing whose lease has run out is simply an abandoned one, and
    // it has to be collected here rather than wherever the bot happens to be:
    // the slot is held against the board, so nobody else can use that corner
    // until this bot lets go of it.
    if (this.muralPaused && ctx.elapsed > this.muralResumeBy) {
      this.abandonMural();
      this.muralBlockedUntil = ctx.elapsed + muralConfig.retrySeconds;
    }

    // Painting. Checked before targets, because a painter that is actually in a
    // fight should stop painting and fight — which is what dropping through to
    // the clause below does — and after restock, because a bot low on paint has
    // a more pressing errand than art.
    if (this.state === 'muralist') {
      const done = this.muralIndex >= this.muralDots.length;
      // Out of paint is out of the errand. `paintNextMark` fails its `consume`
      // silently, and nothing else in this branch ends the state, so a painter
      // that ran dry at the board stood in front of it for the rest of the
      // round holding a corner nobody else could use.
      const dry = ammoOf(this.match, this.id) <= 0;
      if (done || dry || this.stateTimer <= 0) {
        if (done) this.muralsFinished++;
        this.abandonMural();
        // A cooldown either way, but not the same one. A finished drawing earns
        // the long wait — without it a painter turns straight round and starts
        // another, and the board fills with one bot's work while everyone else
        // fights. A drawing that timed out earns the short one: see
        // `mural.retrySeconds`.
        this.muralBlockedUntil =
          ctx.elapsed + (done ? muralConfig.cooldownSeconds : muralConfig.retrySeconds);
        if (!this.target) {
          this.enterWander(nav, rng);
          return;
        }
      } else if (this.threatened()) {
        // Somebody close enough to be a fight. Keep the picture, drop through.
        //
        // Out of `muralist` here rather than leaving it to the clauses below:
        // one of them — a target with no paint to shoot at it — changes no
        // state at all, and that left a paused painter still in `muralist`,
        // walking to a stance it would never fire a mark from.
        this.pauseMural();
        this.state = 'wander';
        this.path = [];
      } else {
        // A target seen across the meadow is not a fight, and breaking off for
        // one is what made the errand a wasted trip — see `mural.breakOffRange`.
        return;
      }
    } else if (this.canResumeMural(ctx)) {
      if (this.resumeMural(ctx, nav)) return;
    } else if (this.wantsToPaint(ctx)) {
      if (this.startMural(ctx, nav)) return;
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
    // Paint beats art, and the slot must not go with it: a bot that walks off
    // to a crate still holding half the board would keep it for the round.
    this.abandonMural();
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

  // --- painting -------------------------------------------------------------

  /**
   * Whether this is a good moment to go and draw something.
   *
   * Every clause is about keeping it a moment rather than a mode. Paint first:
   * a bot that spends its last eighty rounds on a sun then walks the park
   * looking for a crate has made the round worse. Quiet second: `lastSeen` is
   * the honest test, because `target` goes null the instant somebody steps
   * behind a tree and a bot that starts painting mid-firefight is a bot that
   * has stopped playing. Then range, then the cooldown from the last one.
   */
  private wantsToPaint(ctx: GameContext): boolean {
    if (!this.board) return false;
    // Designation first, and it is the cheapest clause as well as the one that
    // changes the behaviour most: at most three bots a round are painters, so
    // the rest of the roster never asks any of the questions below.
    if (!this.isPainter) return false;
    if (this.match.sandbox) return false;
    if (ctx.elapsed < this.muralBlockedUntil) return false;
    // Quiet means "nobody near", not "nobody in sight", and the two are very
    // different in a park this size: `sightRange` reaches most of the way
    // across Sheep Meadow, so a bot that refuses to paint while anything at all
    // is visible refuses all round. The bar is the same `breakOffRange` that
    // breaks a drawing off, which is the only consistent answer — a sighting
    // that would not interrupt the errand should not prevent it either.
    if (this.threatened()) return false;
    if (ctx.elapsed - this.lastThreatenedAt < muralConfig.quietSeconds) return false;
    if (ammoOf(this.match, this.id) < muralConfig.minAmmo) return false;
    // Deliberately no range test. There used to be one — sixty metres — and it
    // was the second most expensive line in the old design: the board is at the
    // far west of a park bots cross all round, and the median distance to it
    // over a measured match was eighty metres. For a bot that has been told
    // this is its errand, the walk across the park *is* the errand.
    return true;
  }

  /** Somebody close enough that this is a fight rather than a sighting. */
  private threatened(): boolean {
    if (!this.target) return false;
    return this.position.distanceTo(this.target.position) <= muralConfig.breakOffRange;
  }

  /**
   * Whether there is a paused drawing worth going back to.
   *
   * Deliberately not gated on `quietSeconds` the way starting one is: the
   * picture is already laid out and the stance already chosen, so the cost of
   * going back is a walk rather than a commitment, and the whole point of the
   * lease is that it is picked up promptly.
   */
  private canResumeMural(ctx: GameContext): boolean {
    if (!this.muralPaused || !this.muralSlot) return false;
    if (ctx.elapsed > this.muralResumeBy) return false;
    if (this.threatened()) return false;
    if (ammoOf(this.match, this.id) <= 0) return false;
    return this.muralIndex < this.muralDots.length;
  }

  /**
   * Claims a patch of board, decides what to draw on it, and sets off.
   *
   * Returns false when it could not start — both slots taken, no standable
   * ground in front of the board, no route to it — and blocks itself for a
   * while so it does not re-ask every step for the rest of the round.
   */
  private startMural(ctx: GameContext, nav: NavGrid): boolean {
    const board = this.board;
    if (!board) return false;

    const slot = board.claimSlot(this.id);
    if (!slot) {
      // Every corner taken. Ask again shortly rather than sitting out the full
      // wait, which is meant for a bot that has actually painted something.
      this.muralBlockedUntil = ctx.elapsed + muralConfig.retrySeconds * 0.5;
      return false;
    }

    // Where to stand: out along the board's normal from the middle of the slot,
    // swung off-axis so two painters are not in each other's line and the
    // drawing is not made from directly in front every time.
    board.worldPointAt(slot.u, slot.v, this.solveAim);
    const swing = ctx.rng.range(-1, 1) * muralConfig.offAxisDeg * DEG2RAD;
    const distance = ctx.rng.range(muralConfig.standoffMin, muralConfig.standoffMax);
    this.muralStance
      .copy(board.normal)
      .applyAxisAngle(UP, swing)
      .multiplyScalar(distance)
      .add(this.solveAim)
      .setY(0);

    const walkable = nav.nearestWalkable(this.muralStance.x, this.muralStance.z, 4);
    const path = walkable ? nav.findPath(this.position, walkable) : null;
    // No standable ground in front of the board, no route to it, or something
    // in the way of the canvas from there. Give the slot straight back: holding
    // one while failing to use it is how the board ends up with two painters
    // who never arrive and nobody else allowed to try.
    if (!walkable || !path || !this.canSeeBoard(ctx, walkable, board, slot)) {
      board.releaseSlot(this.id);
      this.muralBlockedUntil = ctx.elapsed + muralConfig.retrySeconds;
      return false;
    }
    this.muralStance.copy(walkable);

    this.muralSlot = slot;
    this.muralDots = this.layOutDrawing(board, slot, ctx.rng);
    this.muralIndex = 0;
    this.muralPaused = false;
    this.state = 'muralist';
    this.stateTimer = muralConfig.timeoutSeconds;
    this.setPath(path);
    return true;
  }

  /**
   * Whether the middle of the slot is actually visible from a standing
   * position at `from`.
   *
   * Stops short of the board itself, so the thing being looked for is a bench,
   * a lamp post or a tree between the two — the canvas is a collider like
   * anything else and would otherwise report itself as the obstruction.
   */
  private canSeeBoard(
    ctx: GameContext,
    from: Vector3,
    board: MuralBoard,
    slot: MuralSlot,
  ): boolean {
    board.worldPointAt(slot.u, slot.v, this.solveAim);
    this.eye.set(from.x, from.y + 1.18, from.z);
    this.toTarget.subVectors(this.solveAim, this.eye);
    const range = this.toTarget.length();
    if (range < 1) return false;
    this.toTarget.divideScalar(range);
    return !ctx.physics.raycast(this.eye, this.toTarget, range - 0.6, this.collider);
  }

  /**
   * Turns a design into the list of world points to shoot at, in drawing order.
   *
   * Spacing is derived from the size a splat actually lands at rather than
   * chosen: the marks have to overlap enough to read as a stroke, and the only
   * thing that decides how big one is, is the paint config.
   */
  private layOutDrawing(board: MuralBoard, slot: MuralSlot, rng: Rng): Vector3[] {
    const diameter =
      2 * paintConfig.baseSplatRadius * TYPICAL_SPLAT_SCALE * paintConfig.screenSplatScale;
    const spacing = diameter * muralConfig.dotSpacing;

    // Only what still reads in a box this size. The slots are corners now, and
    // the dense half of the catalogue closes up into a disc at 2.6m — see
    // `MuralDesign.minBox`.
    const box = Math.min(slot.widthMetres, slot.heightMetres);
    const initial = displayName(this.id).charAt(0);
    const signature = rng.bool(muralConfig.letterChance) ? letterDesign(initial) : null;
    const design =
      signature && signature.minBox <= box ? signature : rng.pick(designsForBox(box));
    this.muralName = design.name;

    const unit = dotsFor(
      design,
      slot.widthMetres,
      slot.heightMetres,
      spacing,
      muralConfig.maxDots,
    );
    return unit.map(([x, y]) =>
      board.worldPointAt(
        slot.u + (x - 0.5) * slot.halfU * 2,
        slot.v + (y - 0.5) * slot.halfV * 2,
        new Vector3(),
      ),
    );
  }

  /** Walks to the firing stance, then stands still. */
  private approachStance(speedLimit: number): void {
    this.toTarget.subVectors(this.muralStance, this.position).setY(0);
    const distance = this.toTarget.length();
    if (distance <= STANCE_RADIUS) return;
    if (distance > 2.5) {
      this.followPath(speedLimit);
      return;
    }
    // The path's last waypoint is a 2m cell centre, which is not close enough
    // to stand still and draw from — the same last stretch `approachLoot` walks
    // by hand, for the same reason.
    this.desired.copy(this.toTarget).normalize().multiplyScalar(speedLimit * 0.7);
  }

  /**
   * Puts the next mark of the drawing on the board.
   *
   * Nothing happens until the bot is standing where it meant to stand: a mark
   * fired on the way in is aimed correctly and lands correctly, and it is still
   * wrong, because the drawing is being made by someone walking past.
   */
  private paintNextMark(ctx: GameContext, ballistics: BallisticsSystem): void {
    if (this.fireCooldown > 0) return;
    if (this.muralIndex >= this.muralDots.length) return;
    if (this.position.distanceTo(this.muralStance) > STANCE_RADIUS + 0.6) return;

    const mark = this.muralDots[this.muralIndex]!;

    this.muzzle
      .set(this.position.x, this.position.y + 1.18, this.position.z)
      .addScaledVector(this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 0.56);

    if (!this.solveArc(mark)) return;
    if (!consume(this.match, this.id)) return;

    // A hand's worth of wobble, and no more. See `mural.aimErrorDeg`.
    const errorRad = muralConfig.aimErrorDeg * DEG2RAD;
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

    this.muralIndex++;
    this.fireCooldown = muralConfig.fireInterval * ctx.rng.range(0.85, 1.2);
  }

  /**
   * Solves the launch direction that actually lands on `mark`, into
   * `aimDirection`.
   *
   * The fighting aim lifts by `0.5 * g * t²` with `t = range / muzzleSpeed`,
   * which is fine against a person-sized capsule and useless against a
   * twenty-centimetre dot: it ignores drag, so it is wrong by several
   * centimetres — and wrong the same way every time, which would bend every
   * drawing downward by the same amount rather than merely scattering it.
   *
   * So this integrates the real flight model instead, through the one copy of
   * it that exists, and corrects the aim point by however far the ball missed.
   * Three passes converge well inside a centimetre. No physics queries: this is
   * arithmetic on `advance`, and it runs once per mark rather than per frame.
   */
  private solveArc(mark: Vector3): boolean {
    this.solveAim.copy(mark);

    for (let pass = 0; pass < AIM_SOLVE_STEPS; pass++) {
      this.aimDirection.subVectors(this.solveAim, this.muzzle);
      const range = this.aimDirection.length();
      if (range < 0.5) return false;
      this.aimDirection.divideScalar(range);

      // Fly it. The board is a vertical plane, so "has it arrived" is a
      // question about horizontal distance travelled, not about elapsed time.
      const targetFlat = Math.hypot(mark.x - this.muzzle.x, mark.z - this.muzzle.z);
      this.solveVelocity.copy(this.aimDirection).multiplyScalar(ballisticsConfig.muzzleSpeed);
      this.solvePosition.copy(this.muzzle);
      this.solveHit.copy(mark);

      let arrived = false;
      for (let step = 0; step < MAX_SOLVE_STEPS; step++) {
        this.solvePrevious.copy(this.solvePosition);
        BallisticsSystem.advance(this.solveVelocity, FIXED_DT);
        this.solvePosition.addScaledVector(this.solveVelocity, FIXED_DT);

        const flat = Math.hypot(
          this.solvePosition.x - this.muzzle.x,
          this.solvePosition.z - this.muzzle.z,
        );
        if (flat < targetFlat) continue;

        // Interpolate across the step that crossed the board, so the answer
        // does not quantise to the sim rate.
        const previousFlat = Math.hypot(
          this.solvePrevious.x - this.muzzle.x,
          this.solvePrevious.z - this.muzzle.z,
        );
        const span = flat - previousFlat;
        const t = span > 1e-6 ? (targetFlat - previousFlat) / span : 0;
        this.solveHit.lerpVectors(this.solvePrevious, this.solvePosition, t);
        arrived = true;
        break;
      }
      if (!arrived) return false;

      // Whatever it missed by, aim that much further the other way.
      this.solveAim.add(this.solveHit.subVectors(mark, this.solveHit));
    }

    this.aimDirection.subVectors(this.solveAim, this.muzzle).normalize();
    return true;
  }

  /**
   * Goes back to a drawing that was broken off, if the corner is still ours.
   *
   * Re-claiming is how the lease is checked: `claimSlot` hands a holder its own
   * slot back, so a different index means the board was wiped at a whistle and
   * this picture no longer exists.
   */
  private resumeMural(ctx: GameContext, nav: NavGrid): boolean {
    const board = this.board;
    const held = this.muralSlot;
    if (!board || !held) return false;

    const slot = board.claimSlot(this.id);
    const path = slot ? nav.findPath(this.position, this.muralStance) : null;
    if (!slot || slot.index !== held.index || !path) {
      this.abandonMural();
      this.muralBlockedUntil = ctx.elapsed + muralConfig.retrySeconds;
      return false;
    }

    this.muralPaused = false;
    this.state = 'muralist';
    // A fresh backstop for the resumed leg. `timeoutSeconds` is a guard against
    // a painter that cannot reach or finish, not a budget for the whole errand.
    this.stateTimer = muralConfig.timeoutSeconds;
    this.setPath(path);
    return true;
  }

  /**
   * Stops painting but keeps the picture: the slot, the marks and how far
   * through them this bot got, for `mural.resumeSeconds`.
   *
   * The half of `abandonMural` that is nearly always the right one. A drawing
   * interrupted at mark nine is nine marks of a heart on the board and a bot
   * that knows which nine; throwing that away is how the old design turned
   * every sighting into a wasted trip and a 45-second cooldown.
   */
  private pauseMural(): void {
    if (!this.muralSlot) return;
    this.muralPaused = true;
    this.muralResumeBy = this.now + muralConfig.resumeSeconds;
  }

  /** Drops the drawing and hands the slot back. Safe to call at any time. */
  private abandonMural(): void {
    if (this.muralSlot) this.board?.releaseSlot(this.id);
    this.muralSlot = null;
    this.muralName = null;
    this.muralDots = [];
    this.muralIndex = 0;
    this.muralPaused = false;
    this.muralResumeBy = -Infinity;
  }

  /** How far through its drawing a painter is, 0..1. For the suite. */
  get muralProgress(): number {
    if (this.muralDots.length === 0) return 0;
    return this.muralIndex / this.muralDots.length;
  }

  /** What it is drawing and how many marks that takes. For the suite. */
  get muralDesign(): string | null {
    return this.muralName;
  }

  get muralDotCount(): number {
    return this.muralDots.length;
  }

  /** Which patch of board it holds, or null. For the suite. */
  get muralSlotIndex(): number | null {
    return this.muralSlot?.index ?? null;
  }

  /** Whether it is holding a broken-off drawing to come back to. For the suite. */
  get muralOnHold(): boolean {
    return this.muralPaused;
  }

  /** How many drawings it has carried to the last mark. For the suite. */
  get muralsPainted(): number {
    return this.muralsFinished;
  }

  /**
   * Where the marks of the current drawing go, in world space.
   *
   * Exposed for the suite, which checks that the paint on the board actually
   * lands on the drawing rather than merely somewhere in the right half of it.
   * Live, not a copy: nothing outside should be holding these past the errand.
   */
  get muralMarks(): readonly Vector3[] {
    return this.muralDots;
  }

  private enterWander(nav: NavGrid, rng: Rng): void {
    // A paused drawing survives wandering — that is what makes it a pause. Its
    // lease is collected in `decide` when `resumeSeconds` runs out, not here.
    if (!this.muralPaused) this.abandonMural();
    this.state = 'wander';
    this.stateTimer = 12;
    const destination = this.wanderTarget(nav, rng);
    this.setPath(destination ? nav.findPath(this.position, destination) : null);
  }

  /**
   * Where a bot goes when it has nothing else to do.
   *
   * A random walkable cell for most of the roster, and the painting wall for a
   * designated painter — which is what turns the errand from a coincidence into
   * a plan, and it is the second half of dropping `noticeRange`. Removing the
   * range gate let a painter *consider* a board eighty metres away; this is what
   * gets it there.
   *
   * Both special cases exist because the walk was measured and it is the whole
   * difficulty. A painter breaks off whenever somebody comes within
   * `breakOffRange`, and in a six-bot park that is often: the couple of seconds
   * of quiet between one fight and the next used to be spent walking to a random
   * cell, so a bot fifty metres out would approach for three seconds, wander
   * away for four, and hover at the same distance for the whole round. Aiming
   * every quiet moment at the same place is what makes them add up.
   *
   * Not a beeline — the destination is a walkable cell near the board with a
   * bot's worth of scatter on it, so two painters converging do not stack up on
   * the same square metre, and a painter crossing the park still reads as a bot
   * going somewhere rather than one on rails.
   */
  private wanderTarget(nav: NavGrid, rng: Rng): Vector3 | null {
    // Holding a picture? Then the errand is still the destination.
    if (this.muralPaused && this.muralSlot) return this.muralStance;

    const board = this.board;
    if (
      board &&
      this.isPainter &&
      !this.match.sandbox &&
      this.now >= this.muralBlockedUntil &&
      ammoOf(this.match, this.id) >= muralConfig.minAmmo
    ) {
      const spread = muralConfig.standoffMax + 6;
      this.desired
        .copy(board.normal)
        .applyAxisAngle(UP, rng.spread(muralConfig.offAxisDeg * DEG2RAD * 2))
        .multiplyScalar(rng.range(muralConfig.standoffMin, spread))
        .add(board.centre)
        .setY(0);
      const near = nav.nearestWalkable(this.desired.x, this.desired.z, 5);
      if (near) return near;
    }

    return nav.randomWalkablePoint(rng);
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
    } else if (this.state === 'muralist') {
      this.approachStance(speedLimit);
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

    // Face the board when painting, the target when fighting, otherwise face
    // where we're going. The board case matters more than it looks and it wins
    // over the target: the muzzle is solved from the body's yaw, so a painter
    // facing anywhere else is shooting at the wall out of the corner of its
    // eye. It used to come second, which was harmless only because any target
    // at all ended the drawing — now a painter carries on through a distant
    // sighting, and turning to look at it would bend the picture.
    const board = this.state === 'muralist' ? this.board : null;
    const facing = board
      ? Math.atan2(-(board.centre.x - this.position.x), -(board.centre.z - this.position.z))
      : this.target
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
    if (this.state === 'muralist') {
      this.paintNextMark(ctx, ballistics);
      return;
    }
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
    this.animation.aiming =
      (this.state === 'engage' && this.target !== null) || this.state === 'muralist';
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
