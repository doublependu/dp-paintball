import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three';
import { Rng } from '../core/Random';

/**
 * Procedural tree trunks.
 *
 * ## Why these are generated rather than loaded
 *
 * The park prop set shipped an `elm_trunk` mesh whose limbs were built the
 * wrong way up: each branch attached to the bole at a *wide* radius and
 * converged toward the trunk axis as it rose, and the bole itself was a cone
 * flaring toward the crown. Every tree in the park read as a tree standing on
 * its head — which is exactly what it was.
 *
 * Rather than patch one mesh, trunks moved into code. The park now needs many
 * more of them, in several species, at a range of sizes, and a generator gives
 * all of that for no download at all. It also makes the branching rule
 * explicit and inspectable, which is the property the broken asset lacked:
 * limbs leave the bole *on the axis* and travel up and outward, always.
 *
 * ## The species
 *
 * Reference for the elm is the Mall's allée — the park's most photographed
 * line. Those are American elms: a long clear bole, then three to five limbs
 * that leave it at a shallow angle and sweep up and out into a vase, meeting
 * overhead across the path. The oak is the opposite build — a short bole and
 * heavy, low, near-horizontal limbs. Scrub is a multi-stem thicket for the
 * Ramble and the woodland understorey.
 */
export type Species = 'elm' | 'oak' | 'scrub';

interface SpeciesSpec {
  /** Trunk height as a fraction of the tree's nominal height. */
  boleFraction: [number, number];
  /** Radius at the base, as a fraction of height. */
  baseRadius: [number, number];
  /** How much thinner the bole is at the crotch than at the ground. */
  boleTaper: [number, number];
  limbs: [number, number];
  /** Limb rise per unit outward travel. High is a narrow vase, low is a spread. */
  limbRise: [number, number];
  /** Limb length as a fraction of the bole height. */
  limbLength: [number, number];
  /** Number of stems rising from the ground. */
  stems: [number, number];
}

const SPECIES: Record<Species, SpeciesSpec> = {
  elm: {
    boleFraction: [0.5, 0.6],
    baseRadius: [0.021, 0.028],
    boleTaper: [0.62, 0.74],
    limbs: [3, 5],
    limbRise: [1.5, 2.4],
    limbLength: [0.4, 0.56],
    stems: [1, 1],
  },
  oak: {
    boleFraction: [0.3, 0.4],
    baseRadius: [0.028, 0.038],
    boleTaper: [0.66, 0.8],
    limbs: [3, 5],
    limbRise: [0.55, 1.0],
    limbLength: [0.55, 0.8],
    stems: [1, 1],
  },
  scrub: {
    boleFraction: [0.22, 0.34],
    baseRadius: [0.022, 0.032],
    boleTaper: [0.55, 0.7],
    limbs: [3, 4],
    limbRise: [0.9, 1.6],
    limbLength: [0.45, 0.65],
    stems: [2, 3],
  },
};

/**
 * Detail levels.
 *
 * The woodland belt holds four times as many trees as the park does and is
 * never seen closer than the treeline, so it gets its own build: no
 * sub-branching, four sides to a limb instead of five. The first version of
 * this generator had one level for everything and put four and a half million
 * triangles on screen — a full-detail elm is a thousand triangles, and there
 * are well over a thousand trees.
 */
export type Detail = 'near' | 'far';

/** Radial segments per limb. Five reads as round enough under an ink outline. */
const RADIAL: Record<Detail, number> = { near: 5, far: 4 };
/** Recursion depth for sub-branches, overriding the species default. */
const SPLITS: Record<Detail, number> = { near: 1, far: 0 };

/** Bark, base to tip. Twigs are greyer and lighter than the bole. */
const BARK_BASE = new Color(0x5d4b39);
const BARK_TIP = new Color(0x8d8375);

interface Segment {
  from: Vector3;
  to: Vector3;
  fromRadius: number;
  toRadius: number;
  /** 0 at the ground, 1 at the finest twig. Drives the bark gradient. */
  depth: number;
}

/**
 * One tree's worth of geometry, built as tapered tubes along a branch skeleton.
 *
 * Returned unindexed-per-tube but indexed overall: every tube contributes its
 * own ring pair, which costs a few duplicated vertices at the joints and saves
 * having to weld anything.
 */
export function buildTrunkGeometry(species: Species, rng: Rng, height: number, detail: Detail = 'near'): BufferGeometry {
  const spec = SPECIES[species];
  const splits = SPLITS[detail];
  const radial = RADIAL[detail];
  const segments: Segment[] = [];

  const stems = rng.int(spec.stems[0], spec.stems[1] + 1);
  const stemLean = rng.range(0, Math.PI * 2);

  for (let s = 0; s < stems; s++) {
    // Multi-stem species fan their trunks out from a shared root plate.
    const spreadAngle = stemLean + (s / stems) * Math.PI * 2;
    // In unit-height space, so this is multiplied by the tree's height at
    // instance time. Kept tight: a multi-stem shrub is a clump from one root
    // plate, and a wider fan puts stems outside the single cylinder collider
    // that is supposed to represent the whole plant.
    const spread = stems > 1 ? rng.range(0.06, 0.14) : 0;
    const stemHeight = height * (stems > 1 ? rng.range(0.75, 1.0) : 1);

    const boleTop = stemHeight * rng.range(spec.boleFraction[0], spec.boleFraction[1]);
    const baseR = stemHeight * rng.range(spec.baseRadius[0], spec.baseRadius[1]) / Math.sqrt(stems);
    const crotchR = baseR * rng.range(spec.boleTaper[0], spec.boleTaper[1]);

    // The bole leans, because a straight vertical cylinder is the single
    // clearest tell that a tree was generated. Elms on the Mall lean visibly.
    const lean = rng.range(0.03, 0.13);
    const leanAngle = rng.range(0, Math.PI * 2);
    const base = new Vector3(Math.cos(spreadAngle) * spread, 0, Math.sin(spreadAngle) * spread);
    const crotch = new Vector3(
      base.x + Math.cos(leanAngle) * lean * boleTop,
      boleTop,
      base.z + Math.sin(leanAngle) * lean * boleTop,
    );

    // Break the bole into three so the lean curves rather than kinks.
    let previous = base;
    let previousR = baseR;
    for (let i = 1; i <= 3; i++) {
      const t = i / 3;
      // Ease the lean in: the swell at the foot of a mature trunk is vertical.
      const bend = t * t;
      const point = new Vector3(
        base.x + (crotch.x - base.x) * bend,
        base.y + (crotch.y - base.y) * t,
        base.z + (crotch.z - base.z) * bend,
      );
      const radius = baseR + (crotchR - baseR) * Math.sqrt(t);
      segments.push({ from: previous, to: point, fromRadius: previousR, toRadius: radius, depth: t * 0.25 });
      previous = point;
      previousR = radius;
    }

    const limbCount = rng.int(spec.limbs[0], spec.limbs[1] + 1);
    const limbPhase = rng.range(0, Math.PI * 2);
    for (let l = 0; l < limbCount; l++) {
      const azimuth = limbPhase + (l / limbCount) * Math.PI * 2 + rng.spread(0.4);
      growLimb(
        segments,
        rng,
        spec,
        crotch,
        crotchR * rng.range(0.5, 0.72),
        azimuth,
        stemHeight * rng.range(spec.limbLength[0], spec.limbLength[1]) / (splits + 1),
        splits,
        0.3,
      );
    }
  }

  return tubesToGeometry(segments, radial);
}

/**
 * Grows one limb outward and upward from `origin`, then recurses.
 *
 * `rise` is metres of climb per metre of outward travel, and it is always
 * positive — that is the invariant the broken asset violated. A limb may bend,
 * fork and thin, but it never comes back down toward the ground.
 */
function growLimb(
  out: Segment[],
  rng: Rng,
  spec: SpeciesSpec,
  origin: Vector3,
  radius: number,
  azimuth: number,
  length: number,
  splits: number,
  depth: number,
): void {
  const rise = rng.range(spec.limbRise[0], spec.limbRise[1]);
  // Normalise so `length` is the distance travelled, not the outward component.
  const scale = 1 / Math.hypot(1, rise);
  const outward = length * scale;
  const climb = length * rise * scale;

  // Two segments per limb, with the second turned further upward. Elm limbs
  // straighten as they rise; oak limbs stay flat and kink instead.
  let point = origin;
  let r = radius;
  for (let i = 0; i < 2; i++) {
    const turn = i === 0 ? 0 : rng.spread(0.35);
    const a = azimuth + turn;
    const climbBias = i === 0 ? 1 : rng.range(1.15, 1.7);
    const next = new Vector3(
      point.x + Math.cos(a) * outward * 0.5,
      point.y + climb * 0.5 * climbBias,
      point.z + Math.sin(a) * outward * 0.5,
    );
    const nextR = r * rng.range(0.62, 0.78);
    out.push({ from: point, to: next, fromRadius: r, toRadius: nextR, depth });
    point = next;
    r = nextR;
    depth = Math.min(1, depth + 0.16);
  }

  if (splits <= 0) return;
  const forks = 2;
  for (let f = 0; f < forks; f++) {
    growLimb(
      out,
      rng,
      spec,
      point,
      r * rng.range(0.7, 0.9),
      azimuth + rng.spread(0.9),
      length * rng.range(0.45, 0.62),
      splits - 1,
      Math.min(1, depth + 0.2),
    );
  }
}

const AXIS_UP = new Vector3(0, 1, 0);
const AXIS_ALT = new Vector3(1, 0, 0);

/** Sweeps a ring of `radial` vertices along each segment and stitches them. */
function tubesToGeometry(segments: Segment[], radial: number): BufferGeometry {
  const vertexCount = segments.length * radial * 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(segments.length * radial * 6);

  const direction = new Vector3();
  const right = new Vector3();
  const forward = new Vector3();
  const ringDir = new Vector3();
  const tint = new Color();

  let v = 0;
  let t = 0;
  for (const segment of segments) {
    direction.subVectors(segment.to, segment.from).normalize();
    // Any perpendicular will do for the ring's reference frame; pick one that
    // is not parallel to the segment.
    right.crossVectors(direction, Math.abs(direction.y) > 0.95 ? AXIS_ALT : AXIS_UP).normalize();
    forward.crossVectors(right, direction).normalize();

    const ringStart = v;
    for (let end = 0; end < 2; end++) {
      const centre = end === 0 ? segment.from : segment.to;
      const radius = end === 0 ? segment.fromRadius : segment.toRadius;
      const depth = Math.min(1, segment.depth + end * 0.05);
      tint.copy(BARK_BASE).lerp(BARK_TIP, depth);

      for (let i = 0; i < radial; i++) {
        const angle = (i / radial) * Math.PI * 2;
        ringDir
          .copy(right)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(forward, Math.sin(angle));

        positions[v * 3] = centre.x + ringDir.x * radius;
        positions[v * 3 + 1] = centre.y + ringDir.y * radius;
        positions[v * 3 + 2] = centre.z + ringDir.z * radius;
        normals[v * 3] = ringDir.x;
        normals[v * 3 + 1] = ringDir.y;
        normals[v * 3 + 2] = ringDir.z;
        colors[v * 3] = tint.r;
        colors[v * 3 + 1] = tint.g;
        colors[v * 3 + 2] = tint.b;
        v++;
      }
    }

    for (let i = 0; i < radial; i++) {
      const a = ringStart + i;
      const b = ringStart + ((i + 1) % radial);
      const c = a + radial;
      const d = b + radial;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A set of trunk variants per species, generated once and instanced.
 *
 * Variants rather than one trunk per tree: a thousand unique trunk meshes would
 * be a thousand draw calls, and at the distances the forest is seen from,
 * six silhouettes per species is already more variety than anyone can pick out.
 */
export interface TrunkVariant {
  species: Species;
  geometry: BufferGeometry;
  /** Bole radius at the ground, as a fraction of tree height. */
  baseRadius: number;
}

export class TrunkLibrary {
  readonly variants: ReadonlyArray<TrunkVariant>;

  constructor(seed: number, readonly detail: Detail = 'near', perSpecies = 4) {
    const rng = new Rng(seed);
    const variants: TrunkVariant[] = [];

    for (const species of ['elm', 'oak', 'scrub'] as const) {
      for (let i = 0; i < perSpecies; i++) {
        // Nominal height 1: instances scale it. Building at unit height keeps
        // every variant usable at any size.
        const geometry = buildTrunkGeometry(species, rng, 1, detail);
        const spec = SPECIES[species];
        variants.push({
          species,
          geometry,
          baseRadius: (spec.baseRadius[0] + spec.baseRadius[1]) / 2,
        });
      }
    }

    this.variants = variants;
  }

  /** Indices of every variant of one species. */
  indicesOf(species: Species): number[] {
    const out: number[] = [];
    this.variants.forEach((variant, i) => {
      if (variant.species === species) out.push(i);
    });
    return out;
  }

  dispose(): void {
    for (const variant of this.variants) variant.geometry.dispose();
  }
}
