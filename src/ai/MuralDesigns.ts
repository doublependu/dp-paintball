/**
 * What a bot paints when it decides to paint something.
 *
 * A design is a set of strokes in a unit square, drawn in the order a person
 * would draw them: outline first, features after. The bot walks the dots in
 * that order and fires one paintball at each, so the picture appears the way it
 * was written down here — which is most of why watching one is worth anything.
 *
 * Unit space runs 0..1 with **y downward**, matching the mural's own uv rather
 * than the world, because every consumer of this file is placing paint on a
 * canvas and none of them is thinking in metres.
 *
 * The vocabulary is deliberately small and blunt. A paintball is a 50cm blob;
 * anything that needs a thin line or a small feature to read will not survive
 * being drawn with them, so these are all things that survive at about a dozen
 * blobs across: a sun, a heart, a face, a house. The two designs that were
 * tried and dropped were a five-pointed star, whose points close up into a
 * pentagon, and lettering below about half the box height.
 */

/** One continuous line, or a single dot when it holds one point. */
export interface Stroke {
  points: Array<readonly [number, number]>;
  /** Whether the last point joins back to the first. */
  closed?: boolean;
}

export interface MuralDesign {
  name: string;
  strokes: Stroke[];
  /**
   * The smallest box side, in metres, this design still reads at.
   *
   * A legibility floor rather than a preference. Every stroke is drawn in 54cm
   * blobs whatever the box is, so shrinking the box does not shrink the marks —
   * it closes the gaps between them, and past some point the drawing is a lumpy
   * disc. Measured as the fraction of the drawing's own bounding area that ends
   * up inked: the shipped catalogue spans 30-56% at the 4.6m slot the bots used
   * to get, so 57% is a fill already accepted as readable, and each floor here
   * is the smallest box at which that design stays under it.
   *
   * `designsForBox` is what reads it. Declared per design rather than kept as a
   * second list of names, so a new drawing states its own floor next to itself.
   */
  minBox: number;
}

// --- little builders ---------------------------------------------------------

function circle(cx: number, cy: number, r: number, segments = 24): Stroke {
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return { points, closed: true };
}

/** Angles in radians, measured clockwise from east because y runs down. */
function arc(cx: number, cy: number, r: number, from: number, to: number, segments = 10): Stroke {
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const a = from + ((to - from) * i) / segments;
    points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return { points };
}

function line(...points: Array<readonly [number, number]>): Stroke {
  return { points };
}

function dot(x: number, y: number): Stroke {
  return { points: [[x, y]] };
}

function polygon(...points: Array<readonly [number, number]>): Stroke {
  return { points, closed: true };
}

// --- the catalogue -----------------------------------------------------------

const SUN: MuralDesign = {
  name: 'sun',
  minBox: 2.6,
  strokes: [
    circle(0.5, 0.5, 0.23, 18),
    ...Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return line(
        [0.5 + Math.cos(a) * 0.32, 0.5 + Math.sin(a) * 0.32],
        [0.5 + Math.cos(a) * 0.48, 0.5 + Math.sin(a) * 0.48],
      );
    }),
  ],
};

/**
 * The usual parametric heart, sampled and squeezed into the box.
 *
 * Written out rather than approximated with two arcs and a V, because the cusp
 * at the top is the entire difference between a heart and an ice cream.
 */
const HEART: MuralDesign = {
  name: 'heart',
  minBox: 2.2,
  strokes: [
    {
      points: Array.from({ length: 26 }, (_, i) => {
        const t = (i / 26) * Math.PI * 2;
        const x = 16 * Math.sin(t) ** 3;
        const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        // The curve runs roughly -17..17 across and -17..12 up.
        return [0.5 + x / 38, 0.47 - y / 34] as const;
      }),
      closed: true,
    },
  ],
};

const SMILEY: MuralDesign = {
  name: 'smiley',
  minBox: 2.6,
  strokes: [
    circle(0.5, 0.5, 0.45, 26),
    dot(0.34, 0.37),
    dot(0.66, 0.37),
    // A mouth, in the lower half: y runs down, so this is the bottom of a circle.
    arc(0.5, 0.5, 0.26, 0.35 * Math.PI, 0.65 * Math.PI, 8),
  ],
};

/**
 * Everything here sits *outside* the head rather than over it.
 *
 * The first version had closed triangles for ears and whiskers that started at
 * the muzzle, both of which crossed the head circle. At 45cm a mark, two lines
 * 20cm apart are one line, and the whole thing came out as a scribbled disc.
 */
const CAT: MuralDesign = {
  name: 'cat',
  minBox: 3.4,
  strokes: [
    circle(0.5, 0.62, 0.3, 20),
    // Open ears rising off the head, rather than triangles laid over it.
    line([0.28, 0.44], [0.26, 0.1], [0.48, 0.35]),
    line([0.72, 0.44], [0.74, 0.1], [0.52, 0.35]),
    dot(0.4, 0.57),
    dot(0.6, 0.57),
    dot(0.5, 0.68),
    line([0.04, 0.6], [0.19, 0.65]),
    line([0.04, 0.76], [0.19, 0.71]),
    line([0.96, 0.6], [0.81, 0.65]),
    line([0.96, 0.76], [0.81, 0.71]),
  ],
};

const TREE: MuralDesign = {
  name: 'tree',
  minBox: 4.0,
  strokes: [
    line([0.5, 0.98], [0.5, 0.78]),
    line([0.28, 0.78], [0.5, 0.5], [0.72, 0.78], [0.28, 0.78]),
    line([0.32, 0.55], [0.5, 0.28], [0.68, 0.55]),
    line([0.36, 0.36], [0.5, 0.08], [0.64, 0.36]),
  ],
};

const HOUSE: MuralDesign = {
  name: 'house',
  minBox: 4.0,
  strokes: [
    polygon([0.22, 0.96], [0.22, 0.52], [0.78, 0.52], [0.78, 0.96]),
    line([0.12, 0.52], [0.5, 0.14], [0.88, 0.52]),
    polygon([0.42, 0.96], [0.42, 0.72], [0.58, 0.72], [0.58, 0.96]),
  ],
};

const FISH: MuralDesign = {
  name: 'fish',
  minBox: 4.5,
  strokes: [
    {
      points: Array.from({ length: 20 }, (_, i) => {
        const a = (i / 20) * Math.PI * 2;
        return [0.46 + Math.cos(a) * 0.3, 0.5 + Math.sin(a) * 0.19] as const;
      }),
      closed: true,
    },
    polygon([0.76, 0.5], [0.96, 0.3], [0.96, 0.7]),
    dot(0.3, 0.44),
  ],
};

/**
 * Five petals, not six, and further apart than looks right on paper.
 *
 * Six petals at a quarter-box radius overlap each other once each outline is
 * drawn in 45cm marks, and the head comes out as a filled disc with a stalk.
 */
const FLOWER: MuralDesign = {
  name: 'flower',
  minBox: 3.4,
  strokes: [
    ...Array.from({ length: 5 }, (_, i) => {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      return circle(0.5 + Math.cos(a) * 0.22, 0.35 + Math.sin(a) * 0.22, 0.11, 9);
    }),
    dot(0.5, 0.35),
    line([0.5, 0.52], [0.53, 0.98]),
    line([0.52, 0.78], [0.76, 0.7]),
  ],
};

const GULL: MuralDesign = {
  name: 'gulls',
  minBox: 2.0,
  strokes: [
    line([0.06, 0.42], [0.24, 0.24], [0.42, 0.42]),
    line([0.42, 0.42], [0.6, 0.24], [0.78, 0.42]),
    line([0.38, 0.78], [0.52, 0.64], [0.66, 0.78]),
  ],
};

const BALLOON: MuralDesign = {
  name: 'balloon',
  minBox: 2.2,
  strokes: [
    circle(0.5, 0.32, 0.27, 18),
    polygon([0.46, 0.59], [0.54, 0.59], [0.5, 0.66]),
    line([0.5, 0.66], [0.6, 0.76], [0.44, 0.86], [0.56, 0.98]),
  ],
};

const MUSHROOM: MuralDesign = {
  name: 'mushroom',
  minBox: 3.0,
  strokes: [
    arc(0.5, 0.56, 0.42, Math.PI, Math.PI * 2, 14),
    line([0.08, 0.56], [0.92, 0.56]),
    line([0.36, 0.56], [0.36, 0.94], [0.64, 0.94], [0.64, 0.56]),
    dot(0.36, 0.36),
    dot(0.62, 0.3),
  ],
};

const CLOUD: MuralDesign = {
  name: 'cloud',
  minBox: 3.4,
  strokes: [
    arc(0.32, 0.5, 0.2, Math.PI, Math.PI * 2, 8),
    arc(0.52, 0.42, 0.26, Math.PI * 1.05, Math.PI * 2, 10),
    arc(0.74, 0.52, 0.18, Math.PI, Math.PI * 2, 8),
    line([0.12, 0.5], [0.92, 0.52]),
    // Rain, because a cloud alone is a blob with a flat bottom.
    line([0.3, 0.64], [0.24, 0.82]),
    line([0.52, 0.68], [0.46, 0.88]),
    line([0.72, 0.64], [0.66, 0.82]),
  ],
};

/** Everything a bot might decide to paint, other than its own initial. */
export const MURAL_DESIGNS: readonly MuralDesign[] = [
  SUN,
  HEART,
  SMILEY,
  CAT,
  TREE,
  HOUSE,
  FISH,
  FLOWER,
  GULL,
  BALLOON,
  MUSHROOM,
  CLOUD,
];

/**
 * A stroke alphabet, for a painter signing its work.
 *
 * Only the letters this game's roster actually starts with. A general font is
 * not the job — `letterDesign` falls back to a picture for anything missing,
 * which is also what happens for the player's own "you".
 *
 * Each glyph carries its own `minBox`, measured the same way the pictures' are.
 * They are not interchangeable: an open C is the sparsest mark in the whole
 * catalogue and reads in two metres, while a B is two closed bowls against an
 * upright and closes into a blob well before a corner's size.
 */
const LETTERS: Record<string, { minBox: number; strokes: Stroke[] }> = {
  A: {
    minBox: 2.0,
    strokes: [line([0.16, 0.96], [0.5, 0.08], [0.84, 0.96]), line([0.29, 0.6], [0.71, 0.6])],
  },
  B: {
    minBox: 3.6,
    strokes: [
      line([0.24, 0.96], [0.24, 0.08], [0.62, 0.08]),
      arc(0.62, 0.3, 0.22, -Math.PI / 2, Math.PI / 2, 7),
      line([0.62, 0.52], [0.24, 0.52]),
      arc(0.6, 0.74, 0.22, -Math.PI / 2, Math.PI / 2, 7),
      line([0.6, 0.96], [0.24, 0.96]),
    ],
  },
  C: { minBox: 2.0, strokes: [arc(0.52, 0.52, 0.4, Math.PI * 0.3, Math.PI * 1.7, 14)] },
  D: {
    minBox: 2.4,
    strokes: [
      line([0.26, 0.96], [0.26, 0.08], [0.5, 0.08]),
      arc(0.5, 0.52, 0.44, -Math.PI / 2, Math.PI / 2, 12),
      line([0.5, 0.96], [0.26, 0.96]),
    ],
  },
  E: {
    minBox: 2.6,
    strokes: [
      line([0.76, 0.08], [0.26, 0.08], [0.26, 0.96], [0.76, 0.96]),
      line([0.26, 0.52], [0.66, 0.52]),
    ],
  },
  F: {
    minBox: 2.0,
    strokes: [line([0.76, 0.08], [0.26, 0.08], [0.26, 0.96]), line([0.26, 0.5], [0.66, 0.5])],
  },
  G: {
    minBox: 2.2,
    strokes: [
      arc(0.52, 0.52, 0.4, Math.PI * 0.3, Math.PI * 1.7, 14),
      line([0.52, 0.52], [0.92, 0.52]),
    ],
  },
  H: {
    minBox: 3.0,
    strokes: [
      line([0.24, 0.08], [0.24, 0.96]),
      line([0.76, 0.08], [0.76, 0.96]),
      line([0.24, 0.52], [0.76, 0.52]),
    ],
  },
};

/**
 * The painter's initial as a design, or null when there is no glyph for it.
 *
 * An initial in the corner of a mural is the most sign-like thing a painter can
 * leave, which is why `mural.letterChance` went up when the slots shrank — but
 * the caller still has to check the glyph's own `minBox`, because a B does not
 * survive a corner and a C sails through it.
 */
export function letterDesign(initial: string): MuralDesign | null {
  const glyph = LETTERS[initial.toUpperCase()];
  if (!glyph) return null;
  return {
    name: `letter ${initial.toUpperCase()}`,
    strokes: glyph.strokes,
    minBox: glyph.minBox,
  };
}

/**
 * The designs that still read in a box this size, smallest side in metres.
 *
 * At the 2.6m corner the bots now get, this is six of the twelve: the dense
 * half of the catalogue closes up into the lumpy disc the `CAT` and `FLOWER`
 * comments describe from the last time this was got wrong. Falls back to the
 * whole catalogue rather than to nothing, so a future slot smaller than every
 * floor still gets a drawing instead of a crash.
 */
export function designsForBox(box: number): readonly MuralDesign[] {
  const fits = MURAL_DESIGNS.filter((design) => design.minBox <= box + 1e-6);
  return fits.length > 0 ? fits : MURAL_DESIGNS;
}

/**
 * Turns a design into the list of places to shoot, in drawing order.
 *
 * Spacing is given in metres and the box is measured in metres, because the
 * thing that has to look right is the overlap between two splats in the park —
 * a design resampled in unit space would come out with a different stroke
 * weight on a board of a different shape.
 *
 * Points come back in unit space, which is what the caller maps onto its slot.
 *
 * `maxDots` is a budget, not a suggestion: a bot painting stands still in the
 * open, and a design that takes a minute is a bot that spends the round as a
 * target. Over budget, the spacing opens up until it fits — a sparser drawing
 * of the same thing rather than half a drawing.
 */
export function dotsFor(
  design: MuralDesign,
  boxWidth: number,
  boxHeight: number,
  spacing: number,
  maxDots: number,
): Array<readonly [number, number]> {
  let step = spacing;
  for (let attempt = 0; attempt < 6; attempt++) {
    const dots = rasterise(design, boxWidth, boxHeight, step);
    if (dots.length <= maxDots) return dots;
    step *= 1.25;
  }
  return rasterise(design, boxWidth, boxHeight, step).slice(0, maxDots);
}

function rasterise(
  design: MuralDesign,
  boxWidth: number,
  boxHeight: number,
  step: number,
): Array<readonly [number, number]> {
  const dots: Array<readonly [number, number]> = [];

  for (const stroke of design.strokes) {
    const points = stroke.points;
    if (points.length === 0) continue;
    if (points.length === 1) {
      dots.push(points[0]!);
      continue;
    }

    const path = stroke.closed ? [...points, points[0]!] : points;
    // Carried between segments, so a corner does not always get a dot and a
    // short segment does not always lose one.
    let carry = 0;
    dots.push(path[0]!);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const dx = (b[0] - a[0]) * boxWidth;
      const dy = (b[1] - a[1]) * boxHeight;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;

      let travelled = step - carry;
      while (travelled <= length) {
        const t = travelled / length;
        dots.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        travelled += step;
      }
      carry = length - (travelled - step);
    }
  }

  return dots;
}
