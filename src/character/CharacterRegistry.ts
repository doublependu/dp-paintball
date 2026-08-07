/**
 * Maps Rapier collider handles to character ids.
 *
 * Ballistics needs to know, at impact, whether it hit a person or the park —
 * the two produce different events, different paint systems and different
 * scoring. Colliders are the only thing physics hands back, so this is the
 * bridge.
 */
export class CharacterRegistry {
  private byHandle = new Map<number, string>();

  register(colliderHandle: number, characterId: string): void {
    this.byHandle.set(colliderHandle, characterId);
  }

  unregister(colliderHandle: number): void {
    this.byHandle.delete(colliderHandle);
  }

  /** Character id for a collider, or undefined if it isn't a character. */
  getId(colliderHandle: number): string | undefined {
    return this.byHandle.get(colliderHandle);
  }

  get size(): number {
    return this.byHandle.size;
  }

  clear(): void {
    this.byHandle.clear();
  }
}
