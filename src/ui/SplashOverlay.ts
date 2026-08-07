import type { SplatAtlas } from '../paint/SplatAtlas';

interface Blob {
  /** Screen position, in fractions of the viewport. */
  x: number;
  y: number;
  size: number;
  rotation: number;
  variant: number;
  color: string;
  age: number;
  lifetime: number;
  /** How far this blob slides down the screen over its life, in viewport fractions. */
  drip: number;
}

/** Blobs live this long by default, in seconds. */
const LIFETIME = 2.8;

/**
 * Paint on the camera lens.
 *
 * Drawn on a 2D canvas over the game rather than as a post-process pass:
 * splashes need to sit above everything including the HUD, they animate on
 * wall-clock time rather than the render pipeline's, and a 2D canvas costs
 * nothing when there is nothing to draw.
 *
 * The blobs are the same procedurally generated splat shapes used on world
 * geometry and on characters, so a splash on the lens matches the paint on the
 * wall behind it.
 */
export class SplashOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Splat shapes rasterised once, as white masks ready to be tinted. */
  private stamps: HTMLCanvasElement[] = [];
  private blobs: Blob[] = [];
  /**
   * Scratch surface for tinting one blob at a time. Tinting has to happen in
   * isolation: a composite applied to the main canvas would recolour every
   * blob already drawn there, not just the current one.
   */
  private scratch = document.createElement('canvas');
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private stampSize = 0;

  constructor(container: HTMLElement, atlas: SplatAtlas) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'splash-overlay';
    container.append(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('SplashOverlay: 2D context unavailable');
    this.ctx = ctx;

    this.buildStamps(atlas);
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  /** Cuts each atlas tile out into its own canvas, as an alpha mask. */
  private buildStamps(atlas: SplatAtlas): void {
    const image = atlas.texture.image as { data: Uint8Array; width: number };
    const size = image.width;
    const tile = Math.floor(size / atlas.tilesPerRow);

    for (let v = 0; v < atlas.variants; v++) {
      const sx = (v % atlas.tilesPerRow) * tile;
      const sy = Math.floor(v / atlas.tilesPerRow) * tile;

      const stamp = document.createElement('canvas');
      stamp.width = tile;
      stamp.height = tile;
      const stampCtx = stamp.getContext('2d');
      if (!stampCtx) continue;

      const imageData = stampCtx.createImageData(tile, tile);
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const src = ((sy + y) * size + (sx + x)) * 4;
          const dst = (y * tile + x) * 4;
          // White, with the splat's coverage as alpha. Tinting happens at draw
          // time via a composite, so one stamp serves every paint colour.
          const field = image.data[src]! / 255;
          const shade = Math.round(255 * (0.72 + 0.28 * field));
          imageData.data[dst] = shade;
          imageData.data[dst + 1] = shade;
          imageData.data[dst + 2] = shade;
          imageData.data[dst + 3] = image.data[src + 3]!;
        }
      }
      stampCtx.putImageData(imageData, 0, 0);
      this.stamps.push(stamp);
    }

    this.stampSize = tile;
    this.scratch.width = tile;
    this.scratch.height = tile;
    this.scratchCtx = this.scratch.getContext('2d');
  }

  /** Returns the scratch canvas holding one stamp tinted to `color`. */
  private tint(stamp: HTMLCanvasElement, color: string): HTMLCanvasElement | null {
    const sctx = this.scratchCtx;
    if (!sctx) return null;
    const size = this.stampSize;

    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, size, size);
    sctx.drawImage(stamp, 0, 0);

    // Multiply the colour through the mask's grey shading, so the wet-rim
    // darkening in the splat survives tinting.
    sctx.globalCompositeOperation = 'multiply';
    sctx.fillStyle = color;
    sctx.fillRect(0, 0, size, size);

    // Multiply fills the transparent surround too; mask it back out.
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(stamp, 0, 0);
    sctx.globalCompositeOperation = 'source-over';

    return this.scratch;
  }

  private resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.floor(window.innerWidth * ratio);
    this.canvas.height = Math.floor(window.innerHeight * ratio);
  };

  /**
   * Splashes the lens. `intensity` scales how many blobs land and how big they
   * are — a graze should smear, a square hit should blind.
   */
  splash(color: number, intensity = 1, rng: () => number = Math.random): void {
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    // Restrained on purpose. Six large blobs per hit read as a screen wipe
    // rather than as splatter, and being unable to see is not funny twice.
    const count = Math.round(1 + intensity * 2);

    for (let i = 0; i < count; i++) {
      // Bias toward the edges: paint across the middle of the screen is
      // infuriating rather than funny.
      const edge = rng();
      const along = rng();
      let x: number;
      let y: number;
      // Hugged to the frame: the centre third stays clear so you can still
      // fight while dripping.
      if (edge < 0.25) { x = along; y = rng() * 0.13; }
      else if (edge < 0.5) { x = along; y = 1 - rng() * 0.16; }
      else if (edge < 0.75) { x = rng() * 0.12; y = along; }
      else { x = 1 - rng() * 0.12; y = along; }

      this.blobs.push({
        x,
        y,
        size: (0.07 + rng() * 0.11) * (0.75 + intensity * 0.35),
        rotation: rng() * Math.PI * 2,
        variant: Math.floor(rng() * this.stamps.length),
        color: hex,
        age: 0,
        lifetime: LIFETIME * (0.75 + rng() * 0.6),
        drip: 0.04 + rng() * 0.13,
      });
    }
  }

  /** Blobs currently on screen. */
  get blobCount(): number {
    return this.blobs.length;
  }

  /** Advances and redraws. Returns the number of blobs still on screen. */
  update(dt: number): number {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.blobs.length === 0) return 0;

    for (const blob of this.blobs) blob.age += dt;
    this.blobs = this.blobs.filter((b) => b.age < b.lifetime);

    for (const blob of this.blobs) {
      const t = blob.age / blob.lifetime;
      // Hold opaque, then fade over the last third — paint doesn't start
      // vanishing the instant it lands.
      const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      // Ease the slide so it creeps rather than slides at constant speed.
      const slide = blob.drip * (t * t);

      const stamp = this.stamps[blob.variant % this.stamps.length];
      if (!stamp) continue;

      const size = blob.size * canvas.height;
      const cx = blob.x * canvas.width;
      const cy = (blob.y + slide) * canvas.height;

      const tinted = this.tint(stamp, blob.color);
      if (!tinted) continue;

      ctx.save();
      ctx.globalAlpha = alpha * 0.92;
      ctx.translate(cx, cy);
      ctx.rotate(blob.rotation);
      ctx.drawImage(tinted, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    return this.blobs.length;
  }

  clear(): void {
    this.blobs = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }
}
