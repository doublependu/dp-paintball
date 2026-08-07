import type * as RapierNS from '@dimforge/rapier3d';
import { BufferAttribute, BufferGeometry, Mesh, type MeshToonMaterial } from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { createCelMaterial } from '../render/CelMaterial';
import { ARENA_HALF, ARENA_SIZE, groundColorAt, heightAt, slopeAt } from './ParkLayout';

/**
 * Grid resolution. 96 cells over 130m gives ~1.35m spacing — fine enough that
 * the lake shoreline and the Ramble hills read cleanly, coarse enough that the
 * collider trimesh stays reasonable.
 */
const CELLS = 96;

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

    for (let iz = 0; iz <= CELLS; iz++) {
      for (let ix = 0; ix <= CELLS; ix++) {
        const i = iz * verts + ix;
        const x = -ARENA_HALF + (ix / CELLS) * ARENA_SIZE;
        const z = -ARENA_HALF + (iz / CELLS) * ARENA_SIZE;
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
