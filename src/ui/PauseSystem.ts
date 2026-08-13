import type { CharactersSystem } from '../character/CharactersSystem';
import type { GameContext, System } from '../core/System';
import { ammoOf, isPaused, type MatchState } from '../gameplay/MatchState';
import { PauseOverlay } from './PauseOverlay';

/**
 * Browsers refuse a pointer lock for about a second after the user pressed Esc
 * to leave one, so that a page cannot trap the cursor. A player who reads the
 * card and clicks lands well outside that window; a player who hits Esc and
 * immediately clicks does not, and their click would otherwise do nothing at
 * all. One retry, comfortably past the window, covers it.
 */
const RELOCK_RETRY_MS = 1500;

/**
 * Puts the pause card up when the round goes on hold, and takes the pointer
 * back when the player asks for it.
 *
 * The pause itself belongs to `MatchSystem`, which owns the phase; this system
 * only knows how to draw one and how to ask for it to end. That split is why
 * the card can be missing entirely — on the test course, which has no rounds —
 * without anything else noticing.
 */
export class PauseSystem implements System {
  readonly name = 'pause';

  private overlay?: PauseOverlay;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly container: HTMLElement,
    private readonly characters: CharactersSystem,
    private readonly match: MatchState,
  ) {}

  init(ctx: GameContext): void {
    // The sandbox has no round to hold, and no clock or paint count to show
    // for one.
    if (this.match.sandbox) return;

    const overlay = new PauseOverlay(this.container);
    this.overlay = overlay;
    overlay.setResumeHandler(() => this.resume(ctx));

    ctx.events.on('match:paused', () => {
      const player = this.characters.playerCharacter;
      overlay.show({
        timeLeft: this.match.timeLeft,
        hitsGiven: player?.hitsGiven ?? 0,
        hitsTaken: player?.hitsTaken ?? 0,
        ammo: ammoOf(this.match, 'player'),
      });
    });

    ctx.events.on('match:resumed', () => this.dismiss());
    // A round can only end while playing, so this is belt and braces: if the
    // card were ever still up when the results arrive, it would sit over them.
    ctx.events.on('match:ended', () => this.dismiss());
  }

  /**
   * Asks for the pointer back. The card stays up until the lock actually
   * arrives — `match:resumed` is what takes it down — so a refused request
   * leaves the player looking at the same screen rather than at a frozen game
   * with no explanation.
   */
  private resume(ctx: GameContext): void {
    ctx.input.requestLock();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!isPaused(this.match)) return;
      this.overlay?.setNote('one moment — the browser is holding the pointer');
      ctx.input.requestLock();
    }, RELOCK_RETRY_MS);
  }

  private dismiss(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.overlay?.hide();
  }

  dispose(): void {
    clearTimeout(this.retryTimer);
    this.overlay?.dispose();
  }
}
