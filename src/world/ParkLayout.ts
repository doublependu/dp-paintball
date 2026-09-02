import { Color } from 'three';
import { fbmSigned, fbm2D } from '../core/Noise';
import { clamp, lerp, smoothstep } from '../core/MathUtils';

/**
 * The park, laid out from the Bethesda Terrace / Lake / Bow Bridge / Ramble
 * stretch of Central Park.
 *
 * Origin is the Bethesda Fountain, -Z is north toward The Lake, +Z is south up
 * the Mall. Proportions follow the real park; geometry is hand-built.
 *
 * This module is the single source of truth for the ground surface — the mesh,
 * the collider and every prop placement all read `heightAt`, so nothing can
 * drift out of alignment with the terrain.
 *
 * ## Three rings
 *
 * The map is built as concentric rings rather than one uniform field, because
 * the three do different jobs and want different budgets:
 *
 * - **Play area**, out to `PLAY_HALF`. The landmarks, the lawns, the fight.
 *   Dense terrain sampling, hand-placed props, bot navigation.
 * - **Woodland belt**, `PLAY_HALF` to `PARK_HALF`. Procedurally scattered
 *   forest you can walk into and get lost in. Coarser ground, no navgrid, no
 *   authored props — its whole job is to make the park feel bigger than the
 *   arena and to hide the boundary.
 * - **City surround**, beyond `PARK_HALF`. Not walkable: the perimeter wall,
 *   then the ring street and the Manhattan building line. Pure backdrop, and
 *   the thing that says *which* park this is from anywhere inside it.
 */

/** Half-extent of the core play area — landmarks, lawns, bot navigation. */
export const PLAY_HALF = 92;
/** Half-extent of walkable ground: the park perimeter wall stands here. */
export const PARK_HALF = 168;
/** Kerb line of the ring street, just outside the park wall. */
export const CITY_NEAR = 184;
/** Deepest rank of buildings. Beyond this there is only sky. */
export const CITY_FAR = 440;

/** Height of the ground at the perimeter wall, above the street outside it. */
export const PERIMETER_Y = 1.7;

/** Water plane height. The lake bed is carved well below this. */
export const WATER_Y = -0.8;
const LAKE_BED = -3.4;

/** Lower plaza, around the fountain. Flat, paved in radial brick. */
export const PLAZA = { x: 0, z: 2, radius: 20 };

/** Upper terrace level — the top of the grand stairs. */
export const TERRACE_Y = 4.2;
/** The upper terrace slab: a walkable roof over the arcade undercroft. */
export const TERRACE = {
  y: TERRACE_Y,
  northZ: 16,
  southZ: 27,
  halfWidth: 30,
  slabThickness: 0.7,
};
/** North facade of the undercroft — the arcade colonnade. */
export const ARCADE = { z: 16, bays: 5, bayWidth: 4 };

/** Bow Bridge crosses the lake's narrow western arm, running along Z. */
export const BRIDGE = { x: -44, z: -30, length: 29.4 };
/** Ground height the bridge abutments land on at both ends. */
export const BRIDGE_APPROACH_Y = 0.5;

/** The Lake's wooded island, off the north shore. Reachable only by water. */
export const ISLAND = { x: 8, z: -50, radius: 9 };

/** Bounds the water plane has to cover — the lake and nothing else. */
export const LAKE_BOUNDS = { minX: -74, maxX: 70, minZ: -74, maxZ: -12 };

/**
 * Places a paint crate can hide, one picked per round.
 *
 * Hand-authored rather than drawn from `NavGrid.randomWalkablePoint()`, which
 * lands in the middle of Sheep Meadow about as often as anywhere and is neither
 * hidden nor interesting. Every entry is somewhere with a reason to be there —
 * a corner you have to go around, under something, behind something — and all
 * of them sit inside `PLAY_HALF`, because the navgrid stops there and a crate a
 * bot cannot path to would stall the "everyone is out of paint" rule.
 *
 * Each is still validated against the navgrid at spawn, so a spot that drifts
 * into the lake or inside a prop as the map changes is skipped rather than
 * quietly dropping the crate somewhere unreachable.
 */
export const LOOT_SPOTS: ReadonlyArray<{ x: number; z: number; where: string }> = [
  { x: -7, z: 21, where: 'the arcade undercroft, west bay' },
  { x: 8, z: 21, where: 'the arcade undercroft, east bay' },
  { x: 26, z: 33, where: 'behind the terrace, on the plateau' },
  { x: -6, z: -72, where: 'deep in the Ramble' },
  { x: 25, z: -70, where: 'the Ramble, east of the rock outcrop' },
  { x: -66, z: -8, where: 'the west bank above Bow Bridge' },
  { x: -26, z: 53, where: "the treeline on Sheep Meadow's east rim" },
  { x: -76, z: 72, where: 'the south-west woods' },
  { x: 11, z: 82, where: "the Mall's south end, off the allée" },
  { x: 58, z: 5, where: 'the wooded rise on the east flank' },
  // Added when the paint screen moved to the meadow's west rim: the board is a
  // place people go now, and a crate near it gives them a second reason to.
  { x: -58, z: 36, where: 'the meadow, beside the painting wall' },
  { x: 52, z: -69, where: 'the north-east shore, above the water' },
];

/** Elliptical distance: < 1 is inside the ellipse. */
function ellipse(x: number, z: number, cx: number, cz: number, rx: number, rz: number): number {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return Math.hypot(dx, dz);
}

/**
 * Lake coverage at a point, 0 (dry) to 1 (open water).
 *
 * Two overlapping ellipses — the main body and the narrow western arm Bow
 * Bridge crosses — with the shoreline pushed in and out by low-frequency
 * noise. The noise is the whole point: The Lake's outline is a Romantic
 * landscape gardener's squiggle, and a clean ellipse reads as a reservoir.
 */
export function lakeMask(x: number, z: number): number {
  const wobble = 1 + fbmSigned(x * 0.018, z * 0.018, 3, 12) * 0.13;
  const main = 1 - smoothstep(0.72, 1.03, ellipse(x, z, 14, -40, 48, 24) * wobble);
  const arm = 1 - smoothstep(0.72, 1.03, ellipse(x, z, -44, -30, 24, 10) * wobble);
  const water = Math.max(main, arm);

  // The island stands out of the water rather than being carved around, so its
  // shore lands wherever the lake mask already was.
  const island = 1 - smoothstep(0.55, 1.0, ellipse(x, z, ISLAND.x, ISLAND.z, ISLAND.radius, ISLAND.radius * 0.8) * wobble);
  return water * (1 - island);
}

/** Paved plaza coverage, 0 to 1. */
export function plazaMask(x: number, z: number): number {
  return 1 - smoothstep(PLAZA.radius * 0.72, PLAZA.radius, Math.hypot(x - PLAZA.x, z - PLAZA.z));
}

/** The Mall's central path — a straight allée running south. */
export function mallPathMask(x: number, z: number): number {
  const alongZ = smoothstep(20, 27, z) * (1 - smoothstep(84, 90, z));
  const acrossX = 1 - smoothstep(5.0, 7.5, Math.abs(x));
  return alongZ * acrossX;
}

/** Sheep Meadow — the great open lawn west of the Mall. Deliberately treeless. */
export function meadowMask(x: number, z: number): number {
  return 1 - smoothstep(0.78, 1.0, ellipse(x, z, -50, 42, 34, 26));
}

/** The Ramble — wooded rocky ground north of the Lake. */
export function rambleMask(x: number, z: number): number {
  const north = smoothstep(-56, -74, z);
  const west = smoothstep(-14, -30, x);
  // The Ramble proper is north of the water; the west bank above Bow Bridge is
  // the same character of ground and reads as one wood.
  return Math.max(north, west * smoothstep(-16, -34, z));
}

/**
 * How far into the woodland belt a point is, 0 (park lawn) to 1 (deep wood).
 *
 * Read by both the terrain — which roughens out here — and the forest
 * scatter, so the trees arrive exactly where the ground starts to feel wild.
 */
export function woodlandMask(x: number, z: number): number {
  const edge = Math.max(Math.abs(x), Math.abs(z));
  return smoothstep(PLAY_HALF - 26, PLAY_HALF + 22, edge);
}

/**
 * Probability that a woodland lattice cell holds a tree, 0 to 1.
 *
 * The belt thickens away from the park and is punched through with glades. The
 * glades matter more than the trees: forest at uniform density reads as an
 * orchard, you can see straight through it, and there is nothing to walk
 * *toward*. Two noise scales — broad clearings, finer thinning — plus a hard
 * exclusion along the walks, so the trails stay open enough to follow.
 */
export function woodlandDensity(x: number, z: number): number {
  const belt = woodlandMask(x, z);
  if (belt <= 0) return 0;
  const glades = fbm2D(x * 0.011, z * 0.011, 3, 617);
  const thinning = fbm2D(x * 0.045, z * 0.045, 2, 733);
  const open = smoothstep(0.38, 0.62, glades) * 0.75 + smoothstep(0.4, 0.7, thinning) * 0.25;
  const density = belt * (0.34 + 0.95 * (1 - open));
  return clamp(density * (1 - walkMask(x, z)), 0, 1);
}

// --- the walks --------------------------------------------------------------

/**
 * Central Park's paths are its signature: nothing in Olmsted's plan runs
 * straight except the Mall, and a lawn without them reads as a golf course.
 *
 * Stored as polylines and rasterised by distance rather than composed from
 * analytic masks, because a curve that doubles back — which is most of them —
 * has no closed form worth writing.
 */
interface Walk {
  points: Array<readonly [number, number]>;
  /** Half-width of the made surface, in metres. */
  half: number;
}

const WALKS: Walk[] = [
  // The lakeside walk along the south shore, plaza to the Bow Bridge approach.
  {
    half: 2.4,
    points: [
      [40, -6], [26, -12], [12, -15], [-2, -17], [-16, -16],
      [-27, -12], [-36, -16], [-42, -14],
    ],
  },
  // Bow Bridge approach, running north across the arm.
  { half: 2.2, points: [[-44, -14], [-44, -18], [-44, -42], [-45, -50], [-40, -58]] },
  // The Ramble's wandering trails, north of the water.
  {
    half: 1.6,
    points: [[-40, -58], [-30, -64], [-22, -72], [-8, -76], [4, -70], [16, -74], [28, -80]],
  },
  { half: 1.4, points: [[-8, -76], [-14, -84], [-6, -90]] },
  // West drive: plaza, past Cherry Hill, down the flank of Sheep Meadow.
  {
    half: 2.6,
    points: [
      [-14, 8], [-24, 12], [-30, 20], [-30, 32], [-26, 46],
      [-30, 60], [-38, 72], [-50, 82],
    ],
  },
  // Meadow's western walk, closing the loop back to the wood.
  { half: 2.0, points: [[-30, 20], [-46, 16], [-62, 24], [-72, 40], [-70, 60], [-58, 76]] },
  // East drive: plaza, past the terrace's east flank, south to the boundary.
  {
    half: 2.6,
    points: [[16, 10], [28, 14], [36, 26], [38, 42], [34, 58], [38, 74], [48, 86]],
  },
  // East lakeside, climbing the wooded rise.
  { half: 1.8, points: [[40, -6], [52, -14], [62, -26], [66, -44], [60, -62], [48, -74]] },
  // Trails leaking out of the park proper into the woodland belt. These are the
  // invitation: a walk that visibly continues past the treeline is what makes
  // the belt feel like somewhere to go rather than a wall of scenery.
  { half: 1.4, points: [[-50, 82], [-64, 96], [-72, 118], [-88, 138], [-96, 156]] },
  { half: 1.4, points: [[48, 86], [66, 98], [78, 120], [92, 140], [104, 158]] },
  { half: 1.4, points: [[-72, 40], [-96, 46], [-118, 38], [-140, 48], [-158, 40]] },
  { half: 1.4, points: [[66, -44], [92, -50], [116, -42], [138, -52], [158, -44]] },
  { half: 1.3, points: [[28, -80], [40, -98], [36, -120], [48, -142], [42, -160]] },
  { half: 1.3, points: [[-22, -72], [-40, -92], [-38, -116], [-52, -138], [-48, -160]] },
];

/** Squared distance from a point to a segment. */
function segmentDistanceSq(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  const t = lenSq > 0 ? clamp(((px - ax) * vx + (pz - az) * vz) / lenSq, 0, 1) : 0;
  const dx = px - (ax + vx * t);
  const dz = pz - (az + vz * t);
  return dx * dx + dz * dz;
}

/**
 * Made-path coverage at a point, 0 to 1.
 *
 * The edge is broken up by noise so the gravel doesn't meet the grass along a
 * mathematically perfect offset curve — the single fastest way to make a
 * hand-drawn park look CAD-drawn.
 */
export function walkMask(x: number, z: number): number {
  let best = 0;
  const fray = fbmSigned(x * 0.28, z * 0.28, 2, 71) * 0.5;
  for (const walk of WALKS) {
    const { points, half } = walk;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const d = Math.sqrt(segmentDistanceSq(x, z, a[0], a[1], b[0], b[1])) + fray;
      const coverage = 1 - smoothstep(half * 0.7, half, d);
      if (coverage > best) best = coverage;
      if (best >= 1) return 1;
    }
  }
  return best;
}

/**
 * Ground height at a world position.
 *
 * Composed as a base landform, then the lake carved into it, then the plaza
 * flattened on top — order matters, because the plaza must win over the
 * undulation and the lake must win over the southern plateau.
 */
export function heightAt(x: number, z: number): number {
  // Southern plateau. The rise starts at z=24, south of the arcade, so the
  // undercroft beneath the upper terrace keeps full standing height instead of
  // pinching shut against a rising floor.
  let h = smoothstep(24, 32, z) * TERRACE_Y;
  h += smoothstep(38, 70, z) * 1.4;

  // Ramble hills — the park's roughest ground, and its best cover.
  const ramble = rambleMask(x, z);
  h += ramble * (4.6 + fbmSigned(x * 0.035, z * 0.035, 3, 101) * 2.8);

  // Wooded rise along the east edge.
  h += smoothstep(34, 70, x) * 4.2;

  // West bank, above the bridge arm.
  h += smoothstep(-52, -78, x) * smoothstep(-6, -26, z) * 2.6;

  // Gentle undulation everywhere the ground is natural.
  const plaza = plazaMask(x, z);
  const lake = lakeMask(x, z);
  const meadow = meadowMask(x, z);
  h += fbmSigned(x * 0.021, z * 0.021, 3, 55) * 0.95 * (1 - lake) * (1 - plaza);

  // Sheep Meadow is a bowl: mown flat in the middle, rising at its rim. Its
  // job is a long clean sightline, which any undulation would break.
  h = lerp(h, lerp(h, 2.4, 0.35), meadow);

  // The woodland belt: rougher, hummocky ground, on a slow rise away from the
  // park's centre so the treeline stands above the lawns rather than behind
  // them.
  const wood = woodlandMask(x, z);
  h += wood * (fbmSigned(x * 0.042, z * 0.042, 4, 311) * 3.4 + 2.2);
  h += wood * wood * fbmSigned(x * 0.012, z * 0.012, 2, 907) * 4.0;

  // Carve the lake bed. This overrides whatever the landform said.
  h = lerp(h, LAKE_BED, lake);

  // Flatten the plaza last so paving is dead level.
  h = lerp(h, 0, plaza);

  // Level the bridge approaches. Bow Bridge is rigid geometry spanning 29m, and
  // the Ramble hills would otherwise leave one abutment buried and the other in
  // mid-air. Applied after the lake carve and masked by it, so the water under
  // the bridge is untouched.
  const corridor =
    (1 - smoothstep(6, 13, Math.abs(x - BRIDGE.x))) *
    (1 - smoothstep(14, 21, Math.abs(z - BRIDGE.z)));
  h = lerp(h, BRIDGE_APPROACH_Y, corridor * (1 - lake) * 0.92);

  // Perimeter shelf. The real park sits above its streets behind a low
  // retaining wall, and reproducing that is what stops the boundary reading as
  // an arena edge: you look *down* over the wall at the traffic.
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h = lerp(h, PERIMETER_Y, smoothstep(PARK_HALF - 16, PARK_HALF - 3, edge));

  return h;
}

/** Central-difference surface normal steepness, 0 (flat) to 1 (vertical). */
export function slopeAt(x: number, z: number, eps = 1.0): number {
  const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
  const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
  const gradient = Math.hypot(hx, hz) / (2 * eps);
  return clamp(gradient / (gradient + 1), 0, 1);
}

const SCRATCH = new Color();
// Widened deliberately. The previous three greens sat within a few percent of
// each other, so the two-scale noise had nothing to interpolate between and the
// lawns rendered as a single flat fill at any distance.
const GRASS_LIT = new Color(0x9ed05c);
const GRASS_DEEP = new Color(0x3a6d3a);
const GRASS_DRY = new Color(0xc6c76a);
const ROCK = new Color(0x9a927f);
const SAND = new Color(0xcbbd93);
const LAKEBED = new Color(0x6b7a63);
// Bethesda's plaza is laid in red Roman brick, not the pale stone the rest of
// the terrace is built from. Photographs of the fountain are dominated by that
// terracotta ring, and rendering it as cream flagstone lost the single most
// recognisable colour on the map.
const BRICK_LIT = new Color(0xc48b6c);
const BRICK_DARK = new Color(0x9a6247);
const STONE_TRIM = new Color(0xcabfa6);
// Park walks are buff hexagonal asphalt or gravel — warmer and lighter than
// the roadway, which is the ordinary grey of a New York street.
const GRAVEL = new Color(0xc3ab80);
const LEAF_LITTER = new Color(0x6d5a3c);
/** Scratch for the brick mix, so paving costs no allocation per vertex. */
const BRICK_SCRATCH = new Color();

/**
 * Ground colour at a point.
 *
 * Vertex colours rather than textures: the palette varies over tens of metres,
 * which is exactly the scale vertex interpolation handles well, and it costs no
 * download and no UV unwrap.
 */
export function groundColorAt(x: number, z: number, height: number, slope: number): Color {
  const plaza = plazaMask(x, z);
  const path = Math.max(mallPathMask(x, z), walkMask(x, z));

  // Two-scale variation so the grass never reads as one flat fill — the thing
  // that made the phase 3 test course look like a tech demo.
  // Three scales, not two: broad drifts of tone, mid-scale patchiness, and a
  // fine break-up that keeps close ground from looking laminated.
  const broad = fbm2D(x * 0.014, z * 0.014, 3, 7);
  const mid = fbm2D(x * 0.055, z * 0.055, 3, 41);
  const fine = fbm2D(x * 0.15, z * 0.15, 2, 23);

  SCRATCH.copy(GRASS_DEEP).lerp(GRASS_LIT, clamp((broad - 0.28) * 1.9, 0, 1));
  SCRATCH.lerp(GRASS_DEEP, clamp((0.46 - mid) * 1.5, 0, 1) * 0.55);
  SCRATCH.lerp(GRASS_DRY, clamp((fine - 0.58) * 1.7, 0, 1) * 0.42);

  // Mown lawns read markedly lighter and more uniform than rough ground; the
  // meadow is the one place in the park that genuinely is a flat green field.
  SCRATCH.lerp(GRASS_LIT, meadowMask(x, z) * 0.45);

  // Woodland floor: leaf litter and shade, not lawn.
  const wood = woodlandMask(x, z);
  SCRATCH.lerp(GRASS_DEEP, wood * 0.5);
  SCRATCH.lerp(LEAF_LITTER, wood * clamp((fine - 0.42) * 1.6, 0, 1) * 0.5);

  // Exposed rock on anything steep — schist breaking through, as in the Ramble.
  SCRATCH.lerp(ROCK, smoothstep(0.22, 0.55, slope));

  // Shoreline sand, gated on *proximity to the lake* rather than on height
  // difference from the waterline. Height alone is the wrong measure: on gently
  // shelving ground a one-metre band covers the whole near-shore lawn, which
  // turned every field beside the water to khaki.
  const lake = lakeMask(x, z);
  // Tight. The band widened with the lake — a mask gradient measured in mask
  // units covers more ground the larger and gentler the shoreline gets — and a
  // 0.03-to-0.3 window put khaki across the whole near-shore lawn again.
  const shoreBand = smoothstep(0.02, 0.13, lake) * (1 - smoothstep(0.26, 0.55, lake));
  const shoreNoise = fbm2D(x * 0.09, z * 0.09, 2, 88);
  SCRATCH.lerp(SAND, shoreBand * (0.65 + shoreNoise * 0.35));
  SCRATCH.lerp(LAKEBED, smoothstep(WATER_Y - 0.35, WATER_Y - 2.0, height) * 0.8);

  // Built surfaces last: they are not weathered by any of the above.
  SCRATCH.lerp(GRAVEL, path * 0.9);

  if (plaza > 0.01) {
    // Radial brick courses, banded rather than smooth, so the paving reads as
    // laid rather than poured.
    // Broad concentric courses only. Vertex colours are sampled on a ~1.9m
    // grid, so anything with a period under about 4m aliases into noise —
    // individual bricks and radial spokes are simply not representable here,
    // and trying cost a plaza that shimmered.
    const radius = Math.hypot(x - PLAZA.x, z - PLAZA.z);
    const course = Math.sin(radius * 0.52) * 0.5 + 0.5;
    BRICK_SCRATCH.copy(BRICK_DARK).lerp(BRICK_LIT, clamp(course, 0, 1));
    // A pale stone kerb ring where the paving meets the grass.
    BRICK_SCRATCH.lerp(STONE_TRIM, smoothstep(PLAZA.radius * 0.9, PLAZA.radius, radius) * 0.8);
    SCRATCH.lerp(BRICK_SCRATCH, plaza * 0.95);
  }

  return SCRATCH;
}
