import {
  Color,
  DoubleSide,
  Euler,
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
}

/** Cards per tree. Enough to read as a volume from any angle without bloating. */
const CARDS_PER_TREE = 7;

/**
 * Tree canopies as batched alpha cards.
 *
 * Every canopy in the park is one instanced draw call. Cards are placed at
 * scattered orientations inside the crown volume rather than billboarded — a
 * billboard cloud swims disconcertingly as the camera orbits, and fixed cards
 * hold their shape, which matters more than perfect coverage for a painted mass.
 *
 * Foliage does not cast shadows. Alpha-tested shadow casting needs a matching
 * custom depth material, and without one every canopy would throw a hard
 * rectangular shadow — far worse than none. Trunks, which are solid, do cast.
 */
export class Foliage {
  readonly mesh: InstancedMesh;
  private readonly atlas: CanopyAtlas;
  private readonly material: MeshToonMaterial;
  /** Captured in onBeforeCompile so wind time can be driven each frame. */
  private shaderUniforms?: Record<string, { value: unknown }>;

  constructor(trees: TreeSpec[], rng: Rng) {
    this.atlas = new CanopyAtlas();

    const count = trees.length * CARDS_PER_TREE;
    const geometry = new PlaneGeometry(1, 1);
    this.material = this.createMaterial();

    this.mesh = new InstancedMesh(geometry, this.material, count);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
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
      for (let c = 0; c < CARDS_PER_TREE; c++) {
        // Distribute cards through the crown volume, biased outward so the
        // silhouette is dense and the interior stays open.
        const theta = rng.range(0, Math.PI * 2);
        const phi = Math.acos(rng.range(-0.75, 0.95));
        const r = tree.radius * Math.cbrt(rng.range(0.05, 1)) * 0.55;

        position.set(
          tree.position.x + Math.sin(phi) * Math.cos(theta) * r,
          tree.position.y + tree.crownHeight + Math.cos(phi) * r * 0.72,
          tree.position.z + Math.sin(phi) * Math.sin(theta) * r,
        );

        // Mostly upright, tilted a little — cards lying flat would vanish when
        // viewed edge-on from the ground.
        euler.set(rng.spread(0.35), rng.range(0, Math.PI * 2), rng.spread(0.28));
        quaternion.setFromEuler(euler);

        const size = tree.radius * rng.range(1.25, 1.85);
        scale.set(size, size * rng.range(0.78, 1.0), 1);

        matrix.compose(position, quaternion, scale);
        this.mesh.setMatrixAt(i, matrix);

        // Vary each card's tint so the mass has internal depth.
        tint.copy(shadeColor).lerp(litColor, rng.range(0.35, 1));
        if (tree.kind > 0.5) tint.offsetHSL(0.02, 0.05, -0.04);
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

           // Wind. Weighted by height up the card so the crown swings and the
           // base stays put, and phase-offset per card so the whole park does
           // not sway in unison.
           float sway = sin( uTime * 1.1 + aPhase ) * 0.5
                      + sin( uTime * 2.3 + aPhase * 1.7 ) * 0.18;
           transformed.x += sway * 0.16 * uv.y;
           transformed.z += sway * 0.11 * uv.y;`,
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
           diffuseColor.rgb = vTint * ( 0.55 + 0.65 * canopy.r );
           diffuseColor.a = 1.0;`,
        );
    };

    material.customProgramCacheKey = () => 'foliage-canopy-v1';
    return material;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}
