import {
  BoxGeometry,
  type CanvasTexture,
  type Material,
  Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { GameContext } from '../core/System';
import type { SurfaceRegistry } from '../paint/SurfaceRegistry';
import { createCelMaterial } from '../render/CelMaterial';
import { PLAQUE_ASPECT, createPlaceSignTexture, createSignPlaqueTexture } from '../render/SignPlaque';
import { heightAt } from './ParkLayout';

/**
 * The park's signs: the dedication plaque, and a marker naming each place.
 *
 * The map has been laid out from real ground since iteration 3 — Bethesda
 * Terrace, the Mall, Sheep Meadow, the Lake, Bow Bridge, the Ramble, Cherry
 * Hill — and `LOOT_SPOTS` already speaks that vocabulary at the player ("deep
 * in the Ramble", "the west bank above Bow Bridge"). Nothing in the world said
 * any of it. These are what say it.
 *
 * Boxes rather than a modelled prop, because the only thing that makes a sign a
 * sign is the lettering, and that is generated (`SignPlaque`). Both posts and
 * board are ordinary colliders registered for paint, so a sign stops a
 * paintball, blocks a bot, and takes a splat like anything else in the park.
 *
 * A table plus a builder, in its own file rather than in `ParkArena`, which is
 * twelve hundred lines of exactly this and does not need eleven more sites.
 */

/** A sign's site, and what its face is turned toward. */
export interface SignSpec {
  /** The copy. Also the seed for the board's hand-lettering — see `hashSeed`. */
  name: string;
  x: number;
  z: number;
  /**
   * A point in the park the board looks at, rather than an angle.
   *
   * The dedication sign already derived its rotation from `PLAZA` this way, and
   * the reason generalises: a sign aimed at its subject stays aimed at it when
   * the subject moves, and "faces the fountain" is checkable in a way that
   * "yaw 2.159" is not.
   */
  faceX: number;
  faceZ: number;
}

/**
 * The dedication sign, on the plaza paving at its south-east rim.
 *
 * The plaza is where the round starts and where the sightlines cross, so a sign
 * here is one anyone will walk past, and standing off the axis between the
 * spawn and the fountain keeps it out of the opening shot of the map. Kept a
 * few metres clear of the undercroft wall besides: the terrace throws a shadow
 * three metres out onto the paving all afternoon, and a lettered board read in
 * that band is a dark green rectangle.
 */
export const DEDICATION_SIGN: SignSpec = {
  name: 'Made by Man and Bot',
  x: 10.5,
  z: 9,
  faceX: 0,
  faceZ: 2,
};

/** Board width in metres. The dedication's plaque carries two lines and more of them. */
const DEDICATION_WIDTH = 2.4;
const PLACE_WIDTH = 1.9;

/** Top of the board above the ground, in metres. */
const DEDICATION_TOP = 2.22;
const PLACE_TOP = 2.05;

const POST_COLOR = 0x6d5a41;
/** Matches the plaque's painted ground, so the lit board reads as one thing. */
const BOARD_COLOR = 0x2c4636;

/**
 * Where the markers stand.
 *
 * Every site was settled by sweeping the layout masks rather than picked by
 * eye, the way the paint screen's was: `walkMask` under the whole footprint
 * below 0.05, no water, off the terrace and the stairs, out of the fountain
 * basin, clear of the paint screen and of the ground its painters walk in
 * across, at least 2.5m from every other sign, and under 25cm of fall across
 * the board's own width so neither post floats. Nine of the ten sit where they
 * were first proposed; the tests in `tools/arena-test.mjs` re-check all of it
 * against the live park, which is the only place the props and colliders exist.
 *
 * The `walkMask` bar is 0.05 rather than the 0.15 `canPlant` allows a tree,
 * and the difference matters: a sign is a collider and the navgrid is built by
 * querying physics, so a sign overhanging a walk pinches the one path every
 * bot on that side of the park uses.
 */
export const PLACE_SIGNS: readonly SignSpec[] = [
  // The mirror of the dedication sign across the plaza's axis.
  { name: 'Bethesda Fountain', x: -10.5, z: 9, faceX: 0, faceZ: 2 },
  // At the foot of the west grand stairs, looking up the flight it names.
  { name: 'Bethesda Terrace', x: -16.5, z: 5, faceX: -19, faceZ: 16 },
  // Beside the allée, clear of `mallPathMask`'s 7.5m half-width and inside the
  // elm rows at 12.5m, looking south down the walk.
  { name: 'The Mall', x: -9, z: 34, faceX: 0, faceZ: 60 },
  // The meadow's east rim, off the west drive, facing west across the lawn.
  { name: 'Sheep Meadow', x: -23, z: 40, faceX: -50, faceZ: 42 },
  // Off the board's south end rather than in front of it: a sign on the axis
  // would stand in the line between a painter's stance and its own canvas.
  { name: 'The Painting Wall', x: -62.5, z: 32, faceX: -64, faceZ: 42 },
  // The west drive where it turns north along the meadow's flank.
  { name: 'Cherry Hill', x: -34.5, z: 24, faceX: -30, faceZ: 34 },
  // South of the lakeside walk, facing north over the water.
  { name: 'The Lake', x: -2, z: -13, faceX: 0, faceZ: -40 },
  // The bridge's southern approach, facing north along the deck.
  { name: 'Bow Bridge', x: -47, z: -15, faceX: -44, faceZ: -30 },
  // Where the bridge approach meets the Ramble's trails.
  { name: 'The Ramble', x: -37, z: -63.5, faceX: -22, faceZ: -72 },
  // The one place the player cannot walk to, so its sign stands on the north
  // shore and points across the water at it.
  { name: 'The Island', x: 3.5, z: -73.5, faceX: 8, faceZ: -50 },
];

/**
 * Whether (x, z) lands on a sign, plus `margin` metres of clearance.
 *
 * Shaped like `PaintScreen.screenBlocks` and read for the same reason: two
 * predicates that lay things out — `ParkArena.canPlant` for trees and
 * `isClearForFurniture` for benches and lamp posts — have to know what is
 * already standing there. This replaced a hardcoded radius around the
 * dedication sign that knew about exactly one of the eleven.
 *
 * A radius rather than a rotated rectangle: a sign is under two and a half
 * metres wide and a third of a metre deep, so the circle its board sweeps is
 * within a hand's width of its real footprint whichever way it is turned.
 */
export function signBlocks(x: number, z: number, margin = 0): boolean {
  if (blocksOne(DEDICATION_SIGN, DEDICATION_WIDTH, x, z, margin)) return true;
  for (const sign of PLACE_SIGNS) {
    if (blocksOne(sign, PLACE_WIDTH, x, z, margin)) return true;
  }
  return false;
}

function blocksOne(
  sign: SignSpec,
  boardWidth: number,
  x: number,
  z: number,
  margin: number,
): boolean {
  // The posts stand a little behind the board, so the swept circle is a shade
  // wider than the board itself.
  const radius = boardWidth / 2 + 0.35 + margin;
  return Math.hypot(x - sign.x, z - sign.z) < radius;
}

/** What `buildSign` needs that is not in the table. */
interface Board {
  /** Board width in metres. Its height follows from the plaque's proportions. */
  width: number;
  /** Height of the top of the board above the ground, in metres. */
  top: number;
  aspect: number;
  plaque: Material;
}

/**
 * Puts one sign in the park: two posts and a lettered board.
 *
 * Shared by the dedication plaque and the ten place markers, which differ only
 * in their copy and in how wide the board is.
 */
export function buildSign(
  ctx: GameContext,
  surfaces: SurfaceRegistry,
  group: Object3D,
  disposables: Array<{ dispose(): void }>,
  spec: SignSpec,
  board: Board,
  boardMaterial: Material,
  postMaterial: Material,
): void {
  const base = new Vector3(spec.x, heightAt(spec.x, spec.z), spec.z);
  const rotationY = Math.atan2(spec.faceX - spec.x, spec.faceZ - spec.z);
  const quaternion = new Quaternion().setFromAxisAngle(UP, rotationY);

  const place = (size: Vector3, local: Vector3, material: Material | Material[]): void => {
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(local).applyAxisAngle(UP, rotationY).add(base);
    mesh.rotation.y = rotationY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geometry);

    const collider = ctx.physics.createStaticBox(
      mesh.position,
      { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
      quaternion,
    );
    surfaces.registerMesh(collider.handle, mesh);
  };

  const boardHeight = board.width / board.aspect;

  // Posts run past the board top and 0.2m into the ground, so neither end
  // floats when the ground isn't perfectly level.
  const postHeight = board.top + 0.28;
  for (const side of [-1, 1]) {
    place(
      new Vector3(0.14, postHeight, 0.14),
      new Vector3(side * (board.width / 2 - 0.3), board.top / 2 - 0.06, -0.09),
      postMaterial,
    );
  }

  // BoxGeometry groups run +X, -X, +Y, -Y, +Z, -Z. Only the +Z face is
  // lettered; the rest is painted board.
  place(
    new Vector3(board.width, boardHeight, 0.12),
    new Vector3(0, board.top - boardHeight / 2, 0),
    [boardMaterial, boardMaterial, boardMaterial, boardMaterial, board.plaque, boardMaterial],
  );
}

/**
 * Builds the dedication sign and every place marker.
 *
 * Board and post materials are shared across all eleven — the plaques are not,
 * because each one carries different words. Ten 512x176 RGBA textures is 3.6MB,
 * which is the simple option and an affordable one; if it ever isn't, the
 * fallback is one atlas with a row per name and `map.offset`/`map.repeat` per
 * material, which is what `CanopyAtlas` and `SplatAtlas` already do.
 */
export function buildSigns(
  ctx: GameContext,
  surfaces: SurfaceRegistry,
  group: Object3D,
  disposables: Array<{ dispose(): void }>,
): void {
  const boardMaterial = createCelMaterial({ color: BOARD_COLOR });
  const postMaterial = createCelMaterial({ color: POST_COLOR });
  disposables.push(boardMaterial, postMaterial);

  /** White base colour: the plaque carries every colour, and toon shading multiplies. */
  const faceMaterial = (map: CanvasTexture): Material => {
    const material = createCelMaterial({ color: 0xffffff, map });
    disposables.push(material);
    return material;
  };

  const dedication = createSignPlaqueTexture();
  disposables.push(dedication);
  buildSign(
    ctx, surfaces, group, disposables, DEDICATION_SIGN,
    {
      width: DEDICATION_WIDTH,
      top: DEDICATION_TOP,
      aspect: PLAQUE_ASPECT,
      plaque: faceMaterial(dedication),
    },
    boardMaterial, postMaterial,
  );

  for (const sign of PLACE_SIGNS) {
    const { texture, aspect } = createPlaceSignTexture(sign.name);
    disposables.push(texture);
    buildSign(
      ctx, surfaces, group, disposables, sign,
      { width: PLACE_WIDTH, top: PLACE_TOP, aspect, plaque: faceMaterial(texture) },
      boardMaterial, postMaterial,
    );
  }
}

const UP = new Vector3(0, 1, 0);
