import {
  BackSide,
  Color,
  Matrix4,
  MeshBasicMaterial,
  MeshNormalMaterial,
  MeshToonMaterial,
  type Texture,
} from 'three';
import { palette, render as renderConfig } from '../core/Config';
import { getCelGradient } from '../render/CelMaterial';
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
  /** Call once per frame after posing, with the rig's joint matrices. */
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
 */
export function createRigMaterial(paintTexture: Texture): RigMaterialHandle {
  const jointUniform: Matrix4[] = [];
  for (let i = 0; i < JOINT_COUNT; i++) jointUniform.push(new Matrix4());

  const material = new MeshToonMaterial({
    gradientMap: getCelGradient(),
    vertexColors: true,
    transparent: false,
  });

  let uniforms: Record<string, { value: unknown }> | undefined;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uJoints = { value: jointUniform };
    shader.uniforms.uPaint = { value: paintTexture };
    shader.uniforms.uRimColor = { value: [1, 0.95, 0.82] };
    uniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aJoint;
         uniform mat4 uJoints[ ${JOINT_COUNT} ];
         varying vec2 vRigUv;`,
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
         vRigUv = uv;
         transformed = ( uJoints[ int( aJoint ) ] * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uPaint;
         varying vec2 vRigUv;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         // Paint sits on top of the base colour. Alpha is coverage: the paint
         // target is cleared to transparent black and stamped opaque.
         vec4 rigPaint = texture2D( uPaint, vRigUv );
         diffuseColor.rgb = mix( diffuseColor.rgb, rigPaint.rgb, rigPaint.a );`,
      );
  };

  material.customProgramCacheKey = () => 'voxel-rig-v1';

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
      void uniforms;
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
