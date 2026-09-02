import { CanvasTexture, SRGBColorSpace } from 'three';
import { Rng } from '../core/Random';

/**
 * The lettering on the park's signs, painted into a canvas at boot.
 *
 * Drawn rather than shipped as an image for the same reason the splat atlas is:
 * it costs a millisecond and no download, and the copy stays editable as text
 * instead of as a PNG somebody has to open Photoshop for.
 *
 * The look is the game's look done in 2D — cream letters cut out of a painted
 * board, each one stroked in ink and set down at a slightly wrong angle. Type
 * laid out perfectly straight is the one thing that would read as a screenshot
 * of a web page glued onto a park sign.
 *
 * Two boards come out of here and the machinery is identical: the dedication
 * plaque by the fountain, and the place markers that name the park's corners.
 * They differ in proportion and in copy, and in nothing else — a place name is
 * one short line, so it wants a board nearly three times as wide as it is tall,
 * where a two-line dedication wants 2:1.
 */

const PLAQUE_WIDTH = 1024;
const PLAQUE_HEIGHT = 512;

/** Board proportions the geometry has to match, or the lettering stretches. */
export const PLAQUE_ASPECT = PLAQUE_WIDTH / PLAQUE_HEIGHT;

const PLACE_WIDTH = 512;
const PLACE_HEIGHT = 176;

/** The same, for a place marker. About 2.9:1 — a park sign, not a plaque. */
export const PLACE_PLAQUE_ASPECT = PLACE_WIDTH / PLACE_HEIGHT;

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

/**
 * The height every hardcoded pixel size below was chosen against.
 *
 * The border inset, its two stroke weights, the bolt heads and the text margin
 * are all in pixels, and all of them are really fractions of the board. Scaling
 * them by the board's own height rather than restating them per size keeps the
 * 176px place marker looking like the 512px plaque shrunk, instead of like the
 * same board with a hairline border and no margin.
 */
const REFERENCE_HEIGHT = 512;

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
 * The dedication's copy. `®` is picked out of the string and set small and
 * raised wherever it appears, so the mark sits against the name it belongs to.
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
  // Fixed seed: the wobble is meant to look hand-made, not to be different on
  // every load — a sign that re-letters itself when you reload is a bug.
  return paintPlaque(LINES, PLAQUE_WIDTH, PLAQUE_HEIGHT, 0x51c14);
}

/**
 * A board naming one place in the park, and the proportions it was drawn at.
 *
 * The seed comes from the name rather than from a counter, for the same reason
 * the dedication's is fixed: every marker is hand-made, and the same marker is
 * hand-made the same way on every reload.
 */
export function createPlaceSignTexture(name: string): {
  texture: CanvasTexture;
  aspect: number;
} {
  const line: Line = {
    text: name,
    size: PLACE_HEIGHT * 0.52,
    baseline: PLACE_HEIGHT * 0.68,
    tracking: 0.05,
  };
  return {
    texture: paintPlaque([line], PLACE_WIDTH, PLACE_HEIGHT, hashSeed(name)),
    aspect: PLACE_PLAQUE_ASPECT,
  };
}

/** Everything both boards have in common: the timber, the border, the type. */
function paintPlaque(
  lines: readonly Line[],
  width: number,
  height: number,
  seed: number,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('SignPlaque: no 2D context');

  const rng = new Rng(seed);
  const scale = height / REFERENCE_HEIGHT;

  paintBoard(ctx, rng, width, height, scale);
  drawBorder(ctx, rng, width, height, scale);
  // Widest the lettering may run, leaving the border its margin.
  const textWidth = width - REFERENCE_HEIGHT * 0.293 * scale;
  for (const line of lines) drawLine(ctx, rng, line, width, textWidth);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // The sign is read at an angle more often than head-on, and without this the
  // small print smears into a grey band from two steps off the axis.
  texture.anisotropy = 8;
  return texture;
}

/**
 * A stable 32-bit seed from a name (FNV-1a).
 *
 * Any hash would do; what matters is that it is a pure function of the copy, so
 * "Bow Bridge" wobbles the same way in every session and two markers never come
 * out as the same board with different words on it.
 */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Board colour, plus grain streaks along the plank. */
function paintBoard(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  width: number,
  height: number,
  scale: number,
): void {
  ctx.fillStyle = BOARD;
  ctx.fillRect(0, 0, width, height);

  const streaks = Math.round(70 * ((width * height) / (PLAQUE_WIDTH * PLAQUE_HEIGHT)));
  for (let i = 0; i < streaks; i++) {
    ctx.globalAlpha = rng.range(0.02, 0.07);
    ctx.fillStyle = rng.bool(0.55) ? '#000000' : '#ffffff';
    ctx.fillRect(0, rng.range(0, height), width, rng.range(2, 10) * scale);
  }
  ctx.globalAlpha = 1;
}

/** A painted border, drawn as a wobbling rectangle and inked on the outside. */
function drawBorder(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  width: number,
  height: number,
  scale: number,
): void {
  const inset = 30 * scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  tracePath(ctx, rng, width, height, inset, 5 * scale, 64 * scale);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 16 * scale;
  ctx.stroke();
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 7 * scale;
  ctx.stroke();

  // Bolt heads at the corners, where a real board is fixed to its posts.
  const bolt = 26 * scale;
  for (const [bx, by] of [
    [inset + bolt, inset + bolt], [width - inset - bolt, inset + bolt],
    [inset + bolt, height - inset - bolt], [width - inset - bolt, height - inset - bolt],
  ] as const) {
    ctx.beginPath();
    ctx.arc(bx, by, 9 * scale, 0, Math.PI * 2);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.lineWidth = 4 * scale;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
}

/**
 * Lays down a rectangle as a run of short segments, each corner jittered.
 * A perfectly straight painted line is the tell that no hand was involved.
 */
function tracePath(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  width: number,
  height: number,
  inset: number,
  amp: number,
  step: number,
): void {
  const left = inset;
  const right = width - inset;
  const top = inset;
  const bottom = height - inset;

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
function drawLine(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  line: Line,
  width: number,
  textWidth: number,
): void {
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
  // the board by a good 15%. Place names vary in length besides — "The Mall"
  // and "Bethesda Fountain" are set on the same board.
  let size = line.size;
  let total = measure(size);
  if (total > textWidth) {
    size *= textWidth / total;
    total = measure(size);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  let x = (width - total) / 2;
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
