import type { CharactersSystem } from '../character/CharactersSystem';
import { match as matchConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';
import type { BallisticsSystem } from './Ballistics';
import { totalCrateRounds, type LootState, type LootSystem } from './LootSystem';
import { isPaused, isPlaying, resetMatch, totalAmmo, type MatchState } from './MatchState';

/**
 * What the round asks of a room (`net/`), when the page is in one: there the round is
 * the room's, kept in its log by the host. Unset, or not `active`, the round is the
 * page's own.
 */
export interface MatchNet {
  readonly active: boolean;
  /** Seconds left in the room's round, by the server's clock. */
  timeLeft(): number;
  /** The round should end: the host says so to the room, once. */
  over(reason: 'time' | 'ammo'): void;
  /** The player asks for the next round, after the whistle. */
  again(): void;
}

/**
 * The round: a clock, an ending, and a way to start another one.
 *
 * This is the piece that turns the sandbox into a game with a shape. Everything
 * it owns is in `MatchState`; every other system only reads that, and gates
 * itself on `isPlaying` — the weapon, the bots' triggers, the player's legs and
 * the scoreboard all stop on the same boolean rather than each being told to
 * stop.
 */
export class MatchSystem implements System {
  readonly name = 'match';

  /** Thresholds still to announce, largest first. */
  private pendingWarnings: number[] = [];
  /** The room, while the page is in one. See `MatchNet`. */
  net?: MatchNet;

  constructor(
    private readonly match: MatchState,
    private readonly characters: CharactersSystem,
    private readonly ballistics: BallisticsSystem,
    private readonly loot: LootState,
    private readonly lootSystem: LootSystem,
  ) {}

  private ctx?: GameContext;

  init(ctx: GameContext): void {
    if (this.match.sandbox) return;
    this.ctx = ctx;
    this.pendingWarnings = [matchConfig.warnAtSeconds];
    ctx.events.emit('match:started', { duration: this.match.timeLeft });

    // Restart is on the fixed step with everything else, but the *input* for it
    // is read here so it works whether or not the pointer is locked — which it
    // is not, once a round has ended and the cursor has been handed back.
    ctx.events.on('input:lockChanged', ({ locked }) => {
      if (locked) {
        // Getting the pointer back means one of two things, and which one it
        // means is the phase we were in when we lost it. After a round, the
        // only way to get it back is the results card's Play again: the card
        // takes every other click, and the phone's start prompt stays down.
        if (isPaused(this.match)) this.resume(ctx);
        else if (!isPlaying(this.match)) {
          if (this.net?.active) this.net.again();
          else this.restart(ctx);
        }
        return;
      }
      // Esc, alt-tab, or anything else that takes the pointer away mid-round.
      // Losing the mouse mid-fight and being shot while reading a browser
      // dialog is not a game; the round waits.
      if (isPlaying(this.match)) this.pause(ctx);
    });
  }

  /**
   * Holds the round.
   *
   * Nothing is stopped by hand: the phase is the brake, and every system that
   * matters — the clock below, the weapon, the bots, the player's legs — is
   * already gated on `isPlaying`. Paint still in the air keeps flying and lands
   * on the world, exactly as it does when the whistle goes.
   */
  private pause(ctx: GameContext): void {
    // A room's round goes on: only this player stands still.
    if (this.net?.active) this.match.held = true;
    else this.match.phase = 'paused';
    ctx.events.emit('match:paused', {});
  }

  private resume(ctx: GameContext): void {
    this.match.held = false;
    if (this.match.phase === 'paused') this.match.phase = 'playing';
    ctx.events.emit('match:resumed', {});
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    const { match } = this;
    if (match.sandbox || !isPlaying(match)) return;

    // Simulated time, not wall clock: a round that runs short on a slow machine
    // is not a round. See the Loop.elapsed / simElapsed note in CLAUDE.md. In a
    // room it is the server's clock, the one every page reads.
    const net = this.net?.active ? this.net : undefined;
    match.timeLeft = net ? net.timeLeft() : Math.max(0, match.timeLeft - dt);

    const next = this.pendingWarnings[0];
    if (next !== undefined && match.timeLeft <= next) {
      this.pendingWarnings.shift();
      ctx.events.emit('match:warning', { secondsLeft: next });
    }

    if (match.timeLeft <= 0) {
      if (net) net.over('time');
      else this.end(ctx, 'time');
      return;
    }
    if (this.outOfPaint()) {
      if (net) net.over('ammo');
      else this.end(ctx, 'ammo');
    }
  }

  /** In a room: the room's round is over. */
  finish(reason: 'time' | 'ammo'): void {
    if (this.ctx && this.match.phase !== 'ended') this.end(this.ctx, reason);
  }

  /**
   * Whether there is no paint left anywhere in the park.
   *
   * All three clauses matter. Without the crates, "everyone is empty" fires
   * while a hundred rounds are still sitting under the arcade, which is not
   * what the rule says — the paint in a crate counts, so somebody has to go and
   * get it or the clock has to run out. Without the in-flight clause the round
   * ends while the last shot is still travelling, and the final hit lands after
   * the scoreboard has already been drawn.
   *
   * Note this counts *rounds*, not crates. A slot waiting out its respawn timer
   * holds nothing and must not keep the round alive on its own.
   */
  private outOfPaint(): boolean {
    return (
      totalAmmo(this.match) === 0 &&
      totalCrateRounds(this.loot) === 0 &&
      this.ballistics.activeCount === 0
    );
  }

  private end(ctx: GameContext, reason: 'time' | 'ammo'): void {
    this.match.phase = 'ended';
    this.match.held = false;
    this.match.endedBy = reason;
    this.match.timeLeft = 0;
    // Hand the cursor back so the player can read the board and press Play
    // again, which is what takes it back.
    ctx.input.releaseLock();
    ctx.events.emit('match:ended', { reason });
  }

  /**
   * Starts a fresh round without rebuilding the world.
   *
   * The park is 1.4s of boot and none of it changed, so a restart resets the
   * things a round owns — the clock, everyone's load, the scoreboard, the paint
   * people are wearing — and puts a new crate somewhere else.
   *
   * World paint is deliberately left alone. It is already bounded by
   * oldest-first eviction, and a park that carries the day's mess from round to
   * round is more in keeping with this game than one that wipes clean every five
   * minutes.
   */
  restart(ctx: GameContext | undefined = this.ctx): void {
    if (this.match.sandbox || !ctx) return;

    resetMatch(this.match);
    this.characters.resetScores();
    this.characters.respawnAll();
    this.lootSystem.respawn();
    this.pendingWarnings = [matchConfig.warnAtSeconds];
    ctx.events.emit('match:started', { duration: this.match.timeLeft });
  }
}
