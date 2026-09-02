import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  BoxGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import type { NavGrid } from '../ai/NavGrid';
import type { CharactersSystem } from '../character/CharactersSystem';
import { match as matchConfig, paintColors } from '../core/Config';
import { Rng } from '../core/Random';
import type { GameContext, System } from '../core/System';
import { createCelMaterial } from '../render/CelMaterial';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import { LOOT_SPOTS } from '../world/ParkLayout';
import { grant, type MatchState } from './MatchState';
import type { PlayerState } from './PlayerState';

/** One crate standing in the park. */
export interface LootCrate {
  /** Where it is. Owned by `LootSystem`; treat as read-only from outside. */
  readonly position: Vector3;
  /** Rounds it is holding. */
  rounds: number;
  /** The hiding place's written name, for anything that has to say it aloud. */
  readonly where: string;
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
 * The beacon: a shaft of light standing over every crate.
 *
 * A crate is 0.68m of brown box in a 130m park with hills, benches and a
 * woodland belt in it, and the bots read its position out of shared state the
 * instant it lands. The player was the only participant actually playing
 * hide-and-seek, which is not the game this is meant to be.
 *
 * Eight metres clears the benches, the lamp posts and most of the understorey.
 * The depth test stays *on* — a hill or the terrace still hides it — so finding
 * a crate is still a matter of going and looking, just not of luck.
 *
 * One colour for every crate, deliberately: a signal you can learn is worth
 * more than one that matches the paint inside.
 */
const BEACON_COLOR = 0xffd23f;
const BEACON_HEIGHT = 8;
const BEACON_BASE_RADIUS = 0.42;
const BEACON_TOP_RADIUS = 0.14;

/**
 * A crate's own slot: its mesh, whatever it is holding, and its timer.
 *
 * The group is built once and hidden between lives rather than being rebuilt,
 * because a crate is four meshes and five materials and a round can cycle one
 * several times.
 */
interface CrateSlot {
  group: Group;
  /** The shaft over it, held so the pulse costs no scene-graph lookup. */
  beacon: Mesh;
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
      const { group, beacon } = this.buildCrate();
      group.visible = false;
      ctx.scene.add(group);
      this.slots.push({
        group,
        beacon,
        crate: null,
        base: new Vector3(),
        respawnTimer: 0,
        lastSpotIndex: -1,
      });
    }
    for (const slot of this.slots) this.spawn(slot, ctx, false);
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
      this.spawn(slot, ctx, false);
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
      if (slot.respawnTimer <= 0) this.spawn(slot, ctx, true);
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
      // The beacon breathes rather than blinks. A hard flash reads as an alert
      // in a game that has nothing to be alarmed about.
      const material = slot.beacon.material as MeshBasicMaterial;
      material.opacity = 0.78 + 0.22 * Math.sin(phase * 1.1);
    });
  }

  /**
   * Places one slot's crate at a fresh hiding place.
   *
   * `announce` is false for the crates a round opens with and true for one that
   * arrives on a respawn timer. Three toasts stacking on top of each other at
   * the whistle is noise, and the whistle is the one moment a player is already
   * being told several things; a crate appearing thirty-five seconds into a
   * fight is genuinely news, and it is the round's pacing signal.
   */
  private spawn(slot: CrateSlot, ctx: GameContext, announce: boolean): void {
    const nav = this.characters.navGrid;
    if (!nav) return;

    const spot = this.pickSpot(nav, slot);
    if (!spot) return;

    slot.base.copy(spot.point);
    slot.group.position.copy(slot.base);
    slot.group.visible = true;

    const crate: LootCrate = {
      position: slot.base.clone(),
      rounds: matchConfig.lootAmmo,
      where: spot.where,
    };
    slot.crate = crate;
    this.loot.crates.push(crate);

    ctx.events.emit('loot:spawned', {
      position: crate.position.clone(),
      rounds: crate.rounds,
      where: crate.where,
      announce,
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
  private buildCrate(): { group: Group; beacon: Mesh } {
    const group = new Group();

    // Grown from 0.52. At the old size a crate read as a rock from twenty
    // metres, which is most of the park.
    const body = new Mesh(
      new BoxGeometry(0.68, 0.47, 0.68),
      createCelMaterial({ color: 0x9c6f5c, rimStrength: 0.25 }),
    );
    body.position.y = 0.235;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const lid = new Mesh(
      new BoxGeometry(0.76, 0.09, 0.76),
      createCelMaterial({ color: 0x6f4b3c, rimStrength: 0.25 }),
    );
    lid.position.y = 0.51;
    lid.castShadow = true;
    group.add(lid);

    // Loose paintballs on the lid, in the match's own colours — the one part of
    // the crate that says what is in it from a distance.
    const ballGeometry = new SphereGeometry(0.09, 10, 8);
    const offsets: Array<[number, number]> = [
      [-0.16, -0.1],
      [0.13, -0.13],
      [0.03, 0.14],
      [0.2, 0.08],
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
      ball.position.set(x, 0.62, z);
      ball.castShadow = true;
      group.add(ball);
    });

    const beacon = this.buildBeacon();
    group.add(beacon);

    return { group, beacon };
  }

  /**
   * The shaft of light over a crate.
   *
   * An open-ended cone, additively blended, fading out along its own height
   * through a per-vertex alpha rather than through a texture or a shader — the
   * geometry has two rings of vertices and the fade is linear, so a four-channel
   * colour attribute is the whole gradient.
   *
   * Three details that are all load-bearing:
   *
   * - **`NO_OUTLINE_LAYER`.** The NPR prepass swaps every visible mesh for a
   *   normal material and renders it, and a beacon in that buffer would come
   *   back inked and ambient-occluded like a solid post. The sky solves the same
   *   problem the same way: the prepass turns this layer off, the main camera
   *   leaves it on.
   * - **`depthWrite: false`, `depthTest: true`.** It is a glow, so it must not
   *   occlude anything — and it must still be occluded, or a crate behind the
   *   terrace advertises itself through solid stone.
   * - **No shadow.** A column of light casting a shadow is a column of smoke.
   */
  private buildBeacon(): Mesh {
    const geometry = new CylinderGeometry(
      BEACON_TOP_RADIUS,
      BEACON_BASE_RADIUS,
      BEACON_HEIGHT,
      10,
      1,
      true,
    );
    geometry.translate(0, BEACON_HEIGHT / 2, 0);

    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 4);
    const tint = new Color(BEACON_COLOR);
    for (let i = 0; i < position.count; i++) {
      // Bright and solid where it leaves the crate, gone by the top.
      const t = position.getY(i) / BEACON_HEIGHT;
      colors[i * 4] = tint.r;
      colors[i * 4 + 1] = tint.g;
      colors[i * 4 + 2] = tint.b;
      colors[i * 4 + 3] = 0.62 * Math.pow(1 - t, 1.4);
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 4));

    const beacon = new Mesh(
      geometry,
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    );
    beacon.castShadow = false;
    beacon.receiveShadow = false;
    beacon.layers.set(NO_OUTLINE_LAYER);
    beacon.position.y = 0.45;
    return beacon;
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
