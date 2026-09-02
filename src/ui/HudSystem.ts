import { Vector3 } from 'three';
import type { CharactersSystem } from '../character/CharactersSystem';
import { displayName } from '../character/Names';
import { match as matchConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';
import { nearestCrate, type LootState } from '../gameplay/LootSystem';
import { ammoOf, isPlaying, type MatchState } from '../gameplay/MatchState';
import type { PlayerState } from '../gameplay/PlayerState';
import { SplatAtlas } from '../paint/SplatAtlas';
import { Hud, type ScoreRow } from './Hud';
import { SplashOverlay } from './SplashOverlay';

/**
 * How far a crate can be and still be worth pointing at, in metres.
 *
 * Sized against the bots: they notice a crate at `sightRange` (30-46) times
 * `botLootSightScale` (1.5), so 60 puts the player on roughly the same footing
 * as the opposition rather than ahead of it.
 */
const CRATE_MARKER_RANGE = 60;
/** How far the pinned chevron sits from the edge of the screen, in pixels. */
const EDGE_MARGIN = 58;

const VIEW = new Vector3();
const NDC = new Vector3();

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
    /** Read every frame to point at the nearest crate. See `updateCrateMarker`. */
    private readonly loot: LootState,
    private readonly playerState: PlayerState,
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

    // Where a fresh crate landed, by name. `LOOT_SPOTS` has written a sentence
    // for every hiding place in the park since the crate existed and nothing
    // has ever said one out loud. Only the ones that arrive mid-round are
    // announced — see `LootSystem.spawn`.
    ctx.events.on('loot:spawned', ({ where, announce }) => {
      if (!announce || !isPlaying(this.match)) return;
      this.hud?.showToast(`fresh paint — ${where}`, 0xffd23f, 2.6);
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

    this.updateCrateMarker(hud, ctx);

    hud.update(dt);
    this.splash?.update(dt);
  }

  /**
   * Points the HUD at the nearest crate worth walking to.
   *
   * Range-gated on the same notion the bots use — `botLootSightScale` times a
   * middling sight range — rather than showing every crate in the park, so the
   * marker means "there is paint near you" rather than "here is the map".
   *
   * The projection is done by hand rather than with `Vector3.project` because
   * the interesting case is a crate *behind* the camera, where the projection
   * matrix mirrors the point and a naive NDC test sends the chevron to the
   * wrong edge. View space answers it honestly: negative z is in front.
   */
  private updateCrateMarker(hud: Hud, ctx: GameContext): void {
    if (this.match.sandbox || !isPlaying(this.match)) {
      hud.setCrateMarker(null);
      return;
    }

    const crate = nearestCrate(this.loot, this.playerState.position);
    if (!crate) {
      hud.setCrateMarker(null);
      return;
    }
    const distance = this.playerState.position.distanceTo(crate.position);
    if (distance > CRATE_MARKER_RANGE || distance < matchConfig.lootPickupRadius) {
      hud.setCrateMarker(null);
      return;
    }

    const camera = ctx.camera;
    // Aim at the middle of the beacon rather than at the lid, so the marker
    // sits on the thing that is actually visible from a distance.
    VIEW.copy(crate.position).setY(crate.position.y + 2.4).applyMatrix4(camera.matrixWorldInverse);

    const width = ctx.renderer.domElement.clientWidth || window.innerWidth;
    const height = ctx.renderer.domElement.clientHeight || window.innerHeight;
    const inFront = VIEW.z < -camera.near;

    if (inFront) {
      NDC.copy(VIEW).applyMatrix4(camera.projectionMatrix);
      if (Math.abs(NDC.x) <= 1 && Math.abs(NDC.y) <= 1) {
        hud.setCrateMarker({
          x: (NDC.x * 0.5 + 0.5) * width,
          y: (0.5 - NDC.y * 0.5) * height,
          angle: 0,
          distance,
          offscreen: false,
        });
        return;
      }
    }

    // Off camera: pin the chevron to the edge, pointing the way you would turn.
    // The view-space direction is negated when the crate is behind, because
    // there "left of the camera" and "left on screen" are opposites.
    const sign = inFront ? 1 : -1;
    const dx = VIEW.x * sign;
    const dy = VIEW.y * sign;
    const length = Math.hypot(dx, dy) || 1;
    const marginX = width / 2 - EDGE_MARGIN;
    const marginY = height / 2 - EDGE_MARGIN;
    // The longest ray in that direction that still lands inside the margin box.
    const scale = Math.min(marginX / Math.abs(dx / length), marginY / Math.abs(dy / length));
    hud.setCrateMarker({
      x: width / 2 + (dx / length) * scale,
      y: height / 2 - (dy / length) * scale,
      // The chevron is drawn pointing up, so this is the angle from up.
      angle: Math.atan2(dx, dy),
      distance,
      offscreen: true,
    });
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
