import type { CharactersSystem } from '../character/CharactersSystem';
import { displayName } from '../character/Names';
import { match as matchConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';
import type { MatchState } from '../gameplay/MatchState';
import type { RenderSystem } from '../render/Renderer';
import type { PaintScreen } from '../world/PaintScreen';
import type { ScoreRow } from './Hud';
import type { PosterCapture, Souvenir } from './PosterCapture';
import { ResultsPanel } from './ResultsPanel';
import { ResultsStage } from './ResultsStage';

/**
 * The end of a round: everybody lined up wearing their paint, with the scores.
 *
 * Split in two because the halves have nothing to do with each other — a 3D
 * overlay scene (`ResultsStage`) and a DOM card (`ResultsPanel`) — and this
 * system is the only thing that knows a round has ended.
 *
 * It takes `RenderSystem` directly rather than through `GameContext`, which
 * carries the raw `WebGLRenderer` but not the pipeline wrapper that owns the
 * overlay hook. One explicit argument beats widening the context for a single
 * caller.
 */
export class ResultsSystem implements System {
  readonly name = 'results';

  private stage?: ResultsStage;
  private panel?: ResultsPanel;
  /** Whether the page is in a room, where Play again starts everybody's round. */
  shared: () => boolean = () => false;
  /**
   * Seconds of frames the card has been up, up to `againArmSeconds`.
   *
   * Frame time rather than a timer: in play it is the same thing, and the
   * headless suites drive frames with `stepSim`, so they can test the arming
   * exactly however slowly SwiftShader paints.
   */
  private shownFor = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly characters: CharactersSystem,
    private readonly match: MatchState,
    private readonly render: RenderSystem,
    /** Null on the test course, which has no screen to show. */
    private readonly screen: PaintScreen | null,
    /**
     * The in-game photograph of the mural, when one could be taken.
     *
     * Registered *before* this system, because it renders a frame with the
     * characters still standing in the park and `stage.present` below is what
     * takes them out of it.
     */
    private readonly poster: PosterCapture | null,
  ) {}

  init(ctx: GameContext): void {
    if (this.match.sandbox) return;

    this.stage = new ResultsStage();
    this.panel = new ResultsPanel(this.container);
    // The controls coming back after a round is what `MatchSystem` reads as
    // "play again" (in a room, as asking the host for the next round). The
    // button's click is the gesture a pointer lock needs.
    this.panel.setAgainHandler(() => ctx.input.requestLock());

    ctx.events.on('match:ended', ({ reason }) => this.show(reason));
    ctx.events.on('match:started', () => this.hide());
  }

  /** Per-frame, so the line-up keeps turning while the panel is up. */
  update(dt: number): void {
    const stage = this.stage;
    if (!stage?.isShowing) return;
    // Re-measured every frame rather than on show, because the card's height is
    // not settled when it appears: it fades and slides in, the mural's image
    // decodes a frame or two later, and the share row is appended once the PNG
    // is ready. Reading it once catches the card mid-arrival.
    if (this.panel) stage.setPanelShare(this.panel.heightFraction);
    stage.update(dt);

    if (this.shownFor < matchConfig.againArmSeconds) {
      this.shownFor += dt;
      this.panel?.setArming(this.shownFor / matchConfig.againArmSeconds);
    }
  }

  private show(reason: 'time' | 'ammo'): void {
    const stage = this.stage;
    const panel = this.panel;
    if (!stage || !panel) return;

    const characters = this.characters.shownCharacters;
    stage.present(characters);
    this.render.setOverlay(stage);

    const splats = new Map(characters.map((c) => [c.id, c.paint.splatCount]));
    this.shownFor = 0;
    panel.setShared(this.shared());
    panel.show(
      reason === 'ammo' ? 'Out of paint!' : 'Time!',
      characters.map(toRow),
      splats,
      this.souvenir(),
    );
  }

  /**
   * The picture of the round: the park with the mural in it where the shutter
   * worked, the mural's own canvas where it did not.
   *
   * The fallback is not theoretical. A WebGL context that has already handed
   * its drawing buffer back returns a blank frame, and a blank rectangle on the
   * card would be worse than the flat painting it replaced.
   */
  private souvenir(): Souvenir | null {
    if (this.poster?.hasPoster) return this.poster;
    return this.screen;
  }

  private hide(): void {
    // Order matters: drop the overlay before the figures go back, or one frame
    // renders the stage with the world's transforms already restored and the
    // line-up scattered across the park.
    this.render.setOverlay(null);
    this.stage?.dismiss();
    this.panel?.hide();
  }

  dispose(): void {
    this.render.setOverlay(null);
    this.stage?.dispose();
    this.panel?.dispose();
  }
}

function toRow(character: CharactersSystem['allCharacters'][number]): ScoreRow {
  return {
    id: character.id,
    label: displayName(character.id),
    color: character.color,
    hitsGiven: character.hitsGiven,
    hitsTaken: character.hitsTaken,
    isPlayer: character.id === 'player',
  };
}
