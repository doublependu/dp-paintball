import { Matrix4, type BufferGeometry, type Mesh } from 'three';

/**
 * Everything the paint system needs to project a decal onto a surface.
 *
 * Geometry plus a world transform rather than a Mesh, because a large share of
 * the park's props are instanced. An InstancedMesh has one matrixWorld for the
 * whole batch, so a decal projected against it would land on whichever instance
 * happened to be at the origin. Storing the per-instance matrix here lets paint
 * work on instanced props exactly as it does on individual ones.
 */
export interface PaintReceiver {
  geometry: BufferGeometry;
  matrixWorld: Matrix4;
}

/**
 * Maps Rapier collider handles back to the surfaces that own them.
 *
 * Physics knows what a paintball hit; rendering needs to know what to paint.
 * Nothing else bridges the two, so world geometry registers here at build time
 * and the paint system looks up receivers on impact.
 */
export class SurfaceRegistry {
  private byHandle = new Map<number, PaintReceiver>();

  register(colliderHandle: number, receiver: PaintReceiver): void {
    this.byHandle.set(colliderHandle, receiver);
  }

  /** Convenience for an ordinary mesh. Its world matrix is resolved now. */
  registerMesh(colliderHandle: number, mesh: Mesh): void {
    mesh.updateMatrixWorld(true);
    this.byHandle.set(colliderHandle, {
      geometry: mesh.geometry,
      matrixWorld: mesh.matrixWorld.clone(),
    });
  }

  /** Registers one instance of an instanced prop. */
  registerInstance(
    colliderHandle: number,
    geometry: BufferGeometry,
    instanceMatrix: Matrix4,
  ): void {
    this.byHandle.set(colliderHandle, {
      geometry,
      matrixWorld: instanceMatrix.clone(),
    });
  }

  get(colliderHandle: number): PaintReceiver | undefined {
    return this.byHandle.get(colliderHandle);
  }

  get size(): number {
    return this.byHandle.size;
  }

  clear(): void {
    this.byHandle.clear();
  }
}
