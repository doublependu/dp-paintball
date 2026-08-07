import { Color } from 'three';
import { fbmSigned, fbm2D } from '../core/Noise';
import { clamp, lerp, smoothstep } from '../core/MathUtils';

/**
 * The arena, laid out from the Bethesda Terrace / Bow Bridge / Ramble stretch
 * of Central Park.
 *
 * Origin is the Bethesda Fountain, -Z is north toward The Lake, +Z is south up
 * the Mall. Proportions follow the real park; geometry is hand-built.
 *
 * This module is the single source of truth for the ground surface — the mesh,
 * the collider and every prop placement all read `heightAt`, so nothing can
 * drift out of alignment with the terrain.
 */

export const ARENA_HALF = 65;
export const ARENA_SIZE = ARENA_HALF * 2;

/** Water plane height. The lake bed is carved well below this. */
export const WATER_Y = -0.8;
const LAKE_BED = -2.9;

/** Lower plaza, around the fountain. Flat, paved. */
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
export const BRIDGE = { x: -34, z: -26, length: 29.4 };
/** Ground height the bridge abutments land on at both ends. */
export const BRIDGE_APPROACH_Y = 0.5;

/** Elliptical distance: < 1 is inside the ellipse. */
function ellipse(x: number, z: number, cx: number, cz: number, rx: number, rz: number): number {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return Math.hypot(dx, dz);
}

/** Lake coverage at a point, 0 (dry) to 1 (open water). */
export function lakeMask(x: number, z: number): number {
  const main = 1 - smoothstep(0.72, 1.03, ellipse(x, z, 10, -32, 30, 16));
  const arm = 1 - smoothstep(0.72, 1.03, ellipse(x, z, -34, -26, 18, 8));
  return Math.max(main, arm);
}

/** Paved plaza coverage, 0 to 1. */
export function plazaMask(x: number, z: number): number {
  return 1 - smoothstep(PLAZA.radius * 0.72, PLAZA.radius, Math.hypot(x - PLAZA.x, z - PLAZA.z));
}

/** The Mall's central path — a straight allée running south. */
export function mallPathMask(x: number, z: number): number {
  const alongZ = smoothstep(20, 27, z) * (1 - smoothstep(58, 64, z));
  const acrossX = 1 - smoothstep(5.0, 7.5, Math.abs(x));
  return alongZ * acrossX;
}

/** The Ramble — wooded rocky ground in the northwest. */
export function rambleMask(x: number, z: number): number {
  return smoothstep(-16, -34, x) * smoothstep(-34, -48, z);
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
  h += smoothstep(38, 60, z) * 0.9;

  // Ramble hills.
  const ramble = rambleMask(x, z);
  h += ramble * (4.2 + fbmSigned(x * 0.035, z * 0.035, 3, 101) * 2.4);

  // Wooded rise along the east edge.
  h += smoothstep(28, 52, x) * 3.4;

  // West bank, north of the bridge arm.
  h += smoothstep(-42, -60, x) * smoothstep(-6, -22, z) * 2.2;

  // Gentle undulation everywhere the ground is natural.
  const plaza = plazaMask(x, z);
  const lake = lakeMask(x, z);
  h += fbmSigned(x * 0.021, z * 0.021, 3, 55) * 0.85 * (1 - lake) * (1 - plaza);

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

  // Perimeter berm, purely visual — containment is a vertical wall, because
  // steep terrain is not reliably un-climbable (see the phase 1 capsule note).
  const edge = Math.max(Math.abs(x), Math.abs(z));
  h += smoothstep(ARENA_HALF - 12, ARENA_HALF, edge) * 3.0;

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
const GRASS_LIT = new Color(0x93c357);
const GRASS_DEEP = new Color(0x3b6838);
const GRASS_DRY = new Color(0xc0c268);
const ROCK = new Color(0x9a927f);
const SAND = new Color(0xcbbd93);
const LAKEBED = new Color(0x6b7a63);
const PAVING = new Color(0xcfc4ad);
const GRAVEL = new Color(0xc0ac86);

/**
 * Ground colour at a point.
 *
 * Vertex colours rather than textures: the palette varies over tens of metres,
 * which is exactly the scale vertex interpolation handles well, and it costs no
 * download and no UV unwrap.
 */
export function groundColorAt(x: number, z: number, height: number, slope: number): Color {
  const plaza = plazaMask(x, z);
  const path = mallPathMask(x, z);

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

  // Exposed rock on anything steep — schist breaking through, as in the Ramble.
  SCRATCH.lerp(ROCK, smoothstep(0.22, 0.55, slope));

  // Shoreline sand, gated on *proximity to the lake* rather than on height
  // difference from the waterline. Height alone is the wrong measure: on gently
  // shelving ground a one-metre band covers the whole near-shore lawn, which
  // turned every field beside the water to khaki.
  const lake = lakeMask(x, z);
  const shoreBand = smoothstep(0.03, 0.3, lake) * (1 - smoothstep(0.5, 0.85, lake));
  const shoreNoise = fbm2D(x * 0.09, z * 0.09, 2, 88);
  SCRATCH.lerp(SAND, shoreBand * (0.65 + shoreNoise * 0.35));
  SCRATCH.lerp(LAKEBED, smoothstep(WATER_Y - 0.35, WATER_Y - 2.0, height) * 0.8);

  // Built surfaces last: they are not weathered by any of the above.
  SCRATCH.lerp(GRAVEL, path * 0.9);
  SCRATCH.lerp(PAVING, plaza * 0.92);

  return SCRATCH;
}
