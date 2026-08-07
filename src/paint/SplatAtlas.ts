import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { paint as paintConfig } from '../core/Config';
import { Rng } from '../core/Random';
import { saturate, smoothstep } from '../core/MathUtils';

/**
 * A metaball disc contributing to the splat field. `r` is the *influence*
 * radius; the visible edge lands near 0.45r once the field is thresholded.
 *
 * The kernel is Wyvill's (1 - t^2)^3 with finite support rather than the
 * textbook r^2/d^2. Infinite support merged every lobe into one smooth disc and
 * washed out the edge — which is how the first pass ended up drawing circles
 * instead of splats.
 */
interface Blob {
  x: number;
  y: number;
  r: number;
}

/** Field value where the surface sits. */
const THRESHOLD = 0.5;
/** Half-width of the antialiased band around THRESHOLD. Small = crisp edge. */
const EDGE_SOFTNESS = 0.075;
/** Visible radius as a fraction of influence radius, given THRESHOLD. */
const VISIBLE_RATIO = 0.454;

/**
 * Procedurally generated splat shapes, packed into one atlas at boot.
 *
 * Generating rather than shipping these costs ~tens of milliseconds and saves
 * an asset download entirely, which is the trade the load budget wants. It also
 * means splat variety is a config number rather than an art task.
 *
 * Channel layout:
 *   R  field strength, for wet-edge and rim darkening in the paint shader
 *   G  low-frequency interior noise, to break up flat fills
 *   B  drip mask, so tails can be animated separately from the main mass
 *   A  coverage
 */
export class SplatAtlas {
  readonly texture: DataTexture;
  readonly variants: number;
  readonly tilesPerRow: number;
  /** Milliseconds spent generating — surfaced so the load budget stays honest. */
  readonly generationMs: number;

  constructor(seed = 0x5b1a7) {
    const startedAt = performance.now();

    const size = paintConfig.splatAtlasSize;
    this.variants = paintConfig.splatVariants;
    this.tilesPerRow = Math.ceil(Math.sqrt(this.variants));
    const tile = Math.floor(size / this.tilesPerRow);

    const pixels = new Uint8Array(size * size * 4);
    const rng = new Rng(seed);

    for (let v = 0; v < this.variants; v++) {
      const tileX = (v % this.tilesPerRow) * tile;
      const tileY = Math.floor(v / this.tilesPerRow) * tile;
      this.renderVariant(pixels, size, tileX, tileY, tile, rng);
    }

    const texture = new DataTexture(pixels, size, size, RGBAFormat, UnsignedByteType);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    // No mipmaps: splats are sampled at roughly uniform scale, and mip chains
    // across tile boundaries would bleed neighbouring variants together.
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.texture = texture;

    this.generationMs = performance.now() - startedAt;
  }

  /** UV offset and scale for one variant, for the shader that stamps it. */
  getTileTransform(variant: number): { offsetX: number; offsetY: number; scale: number } {
    const index = variant % this.variants;
    const scale = 1 / this.tilesPerRow;
    return {
      offsetX: (index % this.tilesPerRow) * scale,
      offsetY: Math.floor(index / this.tilesPerRow) * scale,
      scale,
    };
  }

  private renderVariant(
    pixels: Uint8Array,
    atlasSize: number,
    tileX: number,
    tileY: number,
    tile: number,
    rng: Rng,
  ): void {
    const { blobs, coreVisible } = this.buildBlobs(rng, tile);
    // Drips are tracked separately so they can land in their own channel.
    const dripStart = blobs.length;
    this.addDrips(blobs, rng, tile, coreVisible);

    const field = new Float32Array(tile * tile);
    const dripField = new Float32Array(tile * tile);

    for (let i = 0; i < blobs.length; i++) {
      const blob = blobs[i]!;
      const target = i >= dripStart ? dripField : field;
      // Support is exactly r, so the bounding box is exact rather than a guess.
      const minX = Math.max(0, Math.floor(blob.x - blob.r));
      const maxX = Math.min(tile - 1, Math.ceil(blob.x + blob.r));
      const minY = Math.max(0, Math.floor(blob.y - blob.r));
      const maxY = Math.min(tile - 1, Math.ceil(blob.y + blob.r));
      const rSq = blob.r * blob.r;

      for (let y = minY; y <= maxY; y++) {
        const dy = y - blob.y;
        const dySq = dy * dy;
        for (let x = minX; x <= maxX; x++) {
          const dx = x - blob.x;
          const tSq = (dx * dx + dySq) / rSq;
          if (tSq >= 1) continue;
          const falloff = 1 - tSq;
          target[y * tile + x]! += falloff * falloff * falloff;
        }
      }
    }

    const noiseScale = 0.055;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const index = y * tile + x;
        const main = field[index]!;
        const drip = dripField[index]!;
        const combined = main + drip;

        // A narrow band around the threshold antialiases the edge without the
        // wide gradient that made the first pass look airbrushed.
        const coverage = smoothstep(
          THRESHOLD - EDGE_SOFTNESS,
          THRESHOLD + EDGE_SOFTNESS,
          combined,
        );
        if (coverage <= 0.002) continue;

        const noise = saturate(
          0.5 + 0.5 * Math.sin(x * noiseScale * 2.3 + y * noiseScale * 1.7) *
            Math.cos(x * noiseScale * 1.1 - y * noiseScale * 2.9),
        );

        const px = ((tileY + y) * atlasSize + (tileX + x)) * 4;
        // Remap so the rim reads as 0 and the thick interior as 1, which is
        // what the wet-edge term in the paint shader wants.
        pixels[px] = Math.round(saturate((combined - THRESHOLD) * 1.2) * 255);
        pixels[px + 1] = Math.round(noise * 255);
        pixels[px + 2] = Math.round(saturate(drip / Math.max(combined, 1e-4)) * 255);
        pixels[px + 3] = Math.round(coverage * 255);
      }
    }
  }

  /** Central mass plus scattered droplets — the silhouette of a wet impact. */
  private buildBlobs(rng: Rng, tile: number): { blobs: Blob[]; coreVisible: number } {
    const center = tile / 2;
    const blobs: Blob[] = [];

    // Everything stays inside this radius so satellites don't clip the tile
    // edge or bleed into the neighbouring variant.
    const safeRadius = tile * 0.42;

    // Core: one main mass plus lobes pushed well off-centre. The first pass
    // clustered these within half a radius and varied them barely at all, which
    // is precisely how you draw a circle by accident.
    const coreVisible = tile * rng.range(0.15, 0.2);
    const coreR = coreVisible / VISIBLE_RATIO;
    blobs.push({ x: center, y: center, r: coreR });

    const lobeCount = rng.int(4, 8);
    // A random anisotropy per variant, so splats aren't all radially uniform.
    const stretch = rng.range(0.7, 1.4);
    const stretchAngle = rng.range(0, Math.PI * 2);
    for (let i = 0; i < lobeCount; i++) {
      // Jittered rather than uniform angles, so lobes clump on one side.
      const angle = (i / lobeCount) * Math.PI * 2 + rng.spread(0.9);
      const distance = coreVisible * rng.range(0.55, 1.25);
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      // Apply the stretch in the variant's own frame.
      const ca = Math.cos(stretchAngle);
      const sa = Math.sin(stretchAngle);
      const localX = dx * ca + dy * sa;
      const localY = -dx * sa + dy * ca;
      blobs.push({
        x: center + (localX * stretch * ca - (localY / stretch) * sa),
        y: center + (localX * stretch * sa + (localY / stretch) * ca),
        // Wide radius variation is what breaks up the outline.
        r: coreR * rng.range(0.35, 0.95),
      });
    }

    // Satellites: far enough out that the field leaves them separate, which is
    // what sells it as spatter rather than a blob.
    const satelliteCount = rng.int(5, 11);
    for (let i = 0; i < satelliteCount; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const visible = tile * rng.range(0.008, 0.028);
      const distance = Math.min(
        safeRadius - visible,
        coreVisible * rng.range(1.4, 2.4),
      );
      blobs.push({
        x: center + Math.cos(angle) * distance,
        y: center + Math.sin(angle) * distance,
        r: visible / VISIBLE_RATIO,
      });
    }

    return { blobs, coreVisible };
  }

  /** Tails running down from the core, tapering into a terminal bead. */
  private addDrips(blobs: Blob[], rng: Rng, tile: number, coreVisible: number): void {
    const center = tile / 2;
    // At least one: a splat with no run is a sticker, not wet paint.
    const dripCount = rng.int(1, 4);
    const maxY = tile * 0.94;

    for (let i = 0; i < dripCount; i++) {
      const startX = center + rng.spread(coreVisible * 0.85);
      // Start inside the core mass so the tail reads as connected to it.
      const startY = center + coreVisible * 0.55;
      const length = Math.min(tile * rng.range(0.18, 0.36), maxY - startY);
      if (length <= 0) continue;

      const steps = Math.max(4, Math.round(length / (tile * 0.012)));
      const startVisible = tile * rng.range(0.016, 0.03);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        // Taper along the run, then bulge at the tip where paint pools.
        const bead = t > 0.88 ? 1.8 : 1;
        const visible = startVisible * (1 - t * 0.55) * bead;
        blobs.push({
          x: startX + rng.spread(tile * 0.004),
          y: startY + t * length,
          r: visible / VISIBLE_RATIO,
        });
      }
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}
