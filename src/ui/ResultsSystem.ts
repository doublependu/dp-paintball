import type { CharactersSystem } from '../character/CharactersSystem';
import { displayName } from '../character/Names';
import type { GameContext, System } from '../core/System';
import type { MatchState } from '../gameplay/MatchState';
import type { RenderSystem } from '../render/Renderer';
import type { ScoreRow } from './Hud';
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

  constructor(
    private readonly container: HTMLElement,
    private readonly characters: CharactersSystem,
    private readonly match: MatchState,
    private readonly render: RenderSystem,
  ) {}

  init(ctx: GameContext): void {
    if (this.match.sandbox) return;

    this.stage = new ResultsStage();
    this.panel = new ResultsPanel(this.container);

    ctx.events.on('match:ended', ({ reason }) => this.show(reason));
    ctx.events.on('match:started', () => this.hide());
  }

  /** Per-frame, so the line-up keeps turning while the panel is up. */
  update(dt: number): void {
    this.stage?.update(dt);
  }

  private show(reason: 'time' | 'ammo'): void {
    const stage = this.stage;
    const panel = this.panel;
    if (!stage || !panel) return;

    const characters = this.characters.allCharacters;
    stage.present(characters);
    this.render.setOverlay(stage);

    const splats = new Map(characters.map((c) => [c.id, c.paint.splatCount]));
    panel.show(
      reason === 'ammo' ? 'Out of paint!' : 'Time!',
      characters.map(toRow),
      splats,
    );
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
