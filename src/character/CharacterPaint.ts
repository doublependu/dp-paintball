import {
  Color,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import type { SplatAtlas } from '../paint/SplatAtlas';
import { faceUvRect } from './VoxelRig';

const STAMP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const STAMP_FRAGMENT = /* glsl */ `
uniform sampler2D uSplatAtlas;
uniform vec3 uTint;
uniform vec3 uTile;   // atlas offset.xy, scale.z
uniform float uRotation;
varying vec2 vUv;

void main() {
  // Rotate about the quad centre so repeated hits don't stamp identically.
  vec2 centered = vUv - 0.5;
  float s = sin( uRotation );
  float c = cos( uRotation );
  vec2 rotated = vec2( centered.x * c - centered.y * s,
                       centered.x * s + centered.y * c ) + 0.5;
  if ( rotated.x < 0.0 || rotated.x > 1.0 || rotated.y < 0.0 || rotated.y > 1.0 ) discard;

  vec4 splat = texture2D( uSplatAtlas, rotated * uTile.z + uTile.xy );
  if ( splat.a < 0.35 ) discard;

  // splat.r rises toward the interior; darken the wet rim, as world paint does.
  gl_FragColor = vec4( uTint * ( 0.74 + 0.26 * splat.r ), 1.0 );
}
`;

/**
 * Per-character paint, accumulated into a render target.
 *
 * World paint uses decals, but a decal is baked against static geometry — on an
 * animated limb it would need reprojecting every frame. Characters instead own
 * a small paint texture that their material samples, so paint travels with the
 * body for free and survives any pose.
 *
 * Each splat is scissored to the face it landed on. Without that the quad would
 * bleed into whatever face happens to sit beside it in the atlas, which is not
 * its geometric neighbour, and paint would appear in unrelated places.
 */
export class CharacterPaint {
  readonly target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly quad: Mesh;
  private readonly material: ShaderMaterial;
  private readonly size: number;
  private stamped = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly atlas: SplatAtlas,
    size = 512,
  ) {
    this.size = size;
    this.target = new WebGLRenderTarget(size, size, {
      depthBuffer: false,
      stencilBuffer: false,
    });

    // UV space maps directly to the camera's view, so a quad at (u,v) lands at
    // exactly that texel.
    this.camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

    this.material = new ShaderMaterial({
      vertexShader: STAMP_VERTEX,
      fragmentShader: STAMP_FRAGMENT,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      // Fragments either replace the target or discard; blending would fight
      // the alpha test and soften every edge.
      blending: NoBlending,
      uniforms: {
        uSplatAtlas: { value: atlas.texture },
        uTint: { value: new Color(0xffffff) },
        uTile: { value: new Vector4(0, 0, 1, 0) },
        uRotation: { value: 0 },
      },
    });

    this.quad = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.scene.add(this.quad);

    this.clear();
  }

  get splatCount(): number {
    return this.stamped;
  }

  /** Wipes all paint from this character. */
  clear(): void {
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    // Transparent black: the character material treats alpha as paint coverage.
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(previous);
    this.stamped = 0;
  }

  /**
   * Stamps a splat at a paint-atlas UV.
   *
   * `partIndex` and `faceIndex` identify the face to scissor against; `radius`
   * is in UV units.
   */
  stamp(
    u: number,
    v: number,
    partIndex: number,
    faceIndex: number,
    radius: number,
    color: number,
    variant: number,
    rotation: number,
  ): void {
    const rect = faceUvRect(partIndex, faceIndex);
    const tile = this.atlas.getTileTransform(variant);

    (this.material.uniforms.uTint!.value as Color).setHex(color);
    (this.material.uniforms.uTile!.value as Vector4).set(
      tile.offsetX,
      tile.offsetY,
      tile.scale,
      0,
    );
    this.material.uniforms.uRotation!.value = rotation;

    this.quad.position.set(u, v, 0);
    this.quad.scale.set(radius * 2, radius * 2, 1);
    this.quad.updateMatrixWorld(true);

    const previousTarget = this.renderer.getRenderTarget();
    const previousScissorTest = this.renderer.getScissorTest();
    const previousScissor = this.renderer.getScissor(new Vector4());
    const previousAutoClear = this.renderer.autoClear;

    this.renderer.setRenderTarget(this.target);
    // Accumulate: never clear between stamps.
    this.renderer.autoClear = false;
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(
      Math.floor(rect.u0 * this.size),
      Math.floor(rect.v0 * this.size),
      Math.ceil((rect.u1 - rect.u0) * this.size),
      Math.ceil((rect.v1 - rect.v0) * this.size),
    );

    this.renderer.render(this.scene, this.camera);

    this.renderer.setScissorTest(previousScissorTest);
    this.renderer.setScissor(previousScissor);
    this.renderer.autoClear = previousAutoClear;
    this.renderer.setRenderTarget(previousTarget);

    this.stamped++;
  }

  /** Texel size, for shaders that want to sample neighbours. */
  get texelSize(): Vector2 {
    return new Vector2(1 / this.size, 1 / this.size);
  }

  dispose(): void {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
