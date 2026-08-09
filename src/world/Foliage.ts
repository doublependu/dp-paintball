import {
  Color,
  DoubleSide,
  Euler,
  MeshDepthMaterial,
  RGBADepthPacking,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshToonMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { palette } from '../core/Config';
import type { Rng } from '../core/Random';
import { CanopyAtlas } from '../render/CanopyAtlas';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import { getCelGradient } from '../render/CelMaterial';

export interface TreeSpec {
  position: Vector3;
  /** Canopy radius in metres. */
  radius: number;
  /** Height of the canopy centre above the base. */
  crownHeight: number;
  /** 0 elm (tall, vase-shaped), 1 ramble scrub (low, broad). */
  kind: number;
  /**
   * Cards making up this crown. Defaults to `CARDS_PER_TREE`.
   *
   * The woodland belt turns this down: a tree seen from 80m through forty other
   * trees needs a silhouette, not a volume, and the belt holds enough trees
   * that the difference between five cards and nine is thousands of quads.
   */
  cards?: number;
  /**
   * Hue rotation applied to this crown's tint, in turns.
   *
   * Photographs of the park in leaf are never one green: fresh yellow-greens,
   * deep blue-greens and the odd copper beech all sit in the same treeline.
   * Per-card tinting alone can't do that — it varies *within* a crown, which
   * makes every tree the same average colour.
   */
  hue?: number;
  /** Lightness offset applied to this crown's tint. */
  lightness?: number;
}

/** Cards per tree. Enough to read as a volume from any angle without bloating. */
const CARDS_PER_TREE = 9;

/**
 * Wind displacement, shared verbatim between the colour and depth passes.
 * If these two ever diverge, canopies sway while their shadows stay put.
 */
const WIND_SNIPPET = /* glsl */ `
  // Weighted by height up the card so the crown swings and the base stays put,
  // and phase-offset per card so the whole park does not sway in unison.
  float sway = sin( uTime * 1.1 + aPhase ) * 0.5
             + sin( uTime * 2.3 + aPhase * 1.7 ) * 0.18;
  transformed.x += sway * 0.16 * uv.y;
  transformed.z += sway * 0.11 * uv.y;
`;

/**
 * Tree canopies as batched alpha cards.
 *
 * Every canopy in the park is one instanced draw call. Cards are placed at
 * scattered orientations inside the crown volume rather than billboarded — a
 * billboard cloud swims disconcertingly as the camera orbits, and fixed cards
 * hold their shape, which matters more than perfect coverage for a painted mass.
 *
 * Foliage casts shadows through a custom depth material that repeats both the
 * alpha cutout and the wind displacement. Both halves are required: without the
 * cutout every canopy throws a hard rectangular shadow, and without the wind the
 * shadow stays rigid while the leaves above it sway, which is worse than a
 * static tree.
 */
export class Foliage {
  readonly mesh: InstancedMesh;
  private readonly atlas: CanopyAtlas;
  private readonly material: MeshToonMaterial;
  /** Captured in onBeforeCompile so wind time can be driven each frame. */
  private shaderUniforms?: Record<string, { value: unknown }>;
  private depthUniforms?: Record<string, { value: unknown }>;

  constructor(trees: TreeSpec[], rng: Rng) {
    this.atlas = new CanopyAtlas();

    let count = 0;
    for (const tree of trees) count += tree.cards ?? CARDS_PER_TREE;
    const geometry = new PlaneGeometry(1, 1);
    this.material = this.createMaterial();

    this.mesh = new InstancedMesh(geometry, this.material, count);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = this.createDepthMaterial();
    // Excluded from the outline prepass. That pass overrides every material
    // with MeshNormalMaterial, which has no notion of alphaTest — so each card
    // would write its full quad into the normal buffer and the edge detector
    // would ink a hard rectangle around geometry that isn't drawn.
    //
    // Skipping it is also the better look: Ghibli canopies are soft masses with
    // no ink line, unlike the hard-edged architecture.
    this.mesh.layers.set(NO_OUTLINE_LAYER);
    // Canopies span the map; per-instance culling isn't available anyway.
    this.mesh.frustumCulled = false;

    const tints = new Float32Array(count * 3);
    const tiles = new Float32Array(count * 3);
    const phases = new Float32Array(count);

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Euler();
    const tint = new Color();

    const litColor = new Color(palette.foliageLit);
    const shadeColor = new Color(palette.foliageShade);

    let i = 0;
    for (const tree of trees) {
      const cards = tree.cards ?? CARDS_PER_TREE;
      for (let c = 0; c < cards; c++) {
        // Distribute cards through the crown volume, biased outward so the
        // silhouette is dense and the interior stays open. The first card of
        // every crown is planted dead centre: with the outward bias alone, a
        // four-card crown could leave a hole straight through the middle, and
        // the branch structure showing through it is exactly what a canopy is
        // there to hide.
        const theta = rng.range(0, Math.PI * 2);
        const phi = Math.acos(rng.range(-0.75, 0.95));
        const r = c === 0 ? 0 : tree.radius * Math.cbrt(rng.range(0.05, 1)) * 0.5;

        position.set(
          tree.position.x + Math.sin(phi) * Math.cos(theta) * r,
          tree.position.y + tree.crownHeight + Math.cos(phi) * r * 0.72,
          tree.position.z + Math.sin(phi) * Math.sin(theta) * r,
        );

        // Mostly upright, tilted a little — cards lying flat would vanish when
        // viewed edge-on from the ground.
        euler.set(rng.spread(0.35), rng.range(0, Math.PI * 2), rng.spread(0.28));
        quaternion.setFromEuler(euler);

        const size = tree.radius * rng.range(1.6, 2.1);
        scale.set(size, size * rng.range(0.78, 1.0), 1);

        matrix.compose(position, quaternion, scale);
        this.mesh.setMatrixAt(i, matrix);

        // Vary each card's tint so the mass has internal depth, then rotate the
        // whole crown so the *stand* has variety too.
        tint.copy(shadeColor).lerp(litColor, rng.range(0.5, 1));
        if (tree.kind > 0.5) tint.offsetHSL(0.02, 0.05, -0.04);
        if (tree.hue || tree.lightness) tint.offsetHSL(tree.hue ?? 0, 0, tree.lightness ?? 0);
        tints[i * 3] = tint.r;
        tints[i * 3 + 1] = tint.g;
        tints[i * 3 + 2] = tint.b;

        const tile = this.atlas.getTileTransform(rng.int(0, this.atlas.variants));
        tiles[i * 3] = tile.offsetX;
        tiles[i * 3 + 1] = tile.offsetY;
        tiles[i * 3 + 2] = tile.scale;

        phases[i] = rng.range(0, Math.PI * 2);
        i++;
      }
    }

    geometry.setAttribute('aTint', new InstancedBufferAttribute(tints, 3));
    geometry.setAttribute('aTile', new InstancedBufferAttribute(tiles, 3));
    geometry.setAttribute('aPhase', new InstancedBufferAttribute(phases, 1));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(elapsed: number): void {
    if (this.shaderUniforms) this.shaderUniforms.uTime!.value = elapsed;
    // The shadow must sway with the leaves that cast it.
    if (this.depthUniforms) this.depthUniforms.uTime!.value = elapsed;
  }

  /**
   * Depth material for the shadow pass: same cutout, same sway.
   * Its own uTime uniform, driven alongside the colour material's.
   */
  private createDepthMaterial(): MeshDepthMaterial {
    const material = new MeshDepthMaterial({
      depthPacking: RGBADepthPacking,
      alphaTest: 0.5,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCanopy = { value: this.atlas.texture };
      shader.uniforms.uTime = { value: 0 };
      this.depthUniforms = shader.uniforms;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aTile;
           attribute float aPhase;
           uniform float uTime;
           varying vec3 vTile;
           varying vec2 vCardUv;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vTile = aTile;
           vCardUv = uv;
           ${WIND_SNIPPET}`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D uCanopy;
           varying vec3 vTile;
           varying vec2 vCardUv;`,
        )
        .replace(
          '#include <map_fragment>',
          `if ( texture2D( uCanopy, vCardUv * vTile.z + vTile.xy ).a < 0.5 ) discard;`,
        );
    };

    material.customProgramCacheKey = () => 'foliage-depth-v1';
    return material;
  }

  private createMaterial(): MeshToonMaterial {
    const material = new MeshToonMaterial({
      gradientMap: getCelGradient(),
      // Alpha-tested, not blended: thousands of overlapping transparent cards
      // would need sorting, and sorting them is hopeless.
      transparent: false,
      alphaTest: 0.5,
      // Cards are viewed from both faces as the camera orbits.
      side: DoubleSide,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCanopy = { value: this.atlas.texture };
      shader.uniforms.uTime = { value: 0 };
      this.shaderUniforms = shader.uniforms;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aTint;
           attribute vec3 aTile;
           attribute float aPhase;
           uniform float uTime;
           varying vec3 vTint;
           varying vec3 vTile;
           varying vec2 vCardUv;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vTint = aTint;
           vTile = aTile;
           vCardUv = uv;

           ${WIND_SNIPPET}`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D uCanopy;
           varying vec3 vTint;
           varying vec3 vTile;
           varying vec2 vCardUv;`,
        )
        .replace(
          '#include <map_fragment>',
          `vec4 canopy = texture2D( uCanopy, vCardUv * vTile.z + vTile.xy );
           if ( canopy.a < 0.5 ) discard;
           // canopy.r is the baked top-lit gradient; it does most of the work
           // of making a flat card look like a volume.
           // Lifted floor: with nine overlapping cards the shaded undersides
           // stacked up and the whole crown read as near-black. The span is
           // wider than the floor is high, so the crown still reads as lit from
           // above rather than as a flat tint.
           diffuseColor.rgb = vTint * ( 0.62 + 0.72 * canopy.r );
           diffuseColor.a = 1.0;`,
        );
    };

    material.customProgramCacheKey = () => 'foliage-canopy-v2';
    return material;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}
