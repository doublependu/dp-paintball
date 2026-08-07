import {
  BackSide,
  Color,
  Mesh,
  type PerspectiveCamera,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { palette } from '../core/Config';
import { NO_OUTLINE_LAYER } from './NprPipeline';

const VERTEX = /* glsl */ `
varying vec3 vWorldDirection;

void main() {
  // Direction from the camera to this vertex, which is all a sky needs.
  vWorldDirection = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz - cameraPosition );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * Ghibli skies are not physical. They're a soft vertical wash with a few big,
 * flat-bottomed cumulus shapes and a great deal of empty blue. So this is a
 * hand-tuned gradient plus low-frequency FBM cloud masses, not a scattering
 * model — a Rayleigh sky would be more correct and look completely wrong.
 */
const FRAGMENT = /* glsl */ `
varying vec3 vWorldDirection;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uTime;
uniform float uCloudCoverage;

// Cheap value noise. Gradient noise would be smoother, but clouds this soft
// hide the difference and this is a fullscreen shader.
float hash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

float valueNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( hash( i + vec2( 0.0, 0.0 ) ), hash( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y
  );
}

float fbm( vec2 p ) {
  float total = 0.0;
  float amplitude = 0.5;
  for ( int i = 0; i < 4; i++ ) {
    total += valueNoise( p ) * amplitude;
    p *= 2.03;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  vec3 dir = normalize( vWorldDirection );

  // Vertical wash. The power curve keeps the horizon band tight so most of the
  // dome stays the deeper zenith colour.
  float height = clamp( dir.y, 0.0, 1.0 );
  vec3 sky = mix( uHorizon, uZenith, pow( height, 0.55 ) );

  // Broad warm bloom around the sun, well beyond the disc itself.
  float sunAmount = max( dot( dir, uSunDirection ), 0.0 );
  sky += uSunColor * pow( sunAmount, 6.0 ) * 0.20;
  sky += uSunColor * pow( sunAmount, 200.0 ) * 0.75;

  // Project onto a plane overhead so clouds stretch toward the horizon the way
  // a real cloud deck does, instead of wrapping the dome evenly.
  vec2 cloudUv = dir.xz / max( dir.y, 0.12 );
  cloudUv *= 0.34;
  cloudUv += uTime * 0.004;

  float clouds = fbm( cloudUv );
  // Second, slower layer for depth.
  clouds = mix( clouds, fbm( cloudUv * 0.45 - uTime * 0.002 ), 0.45 );

  // Hard-ish shoulder: painted clouds have edges, not gradients.
  float mask = smoothstep( uCloudCoverage, uCloudCoverage + 0.09, clouds );
  // Fade the deck out near the horizon so it doesn't form a hard band.
  mask *= smoothstep( 0.0, 0.22, dir.y );

  // Shade the underside by reusing the noise as a crude thickness term.
  float lit = smoothstep( uCloudCoverage + 0.02, uCloudCoverage + 0.20, clouds );
  vec3 cloudColor = mix( uCloudShade, uCloudLit, lit );
  // Warm the sunward edges.
  cloudColor += uSunColor * pow( sunAmount, 10.0 ) * 0.14 * mask;

  vec3 color = mix( sky, cloudColor, mask * 0.92 );

  gl_FragColor = vec4( color, 1.0 );
  #include <colorspace_fragment>
}
`;

/**
 * Sky dome. Rendered on the inside of a large sphere that rides with the
 * camera, so it never clips and needs no depth writes.
 */
export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(sunDirection: Vector3) {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: BackSide,
      depthWrite: false,
      // The sky is a background; it must never occlude geometry.
      depthTest: false,
      fog: false,
      uniforms: {
        uZenith: { value: new Color(palette.skyZenith) },
        uHorizon: { value: new Color(palette.skyHorizon) },
        uSunColor: { value: new Color(palette.sunWarm) },
        uSunDirection: { value: sunDirection.clone().normalize() },
        uCloudLit: { value: new Color(0xeee8dc) },
        uCloudShade: { value: new Color(0xa8bad3) },
        uCloudCoverage: { value: 0.47 },
        uTime: { value: 0 },
      },
    });

    this.mesh = new Mesh(new SphereGeometry(1, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    // Draw first, before anything can occlude it.
    this.mesh.renderOrder = -1000;
    // Excluded from the outline prepass — see NO_OUTLINE_LAYER.
    this.mesh.layers.set(NO_OUTLINE_LAYER);
  }

  /** Keeps the dome centred on the camera and advances the cloud drift. */
  update(camera: PerspectiveCamera, elapsed: number): void {
    this.mesh.position.copy(camera.position);
    // Must sit inside the far plane. Disabling depthTest exempts the dome from
    // the depth *test*, but not from frustum clipping — scaled past `far` the
    // whole sphere is clipped and the sky renders black.
    this.mesh.scale.setScalar(camera.far * 0.5);
    this.material.uniforms.uTime!.value = elapsed;
  }

  setSunDirection(direction: Vector3): void {
    (this.material.uniforms.uSunDirection!.value as Vector3)
      .copy(direction)
      .normalize();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
