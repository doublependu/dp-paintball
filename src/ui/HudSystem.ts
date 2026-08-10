import type { CharactersSystem } from '../character/CharactersSystem';
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

    // The hint is for the menu state; once you're playing, it's clutter.
    ctx.events.on('input:lockChanged', ({ locked }) => {
      this.hud?.setHintVisible(!locked);
    });
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
      label: character.id === 'player' ? 'you' : character.id.replace('bot-', 'bot '),
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
