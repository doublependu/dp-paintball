import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  RingGeometry,
  ShaderMaterial,
} from 'three';
import { palette } from '../core/Config';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';

/**
 * Water for the Bethesda Fountain.
 *
 * The fountain prop is stone only — a basin, a pedestal, an upper bowl and the
 * Angel of the Waters — which left the map's centrepiece dry, and a dry
 * fountain reads as a ruin rather than as a park. This adds the three things
 * that make one look like it is running: a pool in the basin, a pool in the
 * upper bowl, and the sheet of water falling between them, with spray where it
 * lands.
 *
 * Every number here is measured off the prop's own geometry rather than guessed
 * — see the radius profile in the comments below — so the water sits inside the
 * stone instead of intersecting it.
 *
 * Four small meshes and no physics. Water you can shoot through is correct: a
 * paintball goes through a fountain jet, and a collider here would make the
 * middle of the plaza a place shots mysteriously stop.
 */

/** Basin: stone wall from r 5.5 to 6.0, floor at y 0.2. Water sits between. */
const BASIN = { inner: 1.72, outer: 5.44, y: 0.62 };
/** Upper bowl: rim at r 2.25-2.5, y 3.24-3.75. */
const BOWL = { radius: 2.16, y: 3.6 };
/** The falling sheet, from under the bowl's lip to the basin surface. */
const CURTAIN = { topRadius: 2.32, bottomRadius: 2.46, top: 3.42, bottom: 0.66 };
/** Droplets thrown up where the sheet lands. */
const SPRAY_COUNT = 128;

const WATER_VERTEX = /* glsl */ `
varying vec2 vLocal;
varying float vRadius;

uniform float uTime;

void main() {
  vLocal = position.xy;
  vRadius = length( position.xy );

  vec3 p = position;
  // The disc geometries are built in the XY plane and laid flat, so the
  // surface displacement is along local Z rather than Y.
  p.z += sin( vRadius * 5.5 - uTime * 2.1 ) * 0.012;

  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

const WATER_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying float vRadius;

uniform float uTime;
uniform float uOuter;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;

void main() {
  // Concentric rings travelling outward from the fall line. Banded rather than
  // smooth, for the same reason the lake's highlights are: painted water reads
  // by its strokes.
  float ripple = sin( vRadius * 5.5 - uTime * 2.1 );
  float band = smoothstep( 0.25, 0.9, ripple );

  vec3 color = mix( uDeep, uShallow, smoothstep( 0.0, uOuter, vRadius ) );
  color = mix( color, uFoam, band * 0.28 );

  // A brighter ring right where the sheet lands, breathing slightly so the
  // splash never sits perfectly still.
  float splash = 1.0 - smoothstep( 0.0, 0.9, abs( vRadius - ${CURTAIN.bottomRadius.toFixed(2)} ) );
  color = mix( color, uFoam, splash * ( 0.45 + 0.2 * sin( uTime * 3.1 ) ) );

  gl_FragColor = vec4( color, 0.9 );
  #include <colorspace_fragment>
}
`;

const CURTAIN_VERTEX = /* glsl */ `
varying vec2 vSheet;

void main() {
  vSheet = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const CURTAIN_FRAGMENT = /* glsl */ `
varying vec2 vSheet;

uniform float uTime;
uniform vec3 uFoam;

void main() {
  // Vertical streaks falling at speed, with a second slower set over them so
  // the sheet doesn't read as a single scrolling texture.
  float fast = sin( vSheet.x * 128.0 ) * 0.5 + 0.5;
  float fall = fract( vSheet.y + uTime * 1.6 );
  float slow = fract( vSheet.y + uTime * 0.9 + fast * 0.4 );

  // Deliberately high contrast. At a gentle ramp the sheet blends to an even
  // 30% white over the dark stone behind it, which reads as smoked glass; what
  // makes falling water look like water is that some of it is nearly opaque and
  // the gaps between are nearly clear.
  float streak = smoothstep( 0.6, 0.98, fast ) * ( 0.35 + 0.65 * fall );
  streak += smoothstep( 0.86, 1.0, fast ) * slow * 0.7;

  // Thin at the lip, heaviest halfway down, breaking up before it lands.
  float body = smoothstep( 0.0, 0.25, 1.0 - vSheet.y ) * smoothstep( 0.0, 0.35, vSheet.y );
  float alpha = clamp( streak * body, 0.0, 1.0 ) * 0.92;
  if ( alpha < 0.02 ) discard;

  gl_FragColor = vec4( uFoam, alpha );
  #include <colorspace_fragment>
}
`;

const SPRAY_VERTEX = /* glsl */ `
attribute vec3 aCorner;
attribute vec4 aSeed;

varying float vLife;
varying vec2 vQuad;

uniform float uTime;

void main() {
  // aSeed: angle, outward speed, launch phase, upward speed.
  float life = 1.15;
  float t = fract( ( uTime + aSeed.z ) / life ) * life;
  vLife = t / life;

  float c = cos( aSeed.x );
  float s = sin( aSeed.x );
  vec3 p = vec3(
    c * ( ${CURTAIN.bottomRadius.toFixed(2)} + aSeed.y * t ),
    ${BASIN.y.toFixed(2)} + aSeed.w * t - 4.4 * t * t,
    s * ( ${CURTAIN.bottomRadius.toFixed(2)} + aSeed.y * t )
  );

  // Billboarded in view space, so a droplet is always a disc facing the camera
  // rather than an edge-on sliver.
  vec4 view = modelViewMatrix * vec4( p, 1.0 );
  vQuad = aCorner.xy;
  view.xy += aCorner.xy * 0.065;
  gl_Position = projectionMatrix * view;
}
`;

const SPRAY_FRAGMENT = /* glsl */ `
varying float vLife;
varying vec2 vQuad;

uniform vec3 uFoam;

void main() {
  float d = length( vQuad );
  if ( d > 1.0 ) discard;
  // Bright at the top of the arc, gone by the time it lands.
  float alpha = ( 1.0 - smoothstep( 0.55, 1.0, d ) ) * ( 1.0 - vLife ) * 0.9;
  gl_FragColor = vec4( uFoam, alpha );
  #include <colorspace_fragment>
}
`;

export class Fountain {
  readonly group = new Group();
  private readonly materials: ShaderMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];

  constructor() {
    const foam = new Color(0xf2fbfb);

    const surface = (geometry: BufferGeometry, y: number, outer: number): void => {
      const material = new ShaderMaterial({
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uOuter: { value: outer },
          uDeep: { value: new Color(palette.waterDeep) },
          uShallow: { value: new Color(palette.waterShallow) },
          uFoam: { value: foam },
        },
      });
      const mesh = new Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
      this.add(mesh, material, geometry);
    };

    surface(new RingGeometry(BASIN.inner, BASIN.outer, 56, 4), BASIN.y, BASIN.outer);
    surface(new CircleGeometry(BOWL.radius, 40), BOWL.y, BOWL.radius);

    // The falling sheet.
    const curtainGeometry = new CylinderGeometry(
      CURTAIN.topRadius,
      CURTAIN.bottomRadius,
      CURTAIN.top - CURTAIN.bottom,
      40,
      1,
      true,
    );
    const curtainMaterial = new ShaderMaterial({
      vertexShader: CURTAIN_VERTEX,
      fragmentShader: CURTAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: { uTime: { value: 0 }, uFoam: { value: foam } },
    });
    const curtain = new Mesh(curtainGeometry, curtainMaterial);
    curtain.position.y = (CURTAIN.top + CURTAIN.bottom) / 2;
    this.add(curtain, curtainMaterial, curtainGeometry);

    this.add(...this.buildSpray(foam));
  }

  /**
   * The splash ring, as one static mesh of billboard quads whose flight is
   * computed in the vertex shader.
   *
   * Deliberately not a CPU particle system: every droplet follows the same
   * closed-form arc from the same ring, so the only per-droplet state is a
   * launch angle and a phase, and both fit in an attribute. Nothing to step,
   * nothing to allocate, and it costs one draw call whether it is on screen or
   * behind you.
   */
  private buildSpray(foam: Color): [Mesh, ShaderMaterial, BufferGeometry] {
    const positions = new Float32Array(SPRAY_COUNT * 4 * 3);
    const corners = new Float32Array(SPRAY_COUNT * 4 * 3);
    const seeds = new Float32Array(SPRAY_COUNT * 4 * 4);
    const indices = new Uint16Array(SPRAY_COUNT * 6);

    const QUAD = [
      [-1, -1], [1, -1], [1, 1], [-1, 1],
    ] as const;

    for (let d = 0; d < SPRAY_COUNT; d++) {
      // Deterministic rather than random: the ring wants even coverage, and a
      // golden-angle walk gives that without a seeded generator to thread here.
      const angle = d * 2.399963;
      const outward = 0.35 + ((d * 7919) % 100) / 100 * 0.65;
      const phase = ((d * 104_729) % 1000) / 1000 * 1.15;
      const upward = 1.5 + ((d * 15_485_863) % 100) / 100 * 1.1;

      for (let c = 0; c < 4; c++) {
        const v = d * 4 + c;
        corners[v * 3] = QUAD[c]![0];
        corners[v * 3 + 1] = QUAD[c]![1];
        seeds[v * 4] = angle;
        seeds[v * 4 + 1] = outward;
        seeds[v * 4 + 2] = phase;
        seeds[v * 4 + 3] = upward;
      }

      const base = d * 4;
      const t = d * 6;
      indices[t] = base;
      indices[t + 1] = base + 1;
      indices[t + 2] = base + 2;
      indices[t + 3] = base;
      indices[t + 4] = base + 2;
      indices[t + 5] = base + 3;
    }

    const geometry = new BufferGeometry();
    // Positions are unused — every vertex is placed by the shader — but three
    // needs the attribute to size the draw and to compute a bounding volume.
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aCorner', new BufferAttribute(corners, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.boundingSphere = null;
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.radius = 6;

    const material = new ShaderMaterial({
      vertexShader: SPRAY_VERTEX,
      fragmentShader: SPRAY_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uFoam: { value: foam } },
    });

    return [new Mesh(geometry, material), material, geometry];
  }

  private add(mesh: Mesh, material: ShaderMaterial, geometry: BufferGeometry): void {
    // Water takes no ink line — see Water, which excludes itself for the same
    // reason — and casts no shadow, because a translucent sheet that throws a
    // hard black shadow onto the plaza looks like a wall.
    mesh.layers.set(NO_OUTLINE_LAYER);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.materials.push(material);
    this.geometries.push(geometry);
  }

  update(elapsed: number): void {
    for (const material of this.materials) {
      material.uniforms.uTime!.value = elapsed;
    }
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
  }
}
