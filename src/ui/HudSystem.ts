import type { CharactersSystem } from '../character/CharactersSystem';
import { displayName } from '../character/Names';
import type { GameContext, System } from '../core/System';
import { ammoOf, type MatchState } from '../gameplay/MatchState';
import { SplatAtlas } from '../paint/SplatAtlas';
import { Hud, type ScoreRow } from './Hud';
import { SplashOverlay } from './SplashOverlay';

/** Cheerful things to say when you tag somebody. */
const SCORED_LINES = ['splat!', 'got you!', 'direct hit!', 'bullseye!', 'nice one!'];
/** And when somebody tags you. Never scolding — this is a friendly game. */
const TAGGED_LINES = ['oof!', 'got me!', 'right in the hat!', 'covered!', 'well played!'];

/**
 * Wires game events to the HUD and the lens splash.
 *
 * Reads score straight from the characters rather than keeping its own tally:
 * two counters that can disagree is a bug waiting to happen, and the characters
 * already own the authoritative numbers.
 */
export class HudSystem implements System {
  readonly name = 'hud';

  private hud?: Hud;
  private splash?: SplashOverlay;
  private atlas?: SplatAtlas;
  private scoreboardOpen = false;
  private lastGiven = -1;
  private lastTaken = -1;
  private lastAmmo = -1;

  constructor(
    private readonly container: HTMLElement,
    private readonly characters: CharactersSystem,
    private readonly sharedAtlas: SplatAtlas,
    private readonly match: MatchState,
  ) {}

  init(ctx: GameContext): void {
    this.hud = new Hud(this.container);
    // Filled in here rather than waiting for the first update: the markup ships
    // with a placeholder 0, which would otherwise show for a frame styled as an
    // empty marker — a red zero on a full one.
    this.lastAmmo = ammoOf(this.match, 'player');
    this.hud.setAmmo(this.lastAmmo);
    this.hud.setClockVisible(!this.match.sandbox);
    if (!this.match.sandbox) this.hud.setClock(this.match.timeLeft);
    // The splash reuses the same generated splat shapes as world and character
    // paint, so what lands on the lens matches what's on the wall.
    this.atlas = this.sharedAtlas;
    this.splash = new SplashOverlay(this.container, this.atlas);

    ctx.events.on('hit:character', ({ targetId, shooterId, color }) => {
      if (targetId === 'player') {
        // Paint on the lens, in the colour of whoever tagged us.
        this.splash?.splash(color, 1, () => ctx.rng.next());
        this.hud?.showToast(ctx.rng.pick(TAGGED_LINES), color, 1.5);
      } else if (shooterId === 'player') {
        this.hud?.showToast(ctx.rng.pick(SCORED_LINES), color, 1.2);
      }
    });

    ctx.events.on('weapon:dry', ({ shooterId }) => {
      if (shooterId !== 'player') return;
      this.hud?.showToast('out of paint!', 0xff5757, 1.4);
    });

    ctx.events.on('loot:taken', ({ characterId, rounds }) => {
      if (characterId !== 'player') return;
      this.hud?.showToast(`+${rounds} paint!`, 0xa8e337, 1.6);
    });

    ctx.events.on('match:warning', ({ secondsLeft }) => {
      const minutes = Math.round(secondsLeft / 60);
      this.hud?.showToast(
        minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'} left!` : `${secondsLeft}s left!`,
        0xffd23f,
        2.2,
      );
    });

    // The round's ending is `ResultsSystem`'s: a line-up of everybody's paint
    // with the scores over it. All the HUD does is get out of its way.
    ctx.events.on('match:ended', () => {
      this.hud?.setPlayingChromeVisible(false);
      // Wipe the visor. Between rounds it is not the player's point of view any
      // more, and paint on the lens sits over the line-up.
      this.splash?.clear();
    });
    ctx.events.on('match:started', () => this.hud?.setPlayingChromeVisible(true));

    // The hint is for the menu state before the first click; once you're
    // playing, it's clutter. Every other unlocked state has a card of its own
    // that says the same thing better — the results board, and the pause card
    // — so the hint stays down for those even though the pointer is free.
    ctx.events.on('input:lockChanged', ({ locked }) => {
      this.hud?.setHintVisible(!locked && this.match.phase === 'playing');
    });
    // A held round is the pause card's screen, the way a finished one is the
    // results card's. The card carries the clock, the score and the paint
    // count itself, so the live chrome underneath would only be the same
    // numbers again, showing through it.
    //
    // The hint goes with them. That is belt and braces on the handler above:
    // both hang off the same lock change, and this must not depend on the
    // match having flipped the phase first.
    ctx.events.on('match:paused', () => {
      this.hud?.setHintVisible(false);
      this.hud?.setPlayingChromeVisible(false);
    });
    ctx.events.on('match:resumed', () => this.hud?.setPlayingChromeVisible(true));
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    const hud = this.hud;
    if (!hud) return;

    const player = this.characters.playerCharacter;
    if (player && (player.hitsGiven !== this.lastGiven || player.hitsTaken !== this.lastTaken)) {
      this.lastGiven = player.hitsGiven;
      this.lastTaken = player.hitsTaken;
      hud.setCounters(player.hitsGiven, player.hitsTaken);
    }

    // Polled, like the score above it and for the same reason: the match owns
    // the authoritative number, so the HUD keeps no copy that could disagree.
    const ammo = ammoOf(this.match, 'player');
    if (ammo !== this.lastAmmo) {
      this.lastAmmo = ammo;
      hud.setAmmo(ammo);
    }

    // The sandbox has no clock to show.
    if (!this.match.sandbox) hud.setClock(this.match.timeLeft);

    const wantScoreboard = ctx.input.isDown('scoreboard');
    if (wantScoreboard !== this.scoreboardOpen) {
      this.scoreboardOpen = wantScoreboard;
      hud.setScoreboardVisible(wantScoreboard);
      if (wantScoreboard) hud.updateScoreboard(this.buildRows());
    }

    hud.update(dt);
    this.splash?.update(dt);
  }

  /** Exposed for tests and for anything that needs to wipe the lens. */
  get lensSplash(): SplashOverlay | undefined {
    return this.splash;
  }

  private buildRows(): ScoreRow[] {
    return this.characters.allCharacters.map((character) => ({
      id: character.id,
      label: displayName(character.id),
      color: character.color,
      hitsGiven: character.hitsGiven,
      hitsTaken: character.hitsTaken,
      isPlayer: character.id === 'player',
    }));
  }

  dispose(): void {
    this.hud?.dispose();
    this.splash?.dispose();
  }
}
