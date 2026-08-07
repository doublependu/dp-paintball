import { Matrix4, MeshToonMaterial, type Texture } from 'three';
import { getCelGradient } from '../render/CelMaterial';
import { JOINT_COUNT } from './VoxelRig';

export interface RigMaterialHandle {
  material: MeshToonMaterial;
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

  return {
    material,
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
    },
    dispose(): void {
      material.dispose();
    },
  };
}
