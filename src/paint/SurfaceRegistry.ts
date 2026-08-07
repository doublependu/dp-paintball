import type { Mesh } from 'three';

/**
 * Maps Rapier collider handles back to the meshes that own them.
 *
 * Physics knows what a paintball hit; rendering needs to know what to paint.
 * Nothing else bridges the two, so world geometry registers here at build time
 * and the paint system looks up receivers on impact.
 */
export class SurfaceRegistry {
  private byHandle = new Map<number, Mesh>();

  register(colliderHandle: number, mesh: Mesh): void {
    this.byHandle.set(colliderHandle, mesh);
  }

  get(colliderHandle: number): Mesh | undefined {
    return this.byHandle.get(colliderHandle);
  }

  get size(): number {
    return this.byHandle.size;
  }

  clear(): void {
    this.byHandle.clear();
  }
}
