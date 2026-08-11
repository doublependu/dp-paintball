import { CanvasTexture, SRGBColorSpace } from 'three';
import { Rng } from '../core/Random';

/**
 * The lettering on the park's dedication sign, painted into a canvas at boot.
 *
 * Drawn rather than shipped as an image for the same reason the splat atlas is:
 * it costs a millisecond and no download, and the copy stays editable as text
 * instead of as a PNG somebody has to open Photoshop for.
 *
 * The look is the game's look done in 2D — cream letters cut out of a painted
 * board, each one stroked in ink and set down at a slightly wrong angle. Type
 * laid out perfectly straight is the one thing that would read as a screenshot
 * of a web page glued onto a park sign.
 */

const WIDTH = 1024;
const HEIGHT = 512;

/** Board proportions the geometry has to match, or the lettering stretches. */
export const PLAQUE_ASPECT = WIDTH / HEIGHT;

/** Matches the HUD's stack, so the game speaks in one typeface. */
const FONT = '"Segoe UI Rounded", ui-rounded, "Hiragino Maru Gothic ProN", "Trebuchet MS", Verdana, sans-serif';

/**
 * The attribution line, set against the name rather than with it. A serif at
 * half the size reads as the small line a signwriter puts above the main event,
 * which is the whole job of "MADE BY" — the eye should land on the name.
 */
const CREDIT_FONT = 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif';

const BOARD = '#2c4636';
const CREAM = '#f4e9d0';
const INK = '#14201a';

/** Widest the lettering may run, leaving the border its margin. */
const TEXT_WIDTH = WIDTH - 150;

interface Line {
  text: string;
  /** Font size in pixels, before any shrink-to-fit. */
  size: number;
  /** Baseline, in pixels from the top of the plaque. */
  baseline: number;
  /** Space between glyphs, as a fraction of the size. */
  tracking?: number;
  /** Defaults to the game's own stack. */
  font?: string;
}

/**
 * The copy. `®` is picked out of the string and set small and raised wherever
 * it appears, so the mark sits against the name it belongs to.
 *
 * Baselines set the two lines as one block on the middle of the board rather
 * than filling it: a name with air above and below it reads as a dedication,
 * and a board packed to its border reads as a notice about dog fouling.
 */
const LINES: readonly Line[] = [
  { text: 'Made by', size: 62, baseline: 206, tracking: 0.14, font: CREDIT_FONT },
  { text: 'MAN AND BOT®', size: 152, baseline: 372 },
];

interface Glyph {
  ch: string;
  /** Size multiplier — the registered mark is set small. */
  scale: number;
  /** Baseline lift in pixels, so the mark rides as a superscript. */
  rise: number;
  width: number;
}

export function createSignPlaqueTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('SignPlaque: no 2D context');

  // Fixed seed: the wobble is meant to look hand-made, not to be different on
  // every load — a sign that re-letters itself when you reload is a bug.
  const rng = new Rng(0x51c14);

  paintBoard(ctx, rng);
  drawBorder(ctx, rng);
  for (const line of LINES) drawLine(ctx, rng, line);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // The sign is read at an angle more often than head-on, and without this the
  // small print smears into a grey band from two steps off the axis.
  texture.anisotropy = 8;
  return texture;
}

/** Board colour, plus grain streaks along the plank. */
function paintBoard(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = BOARD;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (let i = 0; i < 70; i++) {
    ctx.globalAlpha = rng.range(0.02, 0.07);
    ctx.fillStyle = rng.bool(0.55) ? '#000000' : '#ffffff';
    ctx.fillRect(0, rng.range(0, HEIGHT), WIDTH, rng.range(2, 10));
  }
  ctx.globalAlpha = 1;
}

/** A painted border, drawn as a wobbling rectangle and inked on the outside. */
function drawBorder(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const inset = 30;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  tracePath(ctx, rng, inset, 5);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 7;
  ctx.stroke();

  // Bolt heads at the corners, where a real board is fixed to its posts.
  for (const [bx, by] of [
    [inset + 26, inset + 26], [WIDTH - inset - 26, inset + 26],
    [inset + 26, HEIGHT - inset - 26], [WIDTH - inset - 26, HEIGHT - inset - 26],
  ] as const) {
    ctx.beginPath();
    ctx.arc(bx, by, 9, 0, Math.PI * 2);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
}

/**
 * Lays down a rectangle as a run of short segments, each corner jittered.
 * A perfectly straight painted line is the tell that no hand was involved.
 */
function tracePath(ctx: CanvasRenderingContext2D, rng: Rng, inset: number, amp: number): void {
  const left = inset;
  const right = WIDTH - inset;
  const top = inset;
  const bottom = HEIGHT - inset;
  const step = 64;

  const points: Array<[number, number]> = [];
  const edge = (
    x0: number, y0: number, x1: number, y1: number,
  ): void => {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(2, Math.round(length / step));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      points.push([x0 + (x1 - x0) * t + rng.spread(amp), y0 + (y1 - y0) * t + rng.spread(amp)]);
    }
  };

  edge(left, top, right, top);
  edge(right, top, right, bottom);
  edge(right, bottom, left, bottom);
  edge(left, bottom, left, top);

  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
}

/** Sets one line, glyph by glyph, shrinking it if it would run off the board. */
function drawLine(ctx: CanvasRenderingContext2D, rng: Rng, line: Line): void {
  const glyphs: Glyph[] = [...line.text].map((ch) => ({
    ch,
    scale: ch === '®' ? 0.36 : 1,
    rise: ch === '®' ? line.size * 0.48 : 0,
    width: 0,
  }));

  const tracking = (line.tracking ?? 0.06) * line.size;
  const font = line.font ?? FONT;

  /** Measures at `size`, filling in glyph widths, and returns the total run. */
  const measure = (size: number): number => {
    let total = -tracking;
    for (const glyph of glyphs) {
      ctx.font = `700 ${size * glyph.scale}px ${font}`;
      glyph.width = ctx.measureText(glyph.ch).width;
      total += glyph.width + tracking;
    }
    return total;
  };

  // Shrink to fit rather than trusting the sizes above: which font actually
  // answers the stack depends on the machine, and the widest of them overruns
  // the board by a good 15%.
  let size = line.size;
  let total = measure(size);
  if (total > TEXT_WIDTH) {
    size *= TEXT_WIDTH / total;
    total = measure(size);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  let x = (WIDTH - total) / 2;
  for (const glyph of glyphs) {
    ctx.save();
    ctx.translate(x + glyph.width / 2, line.baseline - glyph.rise + rng.spread(size * 0.022));
    ctx.rotate(rng.spread(0.024));
    ctx.font = `700 ${size * glyph.scale}px ${font}`;
    ctx.lineWidth = size * glyph.scale * 0.1;
    ctx.strokeStyle = INK;
    ctx.strokeText(glyph.ch, 0, 0);
    ctx.fillStyle = CREAM;
    ctx.fillText(glyph.ch, 0, 0);
    ctx.restore();
    x += glyph.width + tracking;
  }
}
