import { Vector3, type PerspectiveCamera } from 'three';

/** Over the head, clear of the cap. */
const ABOVE = 2.15;
/** Past this a name is more clutter than help. */
const FAR = 70;

const SCRATCH = new Vector3();

/**
 * Friends' names over their heads, in a room. A bot has none: the name is how a friend
 * is told from a bot at a glance, in a park where both wear the same shirts.
 */
export class NameTags {
  private readonly layer: HTMLDivElement;
  private readonly tags = new Map<number, HTMLDivElement>();

  constructor(container: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'net-tags';
    container.append(this.layer);
  }

  /** Puts a name over place `key` this frame, or takes it away with `name` null. */
  show(key: number, name: string | null, color: number, at: Vector3 | null, camera: PerspectiveCamera): void {
    let tag = this.tags.get(key);
    if (name === null || at === null) {
      if (tag) tag.style.display = 'none';
      return;
    }
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'net-tag';
      this.layer.append(tag);
      this.tags.set(key, tag);
    }
    if (tag.textContent !== name) tag.textContent = name;
    tag.style.borderColor = `#${color.toString(16).padStart(6, '0')}`;

    SCRATCH.set(at.x, at.y + ABOVE, at.z);
    const distance = SCRATCH.distanceTo(camera.position);
    SCRATCH.project(camera);
    if (distance > FAR || SCRATCH.z > 1 || Math.abs(SCRATCH.x) > 1.1 || Math.abs(SCRATCH.y) > 1.1) {
      tag.style.display = 'none';
      return;
    }
    const width = this.layer.clientWidth || window.innerWidth;
    const height = this.layer.clientHeight || window.innerHeight;
    tag.style.display = '';
    tag.style.transform = `translate(${((SCRATCH.x + 1) / 2) * width}px, ${((1 - SCRATCH.y) / 2) * height}px) translate(-50%, -100%)`;
    tag.style.opacity = String(distance < FAR * 0.6 ? 1 : 1 - (distance - FAR * 0.6) / (FAR * 0.4));
  }

  clear(): void {
    for (const tag of this.tags.values()) tag.remove();
    this.tags.clear();
  }

  set visible(on: boolean) {
    this.layer.style.display = on ? '' : 'none';
  }
}
