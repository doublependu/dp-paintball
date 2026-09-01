import { Group, Material, Mesh, BoxGeometry, SphereGeometry, Vector3 } from 'three';
import type { NavGrid } from '../ai/NavGrid';
import type { CharactersSystem } from '../character/CharactersSystem';
import { match as matchConfig, paintColors } from '../core/Config';
import { Rng } from '../core/Random';
import type { GameContext, System } from '../core/System';
import { createCelMaterial } from '../render/CelMaterial';
import { LOOT_SPOTS } from '../world/ParkLayout';
import { grant, type MatchState } from './MatchState';
import type { PlayerState } from './PlayerState';

/** One crate standing in the park. */
export interface LootCrate {
  /** Where it is. Owned by `LootSystem`; treat as read-only from outside. */
  readonly position: Vector3;
  /** Rounds it is holding. */
  rounds: number;
}

/**
 * Where the paint is, for anything that needs to go and get it.
 *
 * Bots read this directly rather than being told over the bus, because "is
 * there paint out there, and where" is a question they ask every step while
 * deciding what to do, not an event they react to once.
 *
 * A list rather than the single crate this used to hold. One crate is not a
 * fight over paint but a race for it: every bot reads this the instant a crate
 * appears, so the nearest one collects it and nobody else ever had a decision
 * to make. Only live crates are in here — a taken one is removed, not blanked,
 * so `crates.length` is the honest count of what is out there.
 */
export interface LootState {
  readonly crates: LootCrate[];
}

export function createLootState(): LootState {
  return { crates: [] };
}

/** The crate closest to `from`, or null when the park is bare. */
export function nearestCrate(loot: LootState, from: Vector3): LootCrate | null {
  let best: LootCrate | null = null;
  let bestDistance = Infinity;
  for (const crate of loot.crates) {
    const distance = crate.position.distanceToSquared(from);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = crate;
  }
  return best;
}

/**
 * Whether a crate somebody is walking towards is still there.
 *
 * An errand takes seconds and anyone can take a crate during them, so a held
 * reference is a guess about the past until this says otherwise.
 */
export function isCrateLive(loot: LootState, crate: LootCrate | null): boolean {
  return crate !== null && loot.crates.includes(crate);
}

/** Every round sitting in a crate — half of the round-end rule. */
export function totalCrateRounds(loot: LootState): number {
  let total = 0;
  for (const crate of loot.crates) total += crate.rounds;
  return total;
}

/** Bob height and rate, so the crate reads as a pickup rather than scenery. */
const BOB_HEIGHT = 0.09;
const BOB_RATE = 1.7;
const SPIN_RATE = 0.5;

/**
 * A crate's own slot: its mesh, whatever it is holding, and its timer.
 *
 * The group is built once and hidden between lives rather than being rebuilt,
 * because a crate is four meshes and five materials and a round can cycle one
 * several times.
 */
interface CrateSlot {
  group: Group;
  /** The live crate, or null while this slot is waiting to respawn. */
  crate: LootCrate | null;
  /** Where the group sits before the bob is applied. */
  base: Vector3;
  /** Counts down to a respawn; only ever set when respawning is enabled. */
  respawnTimer: number;
  /** Which `LOOT_SPOTS` entry it last used, so it never picks that one twice. */
  lastSpotIndex: number;
}

/**
 * The paint crates: a few out at once, hidden somewhere different each time.
 *
 * Pickup is a distance check against seven characters on the fixed step, not a
 * sensor collider — a Rapier sensor plus an intersection query is a lot of
 * machinery to answer a question that costs seven subtractions, and a crate
 * deliberately has no collider at all so shots pass through it rather than
 * being blocked by a thing you are meant to walk into.
 */
export class LootSystem implements System {
  readonly name = 'loot';

  private readonly slots: CrateSlot[] = [];
  /** Held from init, so a crate can be placed outside the step. See respawn(). */
  private ctx?: GameContext;
  private readonly rng: Rng;

  constructor(
    private readonly match: MatchState,
    private readonly loot: LootState,
    private readonly playerState: PlayerState,
    private readonly characters: CharactersSystem,
    /**
     * Its own seed, never `ctx.rng`. That sequence has to stay reproducible
     * draw-for-draw — see the comment in `Character.takeHit` — and "a different
     * place each game" is the one thing here that must *not* be reproducible.
     */
    seed: number,
  ) {
    this.rng = new Rng(seed);
  }

  init(ctx: GameContext): void {
    if (this.match.sandbox) return;

    this.ctx = ctx;
    for (let i = 0; i < matchConfig.lootCrates; i++) {
      const group = this.buildCrate();
      group.visible = false;
      ctx.scene.add(group);
      this.slots.push({
        group,
        crate: null,
        base: new Vector3(),
        respawnTimer: 0,
        lastSpotIndex: -1,
      });
    }
    for (const slot of this.slots) this.spawn(slot, ctx);
  }

  /**
   * Puts every crate back immediately, at new hiding places.
   *
   * Public because a fresh round needs them and the match suite needs them; the
   * respawn *timers* are a different thing and stay private.
   */
  respawn(): void {
    const ctx = this.ctx;
    if (!ctx || this.match.sandbox) return;
    // Emptied outright rather than slot by slot. This system owns the list, and
    // a fresh round should end with exactly `lootCrates` crates in it whatever
    // the last one left behind — retiring only what the slots know about leaves
    // any stray entry standing and quietly grows the count round on round.
    this.loot.crates.length = 0;
    for (const slot of this.slots) {
      slot.crate = null;
      slot.group.visible = false;
      slot.respawnTimer = 0;
      this.spawn(slot, ctx);
    }
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    if (this.match.sandbox) return;

    for (const slot of this.slots) {
      if (slot.crate) continue;
      // A slot with nothing in it is only waiting if waiting is enabled at all;
      // at 0 a taken crate is gone for the rest of the round.
      if (matchConfig.lootRespawnSeconds <= 0) continue;
      slot.respawnTimer -= dt;
      if (slot.respawnTimer <= 0) this.spawn(slot, ctx);
    }

    this.checkPickup(ctx);
  }

  update(_dt: number, _alpha: number, ctx: GameContext): void {
    this.slots.forEach((slot, index) => {
      const group = slot.group;
      if (!group.visible) return;
      // Wall clock, not simulated time: this is decoration, and it should keep
      // turning at the same rate whatever the simulation is doing.
      //
      // Offset per slot, or two crates in one sightline bob and turn in
      // lockstep and read as one object drawn twice.
      const phase = ctx.elapsed + index * 0.83;
      group.position.y = slot.base.y + BOB_HEIGHT * (1 + Math.sin(phase * BOB_RATE)) * 0.5;
      group.rotation.y = phase * SPIN_RATE;
    });
  }

  /** Places one slot's crate at a fresh hiding place. */
  private spawn(slot: CrateSlot, ctx: GameContext): void {
    const nav = this.characters.navGrid;
    if (!nav) return;

    const spot = this.pickSpot(nav, slot);
    if (!spot) return;

    slot.base.copy(spot.point);
    slot.group.position.copy(slot.base);
    slot.group.visible = true;

    const crate: LootCrate = { position: slot.base.clone(), rounds: matchConfig.lootAmmo };
    slot.crate = crate;
    this.loot.crates.push(crate);

    ctx.events.emit('loot:spawned', {
      position: crate.position.clone(),
      rounds: crate.rounds,
    });
  }

  /** Takes a slot's crate out of the world and out of the shared list. */
  private retire(slot: CrateSlot): void {
    if (slot.crate) {
      const at = this.loot.crates.indexOf(slot.crate);
      if (at !== -1) this.loot.crates.splice(at, 1);
      slot.crate = null;
    }
    slot.group.visible = false;
  }

  /**
   * Chooses a hiding place and snaps it to standable ground.
   *
   * A spot whose nearest walkable cell is far away was authored somewhere that
   * is no longer ground — in the lake, or inside a prop — so it is skipped
   * rather than silently relocated to the edge of the water.
   */
  private pickSpot(nav: NavGrid, slot: CrateSlot): { point: Vector3; where: string } | null {
    // A random start walked circularly, rather than a shuffle: the first choice
    // is uniform, which is all that matters, and the fallback order is then
    // fixed so a round with several unusable spots still behaves predictably.
    const count = LOOT_SPOTS.length;
    const start = this.rng.int(0, count);
    for (let step = 0; step < count; step++) {
      const index = (start + step) % count;
      if (index === slot.lastSpotIndex && count > 1) continue;
      // Two crates in one hiding place is one crate as far as a player walking
      // past is concerned, and it wastes the only thing there are eleven of.
      if (this.slots.some((other) => other !== slot && other.crate && other.lastSpotIndex === index))
        continue;
      const spot = LOOT_SPOTS[index]!;
      const walkable = nav.nearestWalkable(spot.x, spot.z, 3);
      if (!walkable) continue;
      if (Math.hypot(walkable.x - spot.x, walkable.z - spot.z) > 4) continue;
      slot.lastSpotIndex = index;
      return { point: walkable, where: spot.where };
    }
    return null;
  }

  /** First character within reach of a crate takes the lot. */
  private checkPickup(ctx: GameContext): void {
    const radius = matchConfig.lootPickupRadius;

    for (const slot of this.slots) {
      const crate = slot.crate;
      if (!crate) continue;

      let takerId: string | null = null;
      if (this.playerState.position.distanceTo(crate.position) <= radius) {
        takerId = 'player';
      } else {
        for (const bot of this.characters.allBots) {
          if (bot.position.distanceTo(crate.position) <= radius) {
            takerId = bot.id;
            break;
          }
        }
      }
      if (!takerId) continue;

      const rounds = crate.rounds;
      const position = crate.position.clone();
      grant(this.match, takerId, rounds);

      ctx.events.emit('loot:taken', { characterId: takerId, rounds, position });

      this.retire(slot);
      slot.respawnTimer = matchConfig.lootRespawnSeconds;
    }
  }

  /**
   * A crate of paint: a box, a lid, and a few loose balls sitting on top.
   *
   * No collider. It is something to walk into, and a collider would make it
   * something to take cover behind and to block shots — neither of which a
   * pickup should do.
   */
  private buildCrate(): Group {
    const group = new Group();

    const body = new Mesh(
      new BoxGeometry(0.52, 0.36, 0.52),
      createCelMaterial({ color: 0x9c6f5c, rimStrength: 0.25 }),
    );
    body.position.y = 0.18;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const lid = new Mesh(
      new BoxGeometry(0.58, 0.07, 0.58),
      createCelMaterial({ color: 0x6f4b3c, rimStrength: 0.25 }),
    );
    lid.position.y = 0.39;
    lid.castShadow = true;
    group.add(lid);

    // Loose paintballs on the lid, in the match's own colours — the one part of
    // the crate that says what is in it from a distance.
    const ballGeometry = new SphereGeometry(0.07, 10, 8);
    const offsets: Array<[number, number]> = [
      [-0.12, -0.08],
      [0.1, -0.1],
      [0.02, 0.11],
      [0.15, 0.06],
    ];
    offsets.forEach(([x, z], index) => {
      const ball = new Mesh(
        ballGeometry,
        createCelMaterial({
          color: paintColors[index % paintColors.length]!,
          rimStrength: 0.5,
          rimPower: 2,
        }),
      );
      ball.position.set(x, 0.47, z);
      ball.castShadow = true;
      group.add(ball);
    });

    return group;
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.group.removeFromParent();
      slot.group.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        // The balls share one geometry, so this disposes it several times,
        // which three tolerates. The materials are one each.
        const material: Material | Material[] = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      });
    }
    this.slots.length = 0;
    this.loot.crates.length = 0;
  }
}
