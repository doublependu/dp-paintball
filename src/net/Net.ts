import { Vector3 } from 'three';
import type { LogEntry, Member, P3P2, Room } from '@p3p2/client';
import { Smooth } from '@p3p2/client/smooth';
import type { Bot } from '../ai/Bot';
import type { Character } from '../character/Character';
import type { CharacterHit, CharactersNet, CharactersSystem } from '../character/CharactersSystem';
import { setFriendNames } from '../character/Names';
import { match as matchConfig, paintColors, player as playerConfig } from '../core/Config';
import { Rng } from '../core/Random';
import type { GameContext, System } from '../core/System';
import type { BallisticsSystem } from '../gameplay/Ballistics';
import type { LootNet, LootSystem } from '../gameplay/LootSystem';
import { grant, isPlaying, type MatchState } from '../gameplay/MatchState';
import type { MatchNet, MatchSystem } from '../gameplay/MatchSystem';
import type { PlayerState } from '../gameplay/PlayerState';
import type { WeaponSystem } from '../gameplay/Weapon';
import type { PaintSystem } from '../paint/PaintSystem';
import type { SplatAtlas } from '../paint/SplatAtlas';
import type { PauseSystem } from '../ui/PauseSystem';
import type { PaintScreen } from '../world/PaintScreen';
import { NameTags } from './NameTags';
import { SPLAT_BYTES, readSplat, readTag, writeSplat, writeTag, type Splat, type TagRecord } from './records';
import { Reader, Writer, fromBase64, num, toBase64 } from './wire';

/**
 * The park as a p3p2 room: friends in the bots' places.
 *
 * A p3p2 server relays and remembers, and knows nothing of paintball. This is what the
 * game knows of a room, and the one place it talks to one:
 *
 * - **Places.** The park has seven: the first player's, and the six bots'. The host
 *   says who is in which (`seats`, a room value: member id to place). A bot fills every
 *   place nobody is in, except the first, which is then empty.
 * - **Ids.** Every page calls its own player `player`, and the game is written that way.
 *   On the wire a figure is its place. A page in place k swaps two ids: `player` is place
 *   k, and the bot whose place that was stands for place 0. Everything else is as alone.
 * - **Who runs what.** Each page its own player, sent as presence. The host's page the
 *   bots, the crates, and the round's end; ten reports a second (`hr`). Every page sends
 *   its shots (`sh`), and flies everybody's.
 * - **What leaves a mark** goes into the room's log, so that it is the same everywhere
 *   and whoever comes later gets it: splats on the park and the board, tags on people,
 *   and the round's start and end. See `apply`.
 */

/** A figure that a room can put somebody in: its id alone, and its team colour. */
export interface Place {
  id: string;
  colorIndex: number;
}

export interface NetParts {
  p3p2: P3P2;
  /** Place 0 is the first player's, `player`; then the bots, in the order they were built. */
  places: readonly Place[];
  events: GameContext['events'];
  container: HTMLElement;
  state: PlayerState;
  /** What moves this player's body: to put it at its place's start. */
  player: { teleport(feet: Vector3): void };
  characters: CharactersSystem;
  ballistics: BallisticsSystem;
  weapon: WeaponSystem;
  paint: PaintSystem;
  screen: PaintScreen | null;
  atlas: SplatAtlas;
  match: MatchState;
  matchSystem: MatchSystem;
  lootSystem: LootSystem;
  pause: PauseSystem;
}

/** The round as the room's log has it: started at `at` (server time), for `d` seconds. */
interface Round {
  id: number;
  at: number;
  d: number;
  over?: 'time' | 'ammo';
}

/** What the log's snapshot holds. See `save`. */
interface Saved {
  v: 1;
  m: Round | null;
  /** Every splat kept, as bytes; and from which of them on they are this round's. */
  p: string;
  f: number;
  /** This round's tags, and the places emptied for a new player, in order. */
  t: string;
  /** How many splats the room keeps. */
  k: number;
}

/** Presence: where a friend is. Places in cm, angles in mrad, flags as `Bot.drive`. */
interface Seen {
  p: number[];
  f: number;
  a: number;
}

const REPORT_MS = 100;
const SHOTS_MS = 50;
const PAINT_MS = 250;
const PRESENCE_MS = 50;
/**
 * A shot older than this when it comes is not flown at all: from the marker, that late, it
 * would land long after its paint, and a bot's ball could tag a friend seconds after it
 * was fired. What it did comes in the log all the same.
 */
const MAX_AGE_MS = 500;
/** The park's paint the log keeps, newest last: about what `PaintSystem` keeps itself. */
const MAX_SPLATS = 2000;
/** And the least it keeps, on a server whose log for a room is small. */
const MIN_SPLATS = 100;
const GRACE_MS = playerConfig.hitInvulnSeconds * 1000;
const ASK_MS = 500;
/**
 * How long a frame may spend painting from the log. A splat on the park is cut out of the
 * mesh it lands on, the ground's being 51,000 triangles, and a few milliseconds each: a
 * page that comes into a painted park paints it over some seconds rather than all at once.
 */
const PAINT_BUDGET_MS = 6;
/** A record in `tags` that is not a tag: a place emptied for somebody new. */
const EMPTIED = 255;

export class Net implements System, CharactersNet, MatchNet, LootNet {
  readonly name = 'net';

  room: Room | null = null;
  /** This page's place in the room's park, -1 while it has none. Alone it is 0. */
  seat = 0;
  /** Member id to place, as the host last said. */
  private seats = new Map<number, number>();
  /** Place to the member in it, for the members who are in the room. */
  private people = new Map<number, Member>();

  /** The room's round, as its log has it, or null before the first. */
  private round: Round | null = null;
  /** Every splat the log has, oldest first, and where this round's begin. */
  private splats: Uint8Array[] = [];
  private roundFrom = 0;
  /** This round's tags and emptied places, in the log's order, as bytes. */
  private tags: Uint8Array[] = [];
  /** When each place was last tagged, for the grace second. */
  private lastTag = new Map<number, number>();
  /** When this page last judged a tag on each place: none is sent inside the grace second. */
  private sentTag = new Map<number, number>();
  private endAsked = -1;
  /**
   * How many splats a snapshot holds. The room's log has a cap that the server does not
   * say; a snapshot over it is refused (`too-big`), and the host then keeps less.
   */
  private keep = MAX_SPLATS;
  private shrunkAt = -Infinity;
  private askedAt = new Map<number, number>();

  private readonly friends = new Smooth<number>({ angles: [3], delay: 100, jump: 4 });
  private readonly bots = new Smooth<number>({ angles: [3], delay: 160, jump: 4 });
  /** Velocities, flags and ammo: the last word, not smoothed. */
  private readonly motion = new Map<number, { vx: number; vy: number; vz: number; f: number; pitch: number }>();

  private readonly shotsOut = new Writer(512);
  private shotsFrom = 0;
  private shotsCount = 0;
  private readonly splatsOut: Uint8Array[] = [];
  private readonly report = new Writer(256);
  private sinceReport = 0;
  private sinceShots = 0;
  private sincePaint = 0;
  private sincePresence = 0;
  /** Whether a report from the host has come since this page came into the room. */
  private reported = false;

  private readonly rng = new Rng(Date.now() >>> 0);
  /** Paint from the log still to go on, oldest first; `front` where a round began. */
  private readonly toPaint: Array<Splat | 'front'> = [];
  private readonly tagsLayer: NameTags;
  private ctx?: GameContext;
  private offs: Array<() => void> = [];

  constructor(private readonly parts: NetParts) {
    const { p3p2, events } = parts;
    this.tagsLayer = new NameTags(parts.container);
    // Subscribed before the paint is, so that a splat this page judges has its shape
    // chosen here, where it goes into the log, and is painted with that one.
    events.on('hit:world', (impact) => this.judged(impact));
    events.on('shot:fired', (shot) => this.fired(shot));

    parts.characters.net = this;
    parts.matchSystem.net = this;
    parts.lootSystem.net = this;
    parts.ballistics.judge = (shooter, target) => this.judge(shooter, target);
    parts.pause.friends = () => p3p2.open();
    parts.pause.shared = () => this.room !== null;
    setFriendNames((id) => this.people.get(this.placeOf(id))?.name);

    p3p2.on('room', (room) => this.enter(room));
    p3p2.on('leave', () => this.left());
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
  }

  // ---- what the game asks -------------------------------------------------------------

  get active(): boolean {
    return this.room !== null;
  }

  get isHost(): boolean {
    return this.room?.isHost ?? true;
  }

  /** The figure whose start is this player's. */
  get home(): string {
    return this.parts.places[Math.max(0, this.seat)]!.id;
  }

  /** The id this page gives the figure in place `p`, or '' for one it has no figure for. */
  idOf(p: number): string {
    const k = this.seat;
    if (p === k) return 'player';
    if (p === 0) return k > 0 ? this.parts.places[k]!.id : '';
    return this.parts.places[p]?.id ?? '';
  }

  /** The place of the figure this page calls `id`, or -1. */
  placeOf(id: string): number {
    if (id === 'player') return this.seat;
    const p = this.parts.places.findIndex((place) => place.id === id);
    return p > 0 && p === this.seat ? 0 : p;
  }

  runs(id: string): boolean {
    if (!this.room) return true;
    const p = this.placeOf(id);
    return id !== 'player' && p > 0 && this.room.isHost && !this.people.has(p);
  }

  targetable(id: string): boolean {
    if (!this.room) return true;
    if (id === 'player') return this.seat >= 0;
    const p = this.placeOf(id);
    if (p < 0) return false;
    const member = this.people.get(p);
    return member ? member.state === 'here' : p > 0;
  }

  /**
   * Whether this page judges what a ball did. A friend's page judges its own balls; a
   * bot's ball is judged by the page of the friend it reaches, or by the host's.
   */
  judge(shooter: string, target: string | undefined): boolean {
    if (!this.room) return true;
    if (shooter === 'player') return this.seat >= 0;
    const s = this.placeOf(shooter);
    if (s < 0 || this.people.has(s)) return false;
    if (target === undefined) return this.room.isHost;
    if (target === 'player') return true;
    const t = this.placeOf(target);
    return this.room.isHost && t >= 0 && !this.people.has(t);
  }

  timeLeft(): number {
    const round = this.round;
    if (!round || !this.room) return matchConfig.durationSeconds;
    if (round.over) return 0;
    return Math.max(0, round.d - (this.room.now() - round.at) / 1000);
  }

  over(reason: 'time' | 'ammo'): void {
    const round = this.round;
    if (!this.room?.isHost || !round || round.over || this.endAsked === round.id) return;
    this.endAsked = round.id;
    this.room.log.submit({ k: 'e', id: round.id, r: reason });
  }

  again(): void {
    const room = this.room;
    if (!room || !this.round?.over) return;
    if (room.isHost) this.startRound();
    else room.send('again', { id: this.round.id }, { to: 'host' });
  }

  ask(slot: number): void {
    const room = this.room;
    if (!room || this.seat < 0) return;
    const now = performance.now();
    if (now - (this.askedAt.get(slot) ?? -Infinity) < ASK_MS) return;
    this.askedAt.set(slot, now);
    room.send('take', { i: slot, s: this.parts.lootSystem.spots[slot] }, { to: 'host' });
  }

  /** A hit this page judged, for the room's log. */
  tag(hit: CharacterHit, target: Character): void {
    const room = this.room;
    const t = this.placeOf(hit.targetId);
    const s = this.placeOf(hit.shooterId);
    if (!room || t < 0 || s < 0) return;
    const at = room.now();
    const last = Math.max(this.lastTag.get(t) ?? -Infinity, this.sentTag.get(t) ?? -Infinity);
    if (at < last + GRACE_MS) return;
    this.sentTag.set(t, at);
    const tag = target.aimTag(hit.point, hit.normal, hit.impactSpeed, this.rng, this.parts.atlas.variants);
    const w = new Writer(32);
    writeTag(w, { target: t, shooter: s, at, tag });
    room.log.submit({ k: 't', d: toBase64(lengthPrefixed(w.bytes())) });
  }

  // ---- in and out of a room -----------------------------------------------------------

  private enter(room: Room): void {
    if (room === this.room) return;
    if (this.room) this.left();
    this.room = room;
    this.reported = false;
    const { match } = this.parts;
    // Alone a pause stops the round; in a room it holds this player only.
    if (match.phase === 'paused') {
      match.phase = 'playing';
      match.held = true;
    }
    // No place until the host gives one: in the meantime this player only watches.
    this.reseat(-1);
    this.applySeats(room.retained('seats'));

    this.offs.push(
      room.on('seats', (value, _from, meta) => {
        if (meta.retained) this.applySeats(value);
      }),
      room.on('hr', (data) => this.onReport(data)),
      room.on('sh', (data) => this.onShots(data)),
      room.on('take', (data, from) => this.onTake(data, from)),
      room.on('give', (data) => this.onGive(data)),
      room.on('again', (data) => {
        if (room.isHost && this.round?.over && num((data as { id?: unknown })?.id, -1) === this.round.id) this.startRound();
      }),
      room.on('member-join', () => this.reconcile()),
      room.on('member-leave', (member) => {
        this.friends.delete(this.seats.get(member.id) ?? -1);
        this.reconcile();
      }),
      room.on('host-change', () => this.roles()),
      room.on('error', (problem) => this.refused(problem.code)),
      room.presence.on((member, value) => this.onPresence(member, value)),
    );
    // A friend who stands still says where once: what came before this page listened.
    this.readPresence();

    void room.log
      .open({
        load: (state) => this.load(state),
        apply: (op, entry) => this.apply(op, entry),
        save: () => this.save(),
      })
      .then(() => {
        if (this.room !== room) return;
        this.roles();
      });
  }

  private left(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.room = null;
    this.seat = 0;
    this.seats.clear();
    this.people.clear();
    this.friends.clear();
    this.bots.clear();
    this.motion.clear();
    this.round = null;
    this.splatsOut.length = 0;
    this.shotsCount = 0;
    this.tagsLayer.clear();
    const { characters, match } = this.parts;
    match.benched = false;
    for (const bot of characters.allBots) {
      bot.setPresent(true);
      bot.resetMind();
    }
    characters.playerCharacter?.setPresent(true);
    this.recolor();
    // The room's paint stays on the park; the round is the page's own again.
    this.parts.matchSystem.restart();
  }

  /** What the host does: seats, the bots, the crates, and the round. Called whenever the host may have changed. */
  private roles(): void {
    const room = this.room;
    if (!room) return;
    if (room.isHost) {
      this.reconcile();
      for (const bot of this.parts.characters.allBots) {
        if (this.runs(bot.id)) bot.resetMind();
      }
      this.parts.lootSystem.adopt();
      if (!this.round) this.startRound();
    }
  }

  /**
   * The server refused something too big: on the host, a snapshot larger than the room's
   * log may be, or an op that did not fit because the log is full. Either way the cure is
   * a smaller snapshot, with the oldest paint left out of it (it stays on the park).
   */
  private refused(code: string): void {
    const room = this.room;
    if (code !== 'too-big' || !room?.isHost) return;
    const now = performance.now();
    if (now - this.shrunkAt < 2000) return;
    this.shrunkAt = now;
    const keep = Math.max(MIN_SPLATS, Math.floor(Math.min(this.keep, this.splats.length) * 0.6));
    // The snapshot first, to make room in the log; then the word to every page to keep as few, so
    // that all of them keep the same paint from here on.
    this.keep = keep;
    this.trim();
    if (room.log.snapshot()) room.log.submit({ k: 'k', n: keep });
  }

  /** Forgets the oldest splats past what a snapshot may hold. */
  private trim(): void {
    const extra = this.splats.length - this.keep;
    if (extra <= 0) return;
    this.splats.splice(0, extra);
    this.roundFrom = Math.max(0, this.roundFrom - extra);
  }

  private startRound(): void {
    this.room?.log.submit({ k: 's', id: (this.round?.id ?? 0) + 1, d: matchConfig.durationSeconds });
  }

  // ---- places ------------------------------------------------------------------------

  /** The host gives every member a place, the lowest free one, and keeps the ones they have. */
  private reconcile(): void {
    const room = this.room;
    if (!room?.isHost) return;
    const next: Record<string, number> = {};
    const used = new Set<number>();
    for (const m of room.members) {
      const p = this.seats.get(m.id);
      if (p === undefined || used.has(p)) continue;
      next[m.id] = p;
      used.add(p);
    }
    for (const m of room.members) {
      if (next[m.id] !== undefined) continue;
      for (let p = 0; p < this.parts.places.length; p++) {
        if (used.has(p)) continue;
        next[m.id] = p;
        used.add(p);
        break;
      }
    }
    const same =
      Object.keys(next).length === this.seats.size &&
      Object.entries(next).every(([id, p]) => this.seats.get(Number(id)) === p);
    if (!same) room.send('seats', next, { retain: 'room' });
  }

  private applySeats(value: unknown): void {
    const room = this.room;
    if (!room) return;
    const before = new Map(this.people);
    this.seats.clear();
    if (value && typeof value === 'object') {
      for (const [id, p] of Object.entries(value as Record<string, unknown>)) {
        const place = num(p, -1);
        if (place >= 0 && place < this.parts.places.length) this.seats.set(Number(id), place);
      }
    }
    this.people.clear();
    for (const m of room.members) {
      const p = this.seats.get(m.id);
      if (p !== undefined && m.id !== room.self.id) this.people.set(p, m);
    }
    const seat = this.seats.get(room.self.id) ?? -1;
    if (seat !== this.seat) this.reseat(seat);
    if (seat >= 0) this.people.set(seat, room.self);

    // A place that changed hands mid-round starts again at zero, by the host's word.
    if (room.isHost && this.round && !this.round.over) {
      for (let p = 0; p < this.parts.places.length; p++) {
        if (before.get(p)?.id !== this.people.get(p)?.id && (before.has(p) || this.people.has(p))) {
          room.log.submit({ k: 't', d: toBase64(lengthPrefixed(Uint8Array.of(EMPTIED, p))) });
        }
      }
    }
    // A friend's last word on where they are, for a place this page has just learnt of.
    this.readPresence();
    // A bot that takes a place back carries on from where its friend left it.
    for (const [p, m] of before) {
      if (!this.people.has(p) && m.id !== room.self.id) {
        this.friends.delete(p);
        this.botAt(p)?.resetMind();
      }
    }
    this.showPlaces();
  }

  /** This page's own place changed: the ids swap, and the colours follow. */
  private reseat(seat: number): void {
    this.seat = seat;
    this.parts.match.benched = seat < 0;
    this.friends.clear();
    this.bots.clear();
    for (const bot of this.parts.characters.allBots) bot.resetMind();
    this.recolor();
    this.parts.characters.playerCharacter?.setPresent(seat >= 0);
    // The figures stand for other places now: their scores and paint are worked out again.
    this.retag();
    if (seat >= 0 && this.round && !this.round.over) {
      const spawn = this.parts.characters.spawnOf(this.home);
      if (spawn) this.parts.player.teleport(spawn);
    }
  }

  /** Who is shown: an empty first place has nobody in it. */
  private showPlaces(): void {
    for (const bot of this.parts.characters.allBots) {
      const p = this.placeOf(bot.id);
      const present = p !== 0 || this.people.has(0);
      bot.setPresent(present);
      if (!present) this.parts.match.ammo.set(bot.id, 0);
    }
  }

  private recolor(): void {
    const { characters, places, weapon } = this.parts;
    const seat = Math.max(0, this.seat);
    characters.playerCharacter?.recolor(places[seat]!.colorIndex);
    for (const bot of characters.allBots) {
      const p = this.placeOf(bot.id);
      if (p >= 0) bot.character.recolor(places[p]!.colorIndex);
    }
    weapon.color = characters.playerCharacter?.color ?? weapon.color;
  }

  private botAt(p: number): Bot | undefined {
    const id = this.idOf(p);
    return this.parts.characters.allBots.find((bot) => bot.id === id);
  }

  // ---- the step ----------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    const room = this.room;
    if (!room) return;
    const ms = dt * 1000;

    this.sincePresence += ms;
    if (this.sincePresence >= PRESENCE_MS && this.seat >= 0) {
      this.sincePresence = 0;
      this.sendPresence(room);
    }
    this.sinceShots += ms;
    if (this.sinceShots >= SHOTS_MS) {
      this.sinceShots = 0;
      this.flushShots(room);
    }
    this.sincePaint += ms;
    if (this.sincePaint >= PAINT_MS) {
      this.sincePaint = 0;
      this.flushPaint(room);
    }
    if (room.isHost) {
      this.sinceReport += ms;
      if (this.sinceReport >= REPORT_MS) {
        this.sinceReport = 0;
        this.sendReport(room);
      }
    }
  }

  update(): void {
    if (this.toPaint.length > 0) this.paintSome();
    const room = this.room;
    const ctx = this.ctx;
    if (!room || !ctx) return;
    const now = performance.now();
    const values: number[] = [];
    const { places } = this.parts;
    for (let p = 0; p < places.length; p++) {
      if (p === this.seat) continue;
      const bot = this.botAt(p);
      if (!bot || !bot.present) {
        this.tagsLayer.show(p, null, 0, null, ctx.camera);
        continue;
      }
      const friend = this.people.get(p);
      if (friend || !room.isHost) {
        const at = (friend ? this.friends : this.bots).get(p, now, values);
        const m = this.motion.get(p);
        if (at && m) bot.drive(at[0]!, at[1]!, at[2]!, at[3]!, m.vx, m.vy, m.vz, m.f, at[4] ?? 0);
      }
      this.tagsLayer.show(p, friend ? friend.name : null, bot.character.color, friend ? bot.position : null, ctx.camera);
    }
    this.tagsLayer.visible = isPlaying(this.parts.match);
  }

  // ---- presence: friends --------------------------------------------------------------

  private sendPresence(room: Room): void {
    const { state, match } = this.parts;
    const flags = (state.aiming ? 1 : 0) | (state.crouching ? 2 : 0) | (state.grounded ? 4 : 0);
    const seen: Seen = {
      p: [
        Math.round(state.position.x * 100),
        Math.round(state.position.y * 100),
        Math.round(state.position.z * 100),
        Math.round(state.bodyYaw * 1000),
        Math.round(state.pitch * 1000),
        Math.round(state.velocity.x * 100),
        Math.round(state.velocity.y * 100),
        Math.round(state.velocity.z * 100),
      ],
      f: flags,
      a: match.ammo.get('player') ?? 0,
    };
    room.presence.set(seen);
  }

  /** Takes every friend's current presence, for those whose place is known and not yet drawn. */
  private readPresence(): void {
    const room = this.room;
    if (!room) return;
    for (const m of room.members) {
      const p = this.seats.get(m.id);
      if (m.id !== room.self.id && p !== undefined && !this.friends.has(p)) this.onPresence(m, room.presence.get(m));
    }
  }

  private onPresence(member: Member, value: unknown): void {
    const p = this.seats.get(member.id);
    if (p === undefined || p === this.seat) return;
    const seen = value as Partial<Seen> | null;
    if (!seen || !Array.isArray(seen.p) || seen.p.length < 8) {
      this.friends.delete(p);
      return;
    }
    const v = seen.p.map((n) => num(n));
    this.friends.set(p, [v[0]! / 100, v[1]! / 100, v[2]! / 100, v[3]! / 1000, v[4]! / 1000]);
    this.motion.set(p, { vx: v[5]! / 100, vy: v[6]! / 100, vz: v[7]! / 100, f: num(seen.f), pitch: v[4]! / 1000 });
    const id = this.idOf(p);
    if (id) this.parts.match.ammo.set(id, num(seen.a));
  }

  // ---- the host's report: the bots and the crates -------------------------------------

  private sendReport(room: Room): void {
    const w = this.report.reset();
    const spots = this.parts.lootSystem.spots;
    w.u8(1).f64(room.now()).u8(spots.length);
    for (const spot of spots) w.u8(spot < 0 ? 255 : spot);
    const bots: Bot[] = [];
    for (const bot of this.parts.characters.allBots) if (this.runs(bot.id) && bot.present) bots.push(bot);
    w.u8(bots.length);
    for (const bot of bots) {
      const a = bot.animationInput;
      const flags = (a.aiming ? 1 : 0) | (a.crouching ? 2 : 0) | 4;
      w.u8(this.placeOf(bot.id)).pos(bot.position.x).pos(bot.position.y).pos(bot.position.z).angle(bot.yaw);
      w.pos(bot.motion.x).pos(bot.motion.z).u8(flags).u16(this.parts.match.ammo.get(bot.id) ?? 0);
    }
    room.send('hr', w.bytes(), { volatile: true });
  }

  private onReport(data: unknown): void {
    if (!(data instanceof Uint8Array) || !this.room || this.room.isHost) return;
    try {
      const r = new Reader(data);
      if (r.u8() !== 1) return;
      r.f64();
      const spots: number[] = [];
      for (let n = r.u8(); n > 0; n--) {
        const spot = r.u8();
        spots.push(spot === 255 ? -1 : spot);
      }
      const now = performance.now();
      for (let n = r.u8(); n > 0; n--) {
        const p = r.u8();
        const x = r.pos();
        const y = r.pos();
        const z = r.pos();
        const yaw = r.angle();
        const vx = r.pos();
        const vz = r.pos();
        const f = r.u8();
        const ammo = r.u16();
        if (this.people.has(p) || p === this.seat) continue;
        this.bots.set(p, [x, y, z, yaw, 0], now);
        this.motion.set(p, { vx, vy: 0, vz, f, pitch: 0 });
        const id = this.idOf(p);
        if (id) this.parts.match.ammo.set(id, ammo);
      }
      this.parts.lootSystem.showSpots(spots, this.reported);
      this.reported = true;
    } catch {
      // Not a whole report: the next one is a tenth of a second away.
    }
  }

  // ---- shots --------------------------------------------------------------------------

  private fired(shot: { shooterId: string; origin: Vector3; direction: Vector3; remote?: boolean }): void {
    const room = this.room;
    if (!room || shot.remote) return;
    const mine = shot.shooterId === 'player' ? this.seat >= 0 : this.runs(shot.shooterId);
    if (!mine) return;
    const now = room.now();
    if (this.shotsCount === 0) {
      this.shotsOut.reset().u8(2).f64(now).u8(0);
      this.shotsFrom = now;
    }
    const w = this.shotsOut;
    w.u8(this.placeOf(shot.shooterId)).u16(now - this.shotsFrom);
    w.pos(shot.origin.x).pos(shot.origin.y).pos(shot.origin.z);
    w.unit(shot.direction.x).unit(shot.direction.y).unit(shot.direction.z);
    this.shotsCount++;
    if (this.shotsCount === 255) this.flushShots(room);
  }

  private flushShots(room: Room): void {
    if (this.shotsCount === 0) return;
    const bytes = this.shotsOut.bytes();
    bytes[9] = this.shotsCount;
    room.send('sh', bytes);
    this.shotsCount = 0;
  }

  private onShots(data: unknown): void {
    const room = this.room;
    if (!(data instanceof Uint8Array) || !room) return;
    const { characters, ballistics, events } = this.parts;
    const now = room.now();
    try {
      const r = new Reader(data);
      if (r.u8() !== 2) return;
      const from = r.f64();
      for (let n = r.u8(); n > 0; n--) {
        const p = r.u8();
        const at = from + r.u16();
        const origin = new Vector3(r.pos(), r.pos(), r.pos());
        const direction = new Vector3(r.unit(), r.unit(), r.unit()).normalize();
        const id = this.idOf(p);
        if (!id || id === 'player' || now - at > MAX_AGE_MS) continue;
        const bot = characters.allBots.find((b) => b.id === id);
        if (!bot || !bot.present) continue;
        // From where it was fired, as it comes, and not caught up by its age. This page
        // draws the shooter a tenth of a second or more in the past: a ball flown ahead to
        // where it is on the page that fired it first showed metres from their marker, or,
        // landed already, never. It lands here later by its age, which is about when what
        // it did comes in the log.
        const color = bot.character.color;
        ballistics.fire(origin, direction, id, color, bot.collider);
        bot.character.animator.triggerShot();
        events.emit('shot:fired', { shooterId: id, color, origin, direction, remote: true });
      }
    } catch {
      // Not whole: those shots are not drawn here. What they hit still arrives in the log.
    }
  }

  // ---- crates -------------------------------------------------------------------------

  private onTake(data: unknown, from: Member | null): void {
    const room = this.room;
    if (!room?.isHost || !from) return;
    const p = this.seats.get(from.id);
    const ask = data as { i?: unknown; s?: unknown } | null;
    const slot = num(ask?.i, -1);
    if (p === undefined || slot < 0 || this.parts.lootSystem.spots[slot] !== num(ask?.s, -2)) return;
    const rounds = this.parts.lootSystem.take(slot, this.idOf(p));
    if (rounds > 0) room.send('give', { r: rounds }, { to: from.id });
  }

  private onGive(data: unknown): void {
    const rounds = num((data as { r?: unknown } | null)?.r);
    if (rounds <= 0) return;
    grant(this.parts.match, 'player', rounds);
    this.parts.events.emit('loot:taken', { characterId: 'player', rounds, position: this.parts.state.position.clone() });
  }

  // ---- paint, tags and rounds: the log ------------------------------------------------

  /** A splat this page judged: its shape is chosen here, and it goes to the log. */
  private judged(impact: {
    shooterId: string;
    point: Vector3;
    normal: Vector3;
    impactSpeed: number;
    cosmetic?: boolean;
    quiet?: boolean;
    variant?: number;
    roll?: number;
  }): void {
    if (!this.room || impact.cosmetic || impact.quiet) return;
    impact.variant = this.rng.int(0, this.parts.atlas.variants);
    impact.roll = this.rng.range(0, Math.PI * 2);
    const p = this.placeOf(impact.shooterId);
    const w = new Writer(SPLAT_BYTES);
    writeSplat(w, {
      point: impact.point,
      normal: impact.normal,
      color: this.parts.places[Math.max(0, p)]!.colorIndex,
      impactSpeed: impact.impactSpeed,
      variant: impact.variant,
      roll: impact.roll,
    });
    this.splatsOut.push(w.bytes());
  }

  private flushPaint(room: Room): void {
    if (this.splatsOut.length === 0) return;
    const bytes = join(this.splatsOut);
    if (room.log.submit({ k: 'p', d: toBase64(bytes) })) this.splatsOut.length = 0;
  }

  /** Starts the log from a snapshot, or from nothing: the park as the room has it. */
  private load(state: unknown): void {
    const { paint, screen, characters } = this.parts;
    paint.clear();
    screen?.clear();
    this.toPaint.length = 0;
    this.splats = [];
    this.roundFrom = 0;
    this.tags = [];
    this.lastTag.clear();
    this.round = null;
    characters.resetScores();

    this.keep = MAX_SPLATS;
    const saved = state as Partial<Saved> | null | undefined;
    if (!saved || saved.v !== 1) return;
    this.keep = Math.max(MIN_SPLATS, Math.min(MAX_SPLATS, num(saved.k, MAX_SPLATS)));
    try {
      const all = chunks(fromBase64(String(saved.p ?? '')), SPLAT_BYTES);
      const from = Math.min(all.length, Math.max(0, num(saved.f)));
      this.paintSplats(all.slice(0, from));
      const round = saved.m ? validRound(saved.m) : null;
      // Started, its paint and its tags, and then over if it is.
      if (round) this.begin({ ...round, over: undefined });
      this.paintSplats(all.slice(from));
      this.roundFrom = from;
      for (const record of chunksOf(fromBase64(String(saved.t ?? '')))) this.applyTag(record, true, false);
      if (round?.over) this.end(round.over);
    } catch {
      // A snapshot this page cannot read: the park starts bare, and the log carries on.
    }
  }

  private apply(op: unknown, entry: LogEntry): void {
    const o = op as { k?: unknown; d?: unknown; id?: unknown; r?: unknown; n?: unknown } | null;
    if (!o || typeof o !== 'object') return;
    const mine = !entry.replayed && entry.from?.id === this.room?.self.id;
    try {
      switch (o.k) {
        case 'p':
          this.paintSplats(chunks(fromBase64(String(o.d)), SPLAT_BYTES), mine);
          break;
        case 't':
          for (const record of chunksOf(fromBase64(String(o.d)))) this.applyTag(record, entry.replayed, mine);
          break;
        case 's':
          this.begin({ id: num(o.id), at: entry.ts, d: num(o.d, matchConfig.durationSeconds) });
          // The tags of the round before are not needed by anybody who comes later.
          if (this.room?.isHost && !entry.replayed) this.room.log.snapshot();
          break;
        case 'k':
          // How much paint the room keeps, by the host's word: see `refused`.
          this.keep = Math.max(MIN_SPLATS, Math.min(MAX_SPLATS, num(o.n, MAX_SPLATS)));
          this.trim();
          break;
        case 'e':
          if (this.round && num(o.id) === this.round.id && !this.round.over) {
            this.end(o.r === 'ammo' ? 'ammo' : 'time');
          }
          break;
      }
    } catch {
      // An op this page cannot read changes nothing here.
    }
  }

  /** Paints splats from the log. A page's own were painted when its ball landed. */
  private paintSplats(records: Uint8Array[], mine = false): void {
    for (const bytes of records) {
      this.splats.push(bytes);
      if (this.splats.length > this.keep) this.trim();
      if (!mine) this.toPaint.push(readSplat(new Reader(bytes)));
    }
  }

  /** Paints from the queue for as long as a frame can spare. */
  private paintSome(): void {
    const start = performance.now();
    while (this.toPaint.length > 0 && performance.now() - start < PAINT_BUDGET_MS) {
      const next = this.toPaint.shift()!;
      if (next === 'front') this.parts.screen?.clearFront();
      else this.paintOne(next);
    }
  }

  private paintOne(s: Splat): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const handle = this.surfaceAt(s.point, s.normal, ctx);
    this.parts.events.emit('hit:world', {
      shooterId: '',
      color: paintColorOf(s.color),
      point: s.point,
      normal: s.normal,
      impactSpeed: s.impactSpeed,
      colliderHandle: handle,
      quiet: true,
      variant: s.variant,
      roll: s.roll,
    });
  }

  /** The collider a splat lies on: whatever is just behind it, that is not a person. */
  private surfaceAt(point: Vector3, normal: Vector3, ctx: GameContext): number {
    const physics = ctx.physics;
    const ray = new physics.api.Ray(
      { x: point.x + normal.x * 0.08, y: point.y + normal.y * 0.08, z: point.z + normal.z * 0.08 },
      { x: -normal.x, y: -normal.y, z: -normal.z },
    );
    const characters = this.parts.characters;
    const hit = physics.w.castRay(ray, 0.3, true, undefined, undefined, undefined, undefined, (collider) =>
      !characters.allBots.some((bot) => bot.collider === collider) && collider !== this.parts.state.collider,
    );
    return hit ? hit.collider.handle : -1;
  }

  /** A tag from the log, or a place emptied for somebody new. The same on every page. */
  private applyTag(bytes: Uint8Array, replayed: boolean, mine: boolean): void {
    const { characters, events } = this.parts;
    if (bytes[0] === EMPTIED) {
      const p = bytes[1]!;
      const character = characters.find(this.idOf(p));
      if (character) {
        character.hitsGiven = 0;
        character.hitsTaken = 0;
        character.paint.clear();
      }
      this.lastTag.delete(p);
      this.tags.push(bytes);
      return;
    }
    const record: TagRecord = readTag(new Reader(bytes));
    const round = this.round;
    // Only inside the round, and not inside the grace second after the last one.
    if (!round || round.over || record.at < round.at) return;
    if (record.at < (this.lastTag.get(record.target) ?? -Infinity) + GRACE_MS) return;
    this.lastTag.set(record.target, record.at);
    this.tags.push(bytes);
    const targetId = this.idOf(record.target);
    const shooterId = this.idOf(record.shooter);
    if (!targetId || !this.ctx) return;
    characters.applyTag(targetId, shooterId, record.tag, this.ctx.rng);
    const target = characters.find(targetId);
    if (!target) return;
    events.emit('score:changed', { characterId: targetId, hitsTaken: target.hitsTaken, hitsGiven: target.hitsGiven });
    if (!replayed) {
      const color = characters.find(shooterId)?.color ?? target.color;
      events.emit('tag:applied', { targetId, shooterId, color, judgedHere: mine });
    }
  }

  /** Every score and every body's paint again, from this round's tags. */
  private retag(): void {
    if (!this.round) return;
    this.parts.characters.resetScores();
    this.lastTag.clear();
    const tags = this.tags;
    this.tags = [];
    for (const bytes of tags) this.applyTag(bytes, true, false);
  }

  /** A round starts, by the room's log: everything a round owns starts again. */
  private begin(round: Round): void {
    this.round = round;
    this.endAsked = -1;
    this.tags = [];
    this.lastTag.clear();
    this.sentTag.clear();
    this.roundFrom = this.splats.length;
    this.parts.matchSystem.restart();
    // The board's front is wiped at the whistle, after whatever paint is still to go on.
    if (this.toPaint.length > 0) this.toPaint.push('front');
  }

  private end(reason: 'time' | 'ammo'): void {
    if (this.round) this.round.over = reason;
    this.parts.matchSystem.finish(reason);
  }

  /** The state for a snapshot: the park's paint, and this round. */
  private save(): Saved {
    return {
      v: 1,
      m: this.round ? { ...this.round } : null,
      p: toBase64(join(this.splats)),
      f: this.roundFrom,
      t: toBase64(join(this.tags.map(lengthPrefixed))),
      k: this.keep,
    };
  }

  // ---- for the tests ------------------------------------------------------------------

  /** What every page in a room should agree on, as plain numbers. */
  fingerprint(): {
    seat: number;
    host: boolean;
    places: Array<{ who: string; x: number; z: number; given: number; taken: number; aim: number }>;
    splats: number;
    paint: number;
    tags: number;
    round: number;
    over: string;
  } {
    const { characters, places } = this.parts;
    let paint = 0;
    for (const bytes of this.splats) for (let i = 0; i < bytes.length; i++) paint = (paint * 31 + bytes[i]!) >>> 0;
    return {
      seat: this.seat,
      host: this.isHost,
      places: places.map((_, p) => {
        const id = this.idOf(p);
        const character = id ? characters.find(id) : undefined;
        const bot = characters.allBots.find((b) => b.id === id);
        const who = p === this.seat ? 'me' : this.people.has(p) ? 'friend' : bot?.present === false || !id ? 'empty' : 'bot';
        const at = id === 'player' ? this.parts.state.position : bot?.position;
        return {
          who,
          x: at?.x ?? 0,
          z: at?.z ?? 0,
          given: character?.hitsGiven ?? 0,
          taken: character?.hitsTaken ?? 0,
          // On the page that runs it: the place of whoever this bot is after, or -1.
          aim: bot && this.runs(bot.id) && bot.targetId ? this.placeOf(bot.targetId) : -1,
        };
      }),
      splats: this.splats.length,
      paint,
      tags: this.tags.length,
      round: this.round?.id ?? 0,
      over: this.round?.over ?? '',
    };
  }
}

function validRound(value: unknown): Round {
  const v = value as Partial<Round>;
  return {
    id: num(v.id),
    at: num(v.at),
    d: num(v.d, matchConfig.durationSeconds),
    over: v.over === 'time' || v.over === 'ammo' ? v.over : undefined,
  };
}

function join(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + size <= bytes.length; at += size) out.push(bytes.slice(at, at + size));
  return out;
}

/** Records of different lengths, each after a byte that says how long it is. */
function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = bytes.length;
  out.set(bytes, 1);
  return out;
}

function chunksOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const length = bytes[at]!;
    out.push(bytes.slice(at + 1, at + 1 + length));
    at += 1 + length;
  }
  return out;
}

function paintColorOf(index: number): number {
  return paintColors[index % paintColors.length]!;
}
