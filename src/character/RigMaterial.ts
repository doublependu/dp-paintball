import {
  BackSide,
  Color,
  Matrix4,
  MeshBasicMaterial,
  MeshNormalMaterial,
  MeshToonMaterial,
} from 'three';
import { palette, render as renderConfig } from '../core/Config';
import { getCelGradient } from '../render/CelMaterial';
import type { SplatAtlas } from '../paint/SplatAtlas';
import type { CharacterPaint } from './CharacterPaint';
import { JOINT_COUNT } from './VoxelRig';

export interface RigMaterialHandle {
  material: MeshToonMaterial;
  /**
   * Matching material for the outline pipeline's normal/depth prepass.
   *
   * That pass cannot use `scene.overrideMaterial`: an override replaces the
   * vertex shader too, so a skinned character renders into the normal buffer in
   * bind pose — every part collapsed around the feet. The visible result is a
   * character with no outline on its body, a spurious outline around its legs,
   * and background outlines drawn straight through it, because the buffer holds
   * the scenery's depth where the body should be.
   */
  normalMaterial: MeshNormalMaterial;
  /**
   * Inverted-hull outline material.
   *
   * The screen-space edge detector gives characters a thinner, less certain
   * line than world props, because its strength depends on how much the
   * silhouette differs in depth and normal from whatever happens to be behind
   * it — a figure against distant foliage barely registers. A hull is
   * unconditional: the ink is geometry, so it reads the same against sky,
   * grass or stone. This is the Borderlands half of the look.
   */
  hullMaterial: MeshBasicMaterial;
  /**
   * Call once per frame after posing, with the rig's joint matrices. Also
   * publishes the character's live splat count, which is the fragment loop's
   * bound.
   */
  setJoints(matrices: Matrix4[]): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

/**
 * Material for a voxel character: rigid skinning plus paint compositing.
 *
 * Skinning is done in the vertex shader from a small uniform array of joint
 * matrices, indexed per vertex. Because every part is rigid there is no weight
 * blending to do — one matrix per vertex is exact, not an approximation — so
 * the whole figure animates in a single draw call.
 *
 * Paint is composited straight from `paint`'s splat list, in the joint's own
 * frame. The three interesting consequences: paint needs no storage beyond a
 * few hundred bytes, it survives any pose without reprojection because a joint
 * frame does not move relative to the limb in it, and a splat near a corner
 * wraps onto the neighbouring face on its own rather than being stamped there
 * a second time.
 */
export function createRigMaterial(
  paint: CharacterPaint,
  splatAtlas: SplatAtlas,
): RigMaterialHandle {
  const jointUniform: Matrix4[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) jointUniform.push(new Matrix4());

  const material = new MeshToonMaterial({
    gradientMap: getCelGradient(),
    vertexColors: true,
    transparent: false,
  });

  const splatCount = { value: 0 };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uJoints = { value: jointUniform };
    shader.uniforms.uRimColor = { value: [1, 0.95, 0.82] };
    shader.uniforms.uSplatAtlas = { value: splatAtlas.texture };
    shader.uniforms.uSplatTiles = { value: splatAtlas.tilesPerRow };
    // The buffers are read in place; three re-uploads an array uniform when its
    // contents change, so recording a splat needs no flag flipped here.
    shader.uniforms.uSplatA = { value: paint.bufferA };
    shader.uniforms.uSplatB = { value: paint.bufferB };
    shader.uniforms.uSplatC = { value: paint.bufferC };
    shader.uniforms.uSplatCount = splatCount;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aJoint;
         uniform mat4 uJoints[ ${JOINT_COUNT} ];
         varying vec3 vRigPos;
         varying vec3 vRigNormal;
         varying float vRigJoint;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         // Normals must follow the joint too, or lighting stays in bind pose
         // while the geometry moves.
         objectNormal = mat3( uJoints[ int( aJoint ) ] ) * objectNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // Deliberately the *un*-skinned attributes: paint is evaluated in the
         // joint's frame, which is the one frame the limb is motionless in.
         vRigPos = position;
         vRigNormal = normal;
         vRigJoint = aJoint;
         transformed = ( uJoints[ int( aJoint ) ] * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uSplatAtlas;
         uniform vec4 uSplatA[ ${paint.max} ];
         uniform vec4 uSplatB[ ${paint.max} ];
         uniform vec4 uSplatC[ ${paint.max} ];
         uniform int uSplatCount;
         uniform float uSplatTiles;
         varying vec3 vRigPos;
         varying vec3 vRigNormal;
         varying float vRigJoint;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float rigTile = 1.0 / uSplatTiles;
         for ( int i = 0; i < ${paint.max}; i++ ) {
           if ( i >= uSplatCount ) break;

           vec4 splatA = uSplatA[ i ];
           vec4 splatB = uSplatB[ i ];
           vec4 splatC = uSplatC[ i ];

           // Paint belongs to the joint it landed on. Without this the legs,
           // which are identical in joint-local space, would share every splat.
           float packed = splatC.a;
           if ( abs( mod( packed, ${JOINT_COUNT}.0 ) - vRigJoint ) > 0.5 ) continue;

           vec3 toPixel = vRigPos - splatA.xyz;
           vec3 axis = splatB.xyz;
           float radius = splatA.w;
           float along = dot( toPixel, axis );
           if ( abs( along ) > radius ) continue;

           // A face near-parallel to the projection axis would take a smeared
           // streak rather than a splat, which is the classic decal artefact.
           if ( abs( dot( vRigNormal, axis ) ) < 0.35 ) continue;

           // Wrapping onto the far side of a limb paints smaller, which is both
           // what a real splat does and what keeps a chest hit from stamping a
           // full-size copy of itself on the back.
           float taper = mix( 1.0, 0.55, clamp( abs( along ) / radius, 0.0, 1.0 ) );
           vec3 tangential = toPixel - axis * along;
           vec3 tangentX = normalize(
             abs( axis.y ) < 0.99 ? cross( vec3( 0.0, 1.0, 0.0 ), axis )
                                  : vec3( 1.0, 0.0, 0.0 ) );
           vec3 tangentY = cross( axis, tangentX );
           vec2 local = vec2( dot( tangential, tangentX ),
                              dot( tangential, tangentY ) ) / ( radius * taper );

           // Rotate about the centre so repeated hits don't read as identical.
           float rigSin = sin( splatB.w );
           float rigCos = cos( splatB.w );
           local = vec2( local.x * rigCos - local.y * rigSin,
                         local.x * rigSin + local.y * rigCos );
           if ( abs( local.x ) > 1.0 || abs( local.y ) > 1.0 ) continue;

           float variant = floor( packed / ${JOINT_COUNT}.0 );
           vec2 tileOrigin = vec2( mod( variant, uSplatTiles ),
                                   floor( variant / uSplatTiles ) ) * rigTile;
           vec4 splat = texture2D( uSplatAtlas,
                                   ( local * 0.5 + 0.5 ) * rigTile + tileOrigin );
           if ( splat.a < 0.35 ) continue;

           // Later splats paint over earlier ones, which is why the list is
           // kept in the order the hits landed.
           // splat.r rises toward the interior; darken the wet rim, as world
           // paint does.
           diffuseColor.rgb = splatC.rgb * ( 0.74 + 0.26 * splat.r );
         }`,
      );
  };

  material.customProgramCacheKey = () => `voxel-rig-v2-${paint.max}`;

  // The normal variant shares the *same* jointUniform array, so a single
  // setJoints() keeps the colour pass and the prepass in lockstep. Two separate
  // arrays would drift by a frame and shimmer the outlines.
  const normalMaterial = new MeshNormalMaterial();
  normalMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uJoints = { value: jointUniform };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aJoint;
         uniform mat4 uJoints[ ${JOINT_COUNT} ];`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         objectNormal = mat3( uJoints[ int( aJoint ) ] ) * objectNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed = ( uJoints[ int( aJoint ) ] * vec4( transformed, 1.0 ) ).xyz;`,
      );
  };
  normalMaterial.customProgramCacheKey = () => 'voxel-rig-normal-v1';

  // --- inverted hull -------------------------------------------------------
  const hullMaterial = new MeshBasicMaterial({
    color: new Color(palette.inkBase),
    // Render the shell's back faces: the front faces are hidden by the
    // character itself, leaving only a rim of ink around the silhouette.
    side: BackSide,
    fog: false,
  });
  hullMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uJoints = { value: jointUniform };
    shader.uniforms.uOutlineWidth = { value: renderConfig.characterHullPx };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aJoint;
         uniform mat4 uJoints[ ${JOINT_COUNT} ];
         uniform float uOutlineWidth;
         vec3 vHullNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         mat4 rigJoint = uJoints[ int( aJoint ) ];
         transformed = ( rigJoint * vec4( transformed, 1.0 ) ).xyz;

         // Expand along the skinned normal, in view space, scaled by view
         // depth. Scaling by depth is what keeps the line a constant width on
         // screen instead of shrinking to nothing as the character walks away.
         //
         // Uses the raw 'normal' attribute rather than 'objectNormal': that
         // variable is created by beginnormal_vertex, which MeshBasicMaterial
         // never includes, so referencing it fails to compile and the hull
         // silently does not draw at all.
         vHullNormal = normalize( mat3( rigJoint ) * normal );`,
      )
      .replace(
        '#include <project_vertex>',
        // Expand in view space and project directly, rather than displacing and
        // round-tripping through inverse(modelViewMatrix). inverse() is a
        // GLSL ES 3 built-in computed per vertex, and none of it was needed.
        `vec4 hullView = modelViewMatrix * vec4( transformed, 1.0 );
         hullView.xyz += normalize( normalMatrix * vHullNormal )
                       * uOutlineWidth * 0.0016 * max( -hullView.z, 1.0 );
         gl_Position = projectionMatrix * hullView;`,
      );
  };
  hullMaterial.customProgramCacheKey = () => 'voxel-rig-hull-v1';

  return {
    material,
    normalMaterial,
    hullMaterial,
    setJoints(matrices: Matrix4[]): void {
      for (let i = 0; i < JOINT_COUNT; i++) {
        jointUniform[i]!.copy(matrices[i]!);
      }
      // The splat buffers are shared by reference, but their length is not the
      // live count, so the loop bound has to be published separately.
      splatCount.value = paint.splatCount;
    },
    setOpacity(opacity: number): void {
      const transparent = opacity < 0.999;
      material.opacity = opacity;
      material.transparent = transparent;
      material.depthWrite = !transparent;
      // The hull has to fade with the body, or a camera pulled in tight leaves
      // a floating ink silhouette around nothing.
      hullMaterial.opacity = opacity;
      hullMaterial.transparent = transparent;
      hullMaterial.depthWrite = !transparent;
    },
    dispose(): void {
      material.dispose();
      normalMaterial.dispose();
      hullMaterial.dispose();
    },
  };
}
