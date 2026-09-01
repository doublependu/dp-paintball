import {
  Color,
  DataTexture,
  MeshToonMaterial,
  NearestFilter,
  RGBAFormat,
  type Texture,
  UnsignedByteType,
} from 'three';
import { palette, render as renderConfig } from '../core/Config';

export interface CelOptions {
  color: number;
  /**
   * Optional albedo texture, multiplied by `color` as three's `map` always is —
   * so a mapped surface usually wants `color: 0xffffff`.
   *
   * Almost nothing in this park is textured; the one caller is the paint
   * screen, whose whole surface is a canvas that gets stamped into.
   */
  map?: Texture;
  /** Rim colour. Defaults to the warm sun tint. */
  rimColor?: number;
  /** 0 disables the rim entirely. */
  rimStrength?: number;
  /** Higher values tighten the rim to the silhouette edge. */
  rimPower?: number;
  transparent?: boolean;
  opacity?: number;
}

let sharedGradient: DataTexture | undefined;

/**
 * The lighting ramp. Hard steps between a small number of bands is the whole
 * point — a smooth ramp is just Lambert with extra steps.
 *
 * The darkest band sits well above zero because shadows in this game are never
 * black; they're filled by the cool hemisphere light and read as blue-violet.
 */
export function getCelGradient(): DataTexture {
  if (sharedGradient) return sharedGradient;

  const bands = renderConfig.celBands;
  const data = new Uint8Array(bands * 4);
  for (let i = 0; i < bands; i++) {
    // Bias the steps upward so the terminator sits low on the form and most of
    // the surface stays lit, which is how painted backgrounds read.
    const t = (i + 1) / bands;
    const value = Math.round(255 * (0.38 + 0.62 * Math.pow(t, 0.85)));
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }

  const texture = new DataTexture(data, bands, 1, RGBAFormat, UnsignedByteType);
  // Nearest is mandatory: linear filtering would smooth the bands back into a
  // gradient and undo the entire effect.
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  sharedGradient = texture;
  return texture;
}

/**
 * Banded toon shading with a Fresnel rim.
 *
 * Built on MeshToonMaterial rather than a bespoke ShaderMaterial so it keeps
 * three's shadows, fog and light handling for free — writing lighting from
 * scratch here would buy nothing and cost all of that.
 *
 * The warm-light/cool-shadow split is *not* done in the shader. It falls out of
 * the scene lighting: a warm directional key plus a cool hemisphere fill means
 * unlit surfaces receive only the cool ambient. Same result, no shader hack,
 * and it stays correct as lights change.
 */
export function createCelMaterial(options: CelOptions): MeshToonMaterial {
  const {
    color,
    map,
    rimColor = palette.sunWarm,
    rimStrength = 0.28,
    rimPower = 3.2,
    transparent = false,
    opacity = 1,
  } = options;

  const material = new MeshToonMaterial({
    color,
    map,
    gradientMap: getCelGradient(),
    transparent,
    opacity,
  });

  if (rimStrength > 0) {
    patchRimLight(material, rimColor, rimStrength, rimPower);
  }

  return material;
}

/**
 * Adds a view-dependent rim. This is the one thing worth a shader hack: it
 * separates figures from the background the way a painted highlight does, and
 * no arrangement of lights reproduces it.
 */
function patchRimLight(
  material: MeshToonMaterial,
  rimColor: number,
  rimStrength: number,
  rimPower: number,
): void {
  const rim = new Color(rimColor);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rim };
    shader.uniforms.uRimStrength = { value: rimStrength };
    shader.uniforms.uRimPower = { value: rimPower };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;
         uniform float uRimStrength;
         uniform float uRimPower;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
           // vViewPosition points from the fragment toward the camera.
           vec3 celNormal = normalize( vNormal );
           vec3 celView = normalize( vViewPosition );
           float rimAmount = 1.0 - clamp( dot( celNormal, celView ), 0.0, 1.0 );
           rimAmount = pow( rimAmount, uRimPower );
           outgoingLight += uRimColor * rimAmount * uRimStrength;
         }
         #include <opaque_fragment>`,
      );
  };

  // Materials sharing a program must share a cache key, and materials with
  // different injected code must not.
  material.customProgramCacheKey = () => `cel-rim-${rimStrength}-${rimPower}-${rimColor}`;
}

export function disposeCelShared(): void {
  sharedGradient?.dispose();
  sharedGradient = undefined;
}
