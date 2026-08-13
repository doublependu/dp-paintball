import { match as matchConfig } from '../core/Config';
import { isTouchDevice } from '../core/Device';

/**
 * Kept in one place, because the round-over state swaps them and swaps back.
 *
 * The hint is only ever on screen while the player is *not* playing, which on a
 * phone is exactly when the tap-to-play card is up saying the same thing in
 * larger type. So there is no touch wording here: the hint is left out of that
 * build entirely and `TouchControls` carries the message.
 */
const LIVE_HINT =
  'click to play &nbsp;·&nbsp; wasd move &nbsp;·&nbsp; click fire &nbsp;·&nbsp; ' +
  'right-click aim &nbsp;·&nbsp; t wave &nbsp;·&nbsp; tab scores';
const LIVE_SCOREBOARD_TITLE = 'Nobody wins. Everybody gets messy.';

export interface ScoreRow {
  id: string;
  label: string;
  color: number;
  hitsGiven: number;
  hitsTaken: number;
  isPlayer: boolean;
}

/**
 * The heads-up display.
 *
 * Plain DOM rather than canvas or in-scene geometry: text stays crisp at any
 * resolution for free, layout is CSS instead of hand-rolled measurement, and
 * none of it costs a draw call in the render pipeline.
 *
 * There is no health bar because nobody can be hurt. The only numbers that
 * exist are how often you tagged someone and how often you were tagged, which
 * is the whole scoreboard.
 */
export class Hud {
  private root: HTMLDivElement;
  private clock: HTMLDivElement;
  private ammoValue: HTMLSpanElement;
  private givenValue: HTMLSpanElement;
  private takenValue: HTMLSpanElement;
  private toast: HTMLDivElement;
  private scoreboard: HTMLDivElement;
  private scoreboardBody: HTMLDivElement;
  private hint: HTMLDivElement;

  private toastTimer = 0;
  private roundOver = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';

    this.root.innerHTML = `
      <div class="hud__viewport-crosshair" aria-hidden="true"></div>
      <div class="hud__clock" data-clock>5:00</div>
      <div class="hud__counters">
        <div class="hud__counter hud__counter--ammo">
          <span class="hud__value" data-ammo>0</span>
          <span class="hud__label">paint left</span>
        </div>
        <div class="hud__counter hud__counter--given">
          <span class="hud__value" data-given>0</span>
          <span class="hud__label">tagged them</span>
        </div>
        <div class="hud__counter hud__counter--taken">
          <span class="hud__value" data-taken>0</span>
          <span class="hud__label">tagged you</span>
        </div>
      </div>
      <div class="hud__toast" data-toast></div>
      <div class="hud__hint" data-hint>${LIVE_HINT}</div>
      <div class="hud__scoreboard" data-scoreboard>
        <div class="hud__scoreboard-title">${LIVE_SCOREBOARD_TITLE}</div>
        <div class="hud__scoreboard-head">
          <span>player</span><span>tagged them</span><span>tagged</span>
        </div>
        <div class="hud__scoreboard-body" data-scoreboard-body></div>
      </div>
    `;

    container.append(this.root);

    this.clock = this.root.querySelector('[data-clock]')!;
    this.ammoValue = this.root.querySelector('[data-ammo]')!;
    this.givenValue = this.root.querySelector('[data-given]')!;
    this.takenValue = this.root.querySelector('[data-taken]')!;
    this.toast = this.root.querySelector('[data-toast]')!;
    this.scoreboard = this.root.querySelector('[data-scoreboard]')!;
    this.scoreboardBody = this.root.querySelector('[data-scoreboard-body]')!;
    this.hint = this.root.querySelector('[data-hint]')!;
    // See the note on LIVE_HINT. The reference is kept so the setters below
    // stay unconditional; they simply operate on a node nobody can see.
    if (isTouchDevice()) this.hint.remove();
  }

  /**
   * Paint remaining. `Infinity` — sandbox mode — draws as an infinity sign
   * rather than as a number, because "Infinity" in a HUD reads as a bug.
   */
  setAmmo(remaining: number): void {
    const text = Number.isFinite(remaining) ? String(remaining) : '∞';
    if (this.ammoValue.textContent === text) return;
    this.ammoValue.textContent = text;
    this.ammoValue.classList.toggle('is-low', remaining > 0 && remaining <= matchConfig.lowAmmo);
    this.ammoValue.classList.toggle('is-empty', remaining <= 0);
    this.pulse(this.ammoValue);
  }

  /** Hidden outright in the sandbox, where a frozen 5:00 would be a lie. */
  setClockVisible(visible: boolean): void {
    this.clock.classList.toggle('is-hidden', !visible);
  }

  /**
   * The round clock, as m:ss.
   *
   * Rounded up, not down, so it reads 5:00 for the first second rather than
   * 4:59, and never shows 0:00 while there is still time to play.
   */
  setClock(secondsLeft: number): void {
    const total = Math.max(0, Math.ceil(secondsLeft));
    const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    if (this.clock.textContent === text) return;
    this.clock.textContent = text;
    this.clock.classList.toggle('is-urgent', total <= matchConfig.urgentAtSeconds && total > 0);
  }

  /**
   * Hides or restores everything that only means something mid-round — the
   * clock, the counters, the crosshair, any lingering toast.
   *
   * The results card is the only thing on screen between rounds, and a live
   * ammo count under it is just noise. `roundOver` also latches the Tab
   * scoreboard shut, because the card already *is* the scoreboard.
   */
  setPlayingChromeVisible(visible: boolean): void {
    this.roundOver = !visible;
    this.root.classList.toggle('is-round-over', !visible);
    if (!visible) {
      // Almost always "1 minute left!", which would otherwise sit under the card.
      this.toastTimer = 0;
      this.toast.classList.remove('is-visible');
      this.scoreboard.classList.remove('is-visible');
    }
  }

  setCounters(given: number, taken: number): void {
    if (this.givenValue.textContent !== String(given)) {
      this.givenValue.textContent = String(given);
      this.pulse(this.givenValue);
    }
    if (this.takenValue.textContent !== String(taken)) {
      this.takenValue.textContent = String(taken);
      this.pulse(this.takenValue);
    }
  }

  /** Restarts the bump animation, which needs a reflow to replay. */
  private pulse(element: HTMLElement): void {
    element.classList.remove('is-bumped');
    void element.offsetWidth;
    element.classList.add('is-bumped');
  }

  showToast(message: string, color: number, seconds = 1.6): void {
    this.toast.textContent = message;
    this.toast.style.color = `#${color.toString(16).padStart(6, '0')}`;
    this.toast.classList.add('is-visible');
    this.toastTimer = seconds;
  }

  setHintVisible(visible: boolean): void {
    this.hint.classList.toggle('is-hidden', !visible);
  }

  /** Ignored once the round is over: the final board does not close. */
  setScoreboardVisible(visible: boolean): void {
    if (this.roundOver) return;
    this.scoreboard.classList.toggle('is-visible', visible);
  }

  updateScoreboard(rows: ScoreRow[]): void {
    const sorted = [...rows].sort((a, b) => b.hitsGiven - a.hitsGiven);
    this.scoreboardBody.innerHTML = sorted
      .map((row) => {
        const swatch = `#${row.color.toString(16).padStart(6, '0')}`;
        return `<div class="hud__score-row${row.isPlayer ? ' is-player' : ''}">
          <span class="hud__score-name">
            <i class="hud__swatch" style="background:${swatch}"></i>${row.label}
          </span>
          <span class="hud__score-given">${row.hitsGiven}</span>
          <span class="hud__score-taken">${row.hitsTaken}</span>
        </div>`;
      })
      .join('');
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('is-visible');
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
