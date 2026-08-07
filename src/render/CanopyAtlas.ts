import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { Rng } from '../core/Random';
import { saturate, smoothstep } from '../core/MathUtils';

const ATLAS_SIZE = 1024;
const VARIANTS = 4;
const TILES_PER_ROW = 2;

/**
 * Procedural canopy cards.
 *
 * Ghibli foliage reads as a *mass* with a lumpy silhouette, not as individual
 * leaves — so these are cauliflower-like clusters of overlapping lobes, with a
 * top-lit interior gradient. Rendering actual leaves at this distance would be
 * both more expensive and less faithful.
 *
 * Channels: R interior lightness, G noise, B unused, A coverage.
 */
export class CanopyAtlas {
  readonly texture: DataTexture;
  readonly variants = VARIANTS;
  readonly generationMs: number;

  constructor(seed = 0xc0ffee) {
    const startedAt = performance.now();
    const pixels = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
    const tile = ATLAS_SIZE / TILES_PER_ROW;
    const rng = new Rng(seed);

    for (let v = 0; v < VARIANTS; v++) {
      this.renderVariant(
        pixels,
        (v % TILES_PER_ROW) * tile,
        Math.floor(v / TILES_PER_ROW) * tile,
        tile,
        rng,
      );
    }

    const texture = new DataTexture(pixels, ATLAS_SIZE, ATLAS_SIZE, RGBAFormat, UnsignedByteType);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.texture = texture;

    this.generationMs = performance.now() - startedAt;
  }

  getTileTransform(variant: number): { offsetX: number; offsetY: number; scale: number } {
    const index = variant % VARIANTS;
    const scale = 1 / TILES_PER_ROW;
    return {
      offsetX: (index % TILES_PER_ROW) * scale,
      offsetY: Math.floor(index / TILES_PER_ROW) * scale,
      scale,
    };
  }

  private renderVariant(
    pixels: Uint8Array,
    tileX: number,
    tileY: number,
    tile: number,
    rng: Rng,
  ): void {
    const field = new Float32Array(tile * tile);
    const center = tile / 2;

    // A broad core, then lobes pushed out around the rim. The lobes are what
    // give the silhouette its cauliflower edge; a single disc reads as a
    // lollipop.
    const lobes: Array<{ x: number; y: number; r: number }> = [];
    const coreR = tile * 0.24;
    lobes.push({ x: center, y: center + tile * 0.02, r: coreR });

    const ring = rng.int(7, 12);
    for (let i = 0; i < ring; i++) {
      const angle = (i / ring) * Math.PI * 2 + rng.spread(0.35);
      const distance = coreR * rng.range(0.75, 1.15);
      lobes.push({
        x: center + Math.cos(angle) * distance,
        // Squash vertically: canopies are wider than they are tall.
        y: center + Math.sin(angle) * distance * 0.82,
        r: coreR * rng.range(0.38, 0.68),
      });
    }
    // A few small clumps for asymmetry.
    for (let i = 0; i < rng.int(3, 7); i++) {
      const angle = rng.range(0, Math.PI * 2);
      const distance = coreR * rng.range(1.0, 1.35);
      lobes.push({
        x: center + Math.cos(angle) * distance,
        y: center + Math.sin(angle) * distance * 0.8,
        r: coreR * rng.range(0.18, 0.34),
      });
    }

    for (const lobe of lobes) {
      const minX = Math.max(0, Math.floor(lobe.x - lobe.r));
      const maxX = Math.min(tile - 1, Math.ceil(lobe.x + lobe.r));
      const minY = Math.max(0, Math.floor(lobe.y - lobe.r));
      const maxY = Math.min(tile - 1, Math.ceil(lobe.y + lobe.r));
      const rSq = lobe.r * lobe.r;

      for (let y = minY; y <= maxY; y++) {
        const dy = y - lobe.y;
        const dySq = dy * dy;
        for (let x = minX; x <= maxX; x++) {
          const dx = x - lobe.x;
          const tSq = (dx * dx + dySq) / rSq;
          if (tSq >= 1) continue;
          const f = 1 - tSq;
          field[y * tile + x]! += f * f * f;
        }
      }
    }

    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const value = field[y * tile + x]!;
        const coverage = smoothstep(0.42, 0.58, value);
        if (coverage <= 0.004) continue;

        // Leaf-scale break-up, so the mass isn't a flat silhouette.
        const clumps =
          0.5 +
          0.5 *
            Math.sin(x * 0.14 + Math.sin(y * 0.09) * 3.1) *
            Math.cos(y * 0.17 - Math.sin(x * 0.07) * 2.3);

        // Top-lit: brighter at the crown, deep in shadow underneath. This is
        // what makes a flat card read as a volume.
        const vertical = 1 - y / tile;
        const lightness = saturate(vertical * 0.85 + clumps * 0.25 + value * 0.1);

        const px = ((tileY + y) * ATLAS_SIZE + (tileX + x)) * 4;
        pixels[px] = Math.round(lightness * 255);
        pixels[px + 1] = Math.round(clumps * 255);
        pixels[px + 2] = 0;
        pixels[px + 3] = Math.round(coverage * 255);
      }
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}
