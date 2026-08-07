import {
  Color,
  DepthFormat,
  DepthTexture,
  MeshNormalMaterial,
  NearestFilter,
  type PerspectiveCamera,
  type Scene,
  UnsignedIntType,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { palette, render as renderConfig } from '../core/Config';

/**
 * Objects on this layer are skipped by the normal/depth prepass.
 *
 * The sky lives here. Without it the horizon is a colossal depth discontinuity
 * and the edge detector draws a hard ink line right across the skyline.
 */
export const NO_OUTLINE_LAYER = 2;

const OutlineShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    uResolution: { value: new Vector2() },
    uInkColor: { value: new Color(palette.inkBase) },
    uThickness: { value: renderConfig.outlineWidthPx },
    uNormalThreshold: { value: 0.20 },
    uDepthThreshold: { value: 0.9 },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 400 },
    uAoStrength: { value: 0.55 },
    uAoRadius: { value: 26.0 },
    uAoTint: { value: new Color(0x5a6fa8) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  /**
   * Sobel-ish edge detection over view-space normals and linear depth.
   *
   * Two signals, because neither alone is enough: depth alone misses creases
   * between coplanar-in-depth surfaces (a wall meeting a floor at the same
   * distance), and normals alone miss silhouettes against a distant background
   * where the normal happens to match.
   */
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform vec3 uInkColor;
    uniform float uThickness;
    uniform float uNormalThreshold;
    uniform float uDepthThreshold;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uAoStrength;
    uniform float uAoRadius;
    uniform vec3 uAoTint;
    varying vec2 vUv;

    float linearDepth( vec2 uv ) {
      float d = texture2D( tDepth, uv ).x;
      // Perspective depth is wildly non-linear; comparing raw values makes
      // every distant edge vanish and every near one scream.
      float viewZ = ( uCameraNear * uCameraFar ) /
                    ( ( uCameraFar - uCameraNear ) * d - uCameraFar );
      return ( viewZ + uCameraNear ) / ( uCameraNear - uCameraFar );
    }

    void main() {
      vec2 texel = uThickness / uResolution;

      vec3 n0 = texture2D( tNormal, vUv ).xyz * 2.0 - 1.0;
      vec3 n1 = texture2D( tNormal, vUv + vec2( texel.x, 0.0 ) ).xyz * 2.0 - 1.0;
      vec3 n2 = texture2D( tNormal, vUv - vec2( texel.x, 0.0 ) ).xyz * 2.0 - 1.0;
      vec3 n3 = texture2D( tNormal, vUv + vec2( 0.0, texel.y ) ).xyz * 2.0 - 1.0;
      vec3 n4 = texture2D( tNormal, vUv - vec2( 0.0, texel.y ) ).xyz * 2.0 - 1.0;

      float normalEdge = 0.0;
      normalEdge = max( normalEdge, 1.0 - dot( n0, n1 ) );
      normalEdge = max( normalEdge, 1.0 - dot( n0, n2 ) );
      normalEdge = max( normalEdge, 1.0 - dot( n0, n3 ) );
      normalEdge = max( normalEdge, 1.0 - dot( n0, n4 ) );
      normalEdge = smoothstep( uNormalThreshold, uNormalThreshold + 0.28, normalEdge );

      float d0 = linearDepth( vUv );
      float d1 = linearDepth( vUv + vec2( texel.x, 0.0 ) );
      float d2 = linearDepth( vUv - vec2( texel.x, 0.0 ) );
      float d3 = linearDepth( vUv + vec2( 0.0, texel.y ) );
      float d4 = linearDepth( vUv - vec2( 0.0, texel.y ) );

      float depthEdge = max(
        max( abs( d0 - d1 ), abs( d0 - d2 ) ),
        max( abs( d0 - d3 ), abs( d0 - d4 ) )
      );
      // Scale the threshold with distance, so a line that reads correctly up
      // close doesn't turn into a smear across the far field.
      float depthScale = 1.0 + d0 * 40.0;
      depthEdge = smoothstep( 0.0, uDepthThreshold * 0.004 * depthScale, depthEdge );

      float edge = clamp( max( normalEdge, depthEdge ), 0.0, 1.0 );

      // --- ambient occlusion ---------------------------------------------
      // Computed here rather than in its own pass: this shader already has the
      // normal and depth buffers bound, and a separate SSAO pass would mean a
      // second full-screen read of both for no additional information.
      //
      // Screen-space depth differences rather than a hemisphere kernel — for a
      // cel-shaded scene the job is contact darkening in creases, not a
      // physically plausible occlusion term, and eight taps get there.
      float ao = 0.0;
      // Scale the sampling radius with distance so occlusion stays the same
      // size in world terms rather than shrinking as objects recede.
      float aoScale = uAoRadius / ( 1.0 + d0 * 90.0 );
      // Six taps rather than eight. This pass already costs ten texture fetches
      // per pixel for edge detection; at 1080p each extra AO tap is another two
      // million fetches, and the occlusion term is soft enough that the two
      // dropped directions are not visible.
      for ( int i = 0; i < 6; i++ ) {
        float a = float( i ) * 1.0471975512;
        vec2 offset = vec2( cos( a ), sin( a ) ) * aoScale / uResolution;
        float sampleDepth = linearDepth( vUv + offset );
        // Positive when the neighbour is nearer the camera, i.e. occluding.
        float diff = d0 - sampleDepth;
        // The upper bound rejects silhouettes: a distant background behind a
        // near object is not occlusion, it's a different surface entirely.
        ao += smoothstep( 0.0, 0.0008, diff ) * ( 1.0 - smoothstep( 0.0025, 0.006, diff ) );
      }
      ao = clamp( ao / 6.0, 0.0, 1.0 ) * uAoStrength;

      vec4 color = texture2D( tDiffuse, vUv );
      // Occlusion is tinted rather than neutral: shadow in this game is
      // ambient sky light, which is blue-violet, so a grey multiply would fight
      // every other shadow on screen.
      color.rgb = mix( color.rgb, color.rgb * uAoTint * 1.5, ao );
      // Tint the ink toward the surface underneath rather than stamping black,
      // which is what keeps it reading as drawn rather than as an outline filter.
      vec3 ink = mix( uInkColor, uInkColor * 0.45 + color.rgb * 0.55, 0.22 );
      gl_FragColor = vec4( mix( color.rgb, ink, edge * 0.96 ), color.a );
    }
  `,
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new Vector2() },
    uTime: { value: 0 },
    uGrainStrength: { value: 0.075 },
    uVignette: { value: 0.42 },
    uWarmth: { value: 0.075 },
    uSaturation: { value: 1.16 },
  },
  vertexShader: OutlineShader.vertexShader,
  /**
   * Paper grain, vignette and a warm grade. Individually trivial, collectively
   * most of the difference between "3D render" and "illustration".
   */
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uGrainStrength;
    uniform float uVignette;
    uniform float uWarmth;
    uniform float uSaturation;
    varying vec2 vUv;

    float hash( vec2 p ) {
      return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
    }

    void main() {
      vec3 color = texture2D( tDiffuse, vUv ).rgb;

      // Warm the highlights and cool the shadows very slightly — a split tone,
      // the same move a colourist makes.
      float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
      color += vec3( uWarmth, uWarmth * 0.45, -uWarmth * 0.5 ) * luma;
      color += vec3( -uWarmth * 0.35, -uWarmth * 0.1, uWarmth * 0.55 ) * ( 1.0 - luma );

      color = mix( vec3( luma ), color, uSaturation );

      // Static paper tooth. Anchored to the pixel grid rather than animated:
      // moving grain reads as video noise, still grain reads as paper.
      vec2 grainUv = floor( vUv * uResolution / 1.5 );
      float grain = hash( grainUv + floor( uTime * 0.0 ) ) - 0.5;
      color += grain * uGrainStrength * ( 0.35 + 0.65 * ( 1.0 - luma ) );

      // Soft corner darkening.
      vec2 centered = vUv - 0.5;
      float vig = 1.0 - dot( centered, centered ) * uVignette * 2.4;
      color *= clamp( vig, 0.0, 1.0 );

      gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), 1.0 );
    }
  `,
};

/**
 * The non-photorealistic render pipeline.
 *
 * Order matters: outlines are applied before bloom so the ink itself doesn't
 * glow, and the grade runs last so grain and vignette sit on top of everything.
 */
export class NprPipeline {
  private composer: EffectComposer;
  private normalTarget: WebGLRenderTarget;
  private normalMaterial = new MeshNormalMaterial();
  private outlinePass: ShaderPass;
  private gradePass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private readonly resolution = new Vector2();

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
  ) {
    const size = renderer.getSize(new Vector2());
    const pixelRatio = renderer.getPixelRatio();
    const width = Math.max(1, Math.floor(size.x * pixelRatio));
    const height = Math.max(1, Math.floor(size.y * pixelRatio));

    const depthTexture = new DepthTexture(width, height, UnsignedIntType);
    depthTexture.format = DepthFormat;
    this.normalTarget = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthTexture,
    });

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(size.x, size.y);

    this.composer.addPass(new RenderPass(scene, camera));

    this.outlinePass = new ShaderPass(OutlineShader);
    this.outlinePass.uniforms.tNormal!.value = this.normalTarget.texture;
    this.outlinePass.uniforms.tDepth!.value = depthTexture;
    this.outlinePass.uniforms.uCameraNear!.value = camera.near;
    this.outlinePass.uniforms.uCameraFar!.value = camera.far;
    this.composer.addPass(this.outlinePass);

    // Gentle and wide: this is for the glow around saturated paint, not for
    // making the whole scene hazy.
    //
    // Run at half resolution. UnrealBloomPass builds a five-level mip chain,
    // so its cost scales with the resolution it starts at — and a bloom this
    // soft is indistinguishable at half res, because every tap is a blur of a
    // blur anyway.
    this.bloomPass = new UnrealBloomPass(
      new Vector2(Math.max(1, width >> 1), Math.max(1, height >> 1)),
      0.26,
      0.7,
      0.95,
    );
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

    // Applies tone mapping and the sRGB conversion. Without it the composer
    // output is linear and everything looks washed out and pale.
    this.composer.addPass(new OutputPass());

    this.setSize(size.x, size.y, pixelRatio);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const bufferWidth = Math.max(1, Math.floor(width * pixelRatio));
    const bufferHeight = Math.max(1, Math.floor(height * pixelRatio));

    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.normalTarget.setSize(bufferWidth, bufferHeight);

    this.resolution.set(bufferWidth, bufferHeight);
    this.outlinePass.uniforms.uResolution!.value.copy(this.resolution);
    this.gradePass.uniforms.uResolution!.value.copy(this.resolution);
  }

  /**
   * Enables or disables an individual pass at runtime.
   *
   * Exists for profiling: the only reliable way to attribute frame time to a
   * pass is to remove it and re-measure, and rebuilding the bundle between
   * every measurement makes that intolerable.
   */
  setPassEnabled(pass: 'outline' | 'bloom' | 'grade' | 'prepass', enabled: boolean): void {
    if (pass === 'outline') this.outlinePass.enabled = enabled;
    else if (pass === 'bloom') this.bloomPass.enabled = enabled;
    else if (pass === 'grade') this.gradePass.enabled = enabled;
    else this.prepassEnabled = enabled;
  }

  private prepassEnabled = true;

  render(elapsed: number): void {
    this.gradePass.uniforms.uTime!.value = elapsed;
    this.outlinePass.uniforms.uCameraNear!.value = this.camera.near;
    this.outlinePass.uniforms.uCameraFar!.value = this.camera.far;

    if (this.prepassEnabled) this.renderNormalPrepass();
    this.composer.render();
  }

  /**
   * Renders view-space normals and depth for the edge detector.
   *
   * Costs a second scene traversal, which also buys the depth buffer any future
   * AO or fog-of-depth work would need.
   */
  private renderNormalPrepass(): void {
    const previousOverride = this.scene.overrideMaterial;
    const previousTarget = this.renderer.getRenderTarget();

    // Skip the sky: it is infinitely far away and would put a hard ink line
    // along the entire horizon.
    this.camera.layers.disable(NO_OUTLINE_LAYER);
    this.scene.overrideMaterial = this.normalMaterial;

    this.renderer.setRenderTarget(this.normalTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(previousTarget);
    this.scene.overrideMaterial = previousOverride;
    this.camera.layers.enable(NO_OUTLINE_LAYER);
  }

  dispose(): void {
    this.normalTarget.dispose();
    this.normalMaterial.dispose();
    this.composer.dispose();
  }
}
