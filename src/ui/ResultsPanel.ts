import { isTouchDevice } from '../core/Device';
import type { PaintScreen } from '../world/PaintScreen';
import type { ScoreRow } from './Hud';

const REPO_URL = 'https://github.com/doublependu/dp-paintball';
const SHARE_TITLE = 'Central Park paintball';
const SHARE_TEXT = 'We painted the park.';

/** GitHub's mark, as a path on a 16×16 viewBox. Inlined so it costs no request. */
const GITHUB_MARK =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

/** One end-of-round award: who won it, and what it says. */
export interface Award {
  id: string;
  label: string;
  detail: string;
}

/**
 * The end-of-round card: final scores, the awards, and how to play again.
 *
 * DOM rather than in-scene text, for the same reasons the HUD is: crisp at any
 * resolution, laid out by CSS, and free of draw calls. It sits along the bottom
 * so the line-up on the stage behind it stays visible — `ResultsStage` frames
 * the figures above the share of the screen this takes.
 */
export class ResultsPanel {
  private readonly root: HTMLDivElement;
  /** The round's mural as a shareable file, ready before anyone clicks. */
  private file: File | null = null;
  /** Object URL behind the save button. Revoked when the card goes away. */
  private downloadUrl: string | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'results';
    this.root.innerHTML = `
      <div class="results__card">
        <div class="results__header">
          <div class="results__title" data-results-title></div>
          <a
            class="fork-badge"
            href="${REPO_URL}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="${GITHUB_MARK}" /></svg>
            Fork me on GitHub
          </a>
        </div>
        <div class="results__main">
          <figure class="results__mural" data-results-mural hidden>
            <img data-results-image alt="The park's paint screen at the end of the round" />
            <figcaption class="results__share" data-results-share></figcaption>
          </figure>
          <div class="results__scores">
            <div class="results__awards" data-results-awards></div>
            <div class="results__table">
              <div class="results__head">
                <span>player</span><span>tagged them</span><span>tagged</span><span>splats worn</span>
              </div>
              <div class="results__body" data-results-body></div>
            </div>
          </div>
        </div>
        <div class="results__again">${isTouchDevice() ? 'tap' : 'click'} to play again</div>
      </div>
    `;
    container.append(this.root);

    // One delegated listener rather than one per button, because the row is
    // rebuilt every time the card is shown.
    this.share.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest('[data-share-action]');
      if (!(button instanceof HTMLElement)) return;
      // Belt and braces. The canvas is what carries the click-to-play-again
      // listener and it is not an ancestor of this, so nothing should reach it
      // — but a stray restart here would throw away the picture being shared.
      event.stopPropagation();
      this.onShareAction(button.dataset.shareAction ?? '');
    });
  }

  /**
   * Decides the awards from the final rows.
   *
   * Three, not two, and deliberately so: the brief asked to highlight "least hit
   * received" and "most hit", which reads either as the best shot or as the
   * booby prize depending on how you parse it. Showing all three answers the
   * question instead of guessing at it — and "most painted" is the one most in
   * keeping with a game whose scoreboard says nobody wins.
   *
   * Each is suppressed when nobody has earned it. An award for landing the most
   * hits, given to somebody who landed none, is worse than no award.
   */
  static awardsFor(rows: readonly ScoreRow[]): Award[] {
    if (rows.length === 0) return [];
    const awards: Award[] = [];

    const best = rows.reduce((a, b) => (b.hitsGiven > a.hitsGiven ? b : a));
    if (best.hitsGiven > 0) {
      awards.push({
        id: best.id,
        label: 'sharpshooter',
        detail: `${best.label} — ${best.hitsGiven} tagged`,
      });
    }

    const cleanest = rows.reduce((a, b) => (b.hitsTaken < a.hitsTaken ? b : a));
    awards.push({
      id: cleanest.id,
      label: 'cleanest',
      detail:
        cleanest.hitsTaken === 0
          ? `${cleanest.label} — not a mark on them`
          : `${cleanest.label} — only ${cleanest.hitsTaken}`,
    });

    const messiest = rows.reduce((a, b) => (b.hitsTaken > a.hitsTaken ? b : a));
    if (messiest.hitsTaken > 0 && messiest.id !== cleanest.id) {
      awards.push({
        id: messiest.id,
        label: 'most painted',
        detail: `${messiest.label} — ${messiest.hitsTaken} times`,
      });
    }

    return awards;
  }

  show(
    title: string,
    rows: readonly ScoreRow[],
    splatsById: Map<string, number>,
    screen: PaintScreen | null,
  ): void {
    const sorted = [...rows].sort((a, b) => b.hitsGiven - a.hitsGiven || a.hitsTaken - b.hitsTaken);
    const awards = ResultsPanel.awardsFor(rows);
    const awarded = new Set(awards.map((award) => award.id));

    this.title.textContent = title;

    this.awards.innerHTML = awards
      .map((award) => {
        const row = rows.find((candidate) => candidate.id === award.id);
        const swatch = hex(row?.color ?? 0xffffff);
        return `<div class="results__award">
          <i class="results__swatch" style="background:${swatch}"></i>
          <span class="results__award-label">${award.label}</span>
          <span class="results__award-detail">${award.detail}</span>
        </div>`;
      })
      .join('');

    this.body.innerHTML = sorted
      .map((row) => {
        const classes = [
          'results__row',
          row.isPlayer ? 'is-player' : '',
          awarded.has(row.id) ? 'is-awarded' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<div class="${classes}">
          <span class="results__name">
            <i class="results__swatch" style="background:${hex(row.color)}"></i>${row.label}
          </span>
          <span class="results__given">${row.hitsGiven}</span>
          <span class="results__taken">${row.hitsTaken}</span>
          <span class="results__splats">${splatsById.get(row.id) ?? 0}</span>
        </div>`;
      })
      .join('');

    this.showMural(screen);
    this.root.classList.add('is-visible');
  }

  hide(): void {
    this.root.classList.remove('is-visible');
    this.releaseDownload();
  }

  get isVisible(): boolean {
    return this.root.classList.contains('is-visible');
  }

  /**
   * How much of the viewport's height the card covers, as a fraction.
   *
   * `ResultsStage` frames the line-up above whatever this returns. See
   * `setPanelShare` there for why it is measured and not assumed.
   */
  get heightFraction(): number {
    const height = this.root.querySelector('.results__card')?.getBoundingClientRect().height ?? 0;
    const viewport = this.root.parentElement?.clientHeight ?? window.innerHeight;
    if (viewport <= 0) return 0;
    // Plus the gap the card is inset from the bottom of the screen.
    return (height + 22) / viewport;
  }

  /**
   * Puts the round's mural on the card and builds the row of things to do with
   * it.
   *
   * The PNG is built *here*, when the card appears, and not in the click
   * handler that shares it. Safari spends the user's gesture across an `await`,
   * so `canvas.toBlob(...)` followed by `navigator.share(...)` fails on an
   * iPhone with a `NotAllowedError` — which is the one platform where the
   * system share sheet is the whole feature. Same reason the download URL is
   * minted up front: `window.open` after an await meets the popup blocker.
   */
  private showMural(screen: PaintScreen | null): void {
    this.releaseDownload();
    this.share.innerHTML = '';
    this.mural.hidden = screen === null;
    if (!screen) return;

    this.image.src = screen.toDataURL();

    void screen.toBlob().then((blob) => {
      // The round can end, be dismissed and restart inside the time this takes.
      if (!this.isVisible || !blob) return;
      this.file = new File([blob], 'central-park-paintball.png', { type: 'image/png' });
      this.downloadUrl = URL.createObjectURL(blob);
      this.renderShareRow();
    });
  }

  /**
   * The share row, built from what this browser can actually do.
   *
   * `navigator.share` with files is the real answer and the only one that
   * posts a picture anywhere in one step — it opens the system sheet, which on
   * a phone is where X, Instagram and Messages live. Everything else is the
   * desktop consolation prize, and the X button is deliberately labelled as
   * what it is: the tweet intent takes text and a URL and has never accepted an
   * image, so the picture is saved first and attached by hand.
   */
  private renderShareRow(): void {
    const file = this.file;
    if (!file) return;

    const canShareFile =
      typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    const canCopy = typeof ClipboardItem === 'function' && Boolean(navigator.clipboard?.write);

    const buttons: string[] = [];
    if (canShareFile) {
      buttons.push(button('share', 'Share the painting'));
    }
    buttons.push(button('save', 'Save PNG'));
    if (!canShareFile) {
      buttons.push(button('x', 'Post to X'));
      if (canCopy) buttons.push(button('copy', 'Copy image'));
    }

    this.share.innerHTML = buttons.join('');
  }

  private onShareAction(action: string): void {
    const file = this.file;
    if (!file) return;

    switch (action) {
      case 'share':
        void navigator
          .share({ files: [file], title: SHARE_TITLE, text: SHARE_TEXT })
          // A cancelled share sheet rejects, and it is not a fault.
          .catch(() => {});
        return;
      case 'save':
        this.download();
        return;
      case 'x': {
        // Saved first, because the intent cannot carry the image itself.
        this.download();
        const params = new URLSearchParams({ text: SHARE_TEXT, url: REPO_URL });
        window.open(`https://x.com/intent/post?${params.toString()}`, '_blank', 'noopener');
        return;
      }
      case 'copy':
        void navigator.clipboard
          .write([new ClipboardItem({ 'image/png': file })])
          .then(() => this.flash('copy', 'Copied'))
          .catch(() => this.flash('copy', "Browser wouldn't"));
        return;
      default:
    }
  }

  private download(): void {
    if (!this.downloadUrl) return;
    const link = document.createElement('a');
    link.href = this.downloadUrl;
    link.download = 'central-park-paintball.png';
    link.click();
  }

  /** Says what happened on the button that was pressed, then puts it back. */
  private flash(action: string, message: string): void {
    const button = this.share.querySelector(`[data-share-action="${action}"]`);
    if (!(button instanceof HTMLElement)) return;
    const original = button.textContent;
    button.textContent = message;
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 1600);
  }

  private releaseDownload(): void {
    if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
    this.downloadUrl = null;
    this.file = null;
  }

  private get title(): HTMLElement {
    return this.root.querySelector('[data-results-title]')!;
  }

  private get awards(): HTMLElement {
    return this.root.querySelector('[data-results-awards]')!;
  }

  private get body(): HTMLElement {
    return this.root.querySelector('[data-results-body]')!;
  }

  private get mural(): HTMLElement {
    return this.root.querySelector('[data-results-mural]')!;
  }

  private get image(): HTMLImageElement {
    return this.root.querySelector('[data-results-image]')!;
  }

  private get share(): HTMLElement {
    return this.root.querySelector('[data-results-share]')!;
  }

  dispose(): void {
    this.releaseDownload();
    this.root.remove();
  }
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function button(action: string, label: string): string {
  return `<button type="button" class="results__share-button" data-share-action="${action}">${label}</button>`;
}
