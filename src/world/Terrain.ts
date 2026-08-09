import type * as RapierNS from '@dimforge/rapier3d';
import { BufferAttribute, BufferGeometry, Mesh, type MeshToonMaterial } from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { createCelMaterial } from '../render/CelMaterial';
import { PARK_HALF, PLAY_HALF, groundColorAt, heightAt, slopeAt } from './ParkLayout';

/**
 * Grid resolution across the whole walkable map.
 *
 * 160 cells is not spread evenly — see `gridToWorld`. The play area gets 96 of
 * them across 184m (~1.9m spacing, fine enough for the lake shoreline and the
 * Ramble hills), and the woodland belt gets the remaining 32 per side across
 * 76m (~2.4m), which is as much as ground under a closed canopy can show.
 */
const CELLS = 160;
/** Fraction of the grid spent on the play area, per axis, per side. */
const CORE_FRACTION = 0.6;

/**
 * Maps a grid coordinate in [-1, 1] to a world coordinate.
 *
 * A uniform grid over the full 336m map would either cost four times the
 * triangles of the old 130m arena or halve the resolution everywhere. Grading
 * it spends the vertices where they are looked at: the play area keeps its
 * density, and the forest belt — which is seen through tree trunks, at a
 * distance, on hummocky ground where nobody can tell — gets the rest.
 *
 * The step at the seam is deliberately small — 1.9m inside to 2.4m outside, a
 * 25% change — because a sharper grading shows up as a ring of visibly
 * different triangle size right where the player crosses the treeline.
 */
function gridToWorld(t: number): number {
  const a = Math.abs(t);
  const sign = Math.sign(t);
  if (a <= CORE_FRACTION) return (sign * a / CORE_FRACTION) * PLAY_HALF;
  const outer = (a - CORE_FRACTION) / (1 - CORE_FRACTION);
  return sign * (PLAY_HALF + outer * (PARK_HALF - PLAY_HALF));
}

/**
 * The park ground: one heightfield mesh, vertex-coloured, with a matching
 * trimesh collider.
 *
 * Mesh and collider are generated from the same `heightAt` samples in one pass,
 * so there is no way for what you see to disagree with what you walk on.
 */
export class Terrain {
  readonly mesh: Mesh;
  readonly collider: RapierNS.Collider;
  readonly material: MeshToonMaterial;

  constructor(physics: PhysicsWorld) {
    const verts = CELLS + 1;
    const vertexCount = verts * verts;

    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(CELLS * CELLS * 6);

    // Axis coordinates are shared between rows and columns, so the grading is
    // computed once per line rather than once per vertex.
    const axis = new Float32Array(verts);
    for (let i = 0; i < verts; i++) axis[i] = gridToWorld((i / CELLS) * 2 - 1);

    for (let iz = 0; iz <= CELLS; iz++) {
      const z = axis[iz]!;
      for (let ix = 0; ix <= CELLS; ix++) {
        const i = iz * verts + ix;
        const x = axis[ix]!;
        const y = heightAt(x, z);

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        const color = groundColorAt(x, z, y, slopeAt(x, z));
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    }

    let t = 0;
    for (let iz = 0; iz < CELLS; iz++) {
      for (let ix = 0; ix < CELLS; ix++) {
        const a = iz * verts + ix;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        // Counter-clockwise when viewed from above, so normals point up.
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
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // No rim on the ground: a Fresnel term across a surface this large just
    // produces a bright horizon band.
    this.material = createCelMaterial({ color: 0xffffff, rimStrength: 0 });
    this.material.vertexColors = true;

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;

    this.collider = physics.createTrimesh(positions, indices);
  }

  /** Height of the ground at a world position — the same source the mesh used. */
  sample(x: number, z: number): number {
    return heightAt(x, z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
