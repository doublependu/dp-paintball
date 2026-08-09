import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { Rng } from '../core/Random';
import { fbm2D } from '../core/Noise';
import { saturate, smoothstep } from '../core/MathUtils';

const TILES_PER_ROW = 3;
const VARIANTS = TILES_PER_ROW * TILES_PER_ROW;
const TILE = 400;
const ATLAS_SIZE = TILE * TILES_PER_ROW;

/**
 * Procedural canopy cards.
 *
 * Ghibli foliage reads as a *mass* with a lumpy silhouette, not as individual
 * leaves — so these are cauliflower-like clusters of overlapping lobes, with a
 * top-lit interior gradient. Rendering actual leaves at this distance would be
 * both more expensive and less faithful.
 *
 * ## Which way is up
 *
 * `DataTexture` sets `flipY = false`, so texel row 0 is sampled at `uv.y = 0`,
 * which is the *bottom* of the card. The original gradient was written as
 * `1 - y / tile`, which put the bright crown at row 0 and therefore lit every
 * canopy in the park from underneath — the leaf mass went dark at the top and
 * glowed along its lower edge, which is precisely what an upside-down tree
 * looks like. The vertical term runs with the row index now, and the lobe
 * layout is asymmetric in the same direction: domed and dense above, ragged and
 * open below, where a real crown thins out toward the branches holding it up.
 *
 * Channels: R interior lightness, G leaf break-up, B unused, A coverage.
 */
export class CanopyAtlas {
  readonly texture: DataTexture;
  readonly variants = VARIANTS;
  readonly generationMs: number;

  constructor(seed = 0xc0ffee) {
    const startedAt = performance.now();
    const pixels = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
    const rng = new Rng(seed);

    for (let v = 0; v < VARIANTS; v++) {
      this.renderVariant(
        pixels,
        (v % TILES_PER_ROW) * TILE,
        Math.floor(v / TILES_PER_ROW) * TILE,
        rng,
        v,
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
    rng: Rng,
    variant: number,
  ): void {
    const field = new Float32Array(TILE * TILE);
    const centre = TILE / 2;

    // Row index runs with world up: row 0 is the bottom of the card.
    // Proportion varies per variant, from broad oak-like crowns to the taller
    // vase of an elm, so a stand of trees doesn't repeat one silhouette.
    const squash = 0.72 + (variant % 3) * 0.16;

    interface Lobe { x: number; y: number; r: number; sign: number }
    const lobes: Lobe[] = [];

    // A broad core, sitting a little low: the mass of a crown is carried below
    // its own dome, and centring it makes a lollipop.
    const coreR = TILE * rng.range(0.2, 0.25);
    lobes.push({ x: centre, y: centre - TILE * 0.03, r: coreR, sign: 1 });

    // Upper ring — the dome. Denser and pushed further out than the lower ring,
    // which is what gives the silhouette its cauliflower crown.
    const upper = rng.int(6, 10);
    for (let i = 0; i < upper; i++) {
      const angle = (i / upper) * Math.PI + rng.spread(0.3);
      const distance = coreR * rng.range(0.85, 1.2);
      lobes.push({
        x: centre + Math.cos(angle) * distance,
        y: centre + Math.sin(angle) * distance * squash + TILE * 0.03,
        r: coreR * rng.range(0.4, 0.68),
        sign: 1,
      });
    }

    // Lower ring — fewer, smaller, hanging skirts of leaf.
    const lower = rng.int(3, 6);
    for (let i = 0; i < lower; i++) {
      const angle = Math.PI + (i / lower) * Math.PI + rng.spread(0.35);
      const distance = coreR * rng.range(0.6, 0.95);
      lobes.push({
        x: centre + Math.cos(angle) * distance,
        y: centre + Math.sin(angle) * distance * squash * 1.1,
        r: coreR * rng.range(0.26, 0.46),
        sign: 1,
      });
    }

    // Outlying clumps for asymmetry.
    for (let i = 0; i < rng.int(3, 7); i++) {
      const angle = rng.range(0, Math.PI * 2);
      const distance = coreR * rng.range(1.05, 1.4);
      lobes.push({
        x: centre + Math.cos(angle) * distance,
        y: centre + Math.sin(angle) * distance * squash,
        r: coreR * rng.range(0.16, 0.32),
        sign: 1,
      });
    }

    // And a couple of bites taken out, low and inboard: gaps where the sky
    // shows through the crown. A canopy with a solid interior reads as a
    // balloon, and these cost nothing but a sign flip.
    for (let i = 0; i < rng.int(2, 4); i++) {
      const angle = Math.PI + rng.range(0.2, Math.PI - 0.2);
      const distance = coreR * rng.range(0.35, 0.8);
      lobes.push({
        x: centre + Math.cos(angle) * distance,
        y: centre + Math.sin(angle) * distance * squash,
        r: coreR * rng.range(0.18, 0.32),
        sign: -1,
      });
    }

    for (const lobe of lobes) {
      const minX = Math.max(0, Math.floor(lobe.x - lobe.r));
      const maxX = Math.min(TILE - 1, Math.ceil(lobe.x + lobe.r));
      const minY = Math.max(0, Math.floor(lobe.y - lobe.r));
      const maxY = Math.min(TILE - 1, Math.ceil(lobe.y + lobe.r));
      const rSq = lobe.r * lobe.r;

      for (let y = minY; y <= maxY; y++) {
        const dy = y - lobe.y;
        const dySq = dy * dy;
        for (let x = minX; x <= maxX; x++) {
          const dx = x - lobe.x;
          const tSq = (dx * dx + dySq) / rSq;
          if (tSq >= 1) continue;
          // Wyvill's (1 - t²)³ kernel: finite support, so a lobe's influence
          // actually stops at its radius instead of smearing the whole tile.
          const f = 1 - tSq;
          field[y * TILE + x]! += f * f * f * lobe.sign * 1.35;
        }
      }
    }

    const seed = variant * 137;
    // The break-up noise perturbs coverage by at most ±0.11, so any texel whose
    // field value falls below the bottom of the transition band by more than
    // that is transparent whatever the noise says. Testing that first skips the
    // fbm on the ~60% of each tile that lies outside the crown, and this loop
    // runs 1.44 million times at boot.
    const FLOOR = 0.44 - 0.11;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const value = field[y * TILE + x]!;
        if (value <= FLOOR) continue;

        // Leaf-scale break-up, applied to the *silhouette* as well as the
        // shading, so the edge of the mass is chewed rather than smooth.
        const clumps = fbm2D(x * 0.055, y * 0.055, 2, seed);
        const coverage = smoothstep(0.44, 0.6, value + (clumps - 0.5) * 0.22);
        if (coverage <= 0.004) continue;

        // Top-lit: brighter at the crown, deep in shadow underneath. This is
        // what makes a flat card read as a volume — and it only works if the
        // gradient runs the right way up (see the class comment).
        const vertical = y / TILE;
        const lightness = saturate(
          0.1 + vertical * 0.78 + clumps * 0.34 + saturate(value - 1) * 0.12,
        );

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
