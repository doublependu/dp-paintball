import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshToonMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { palette } from '../core/Config';
import type { Rng } from '../core/Random';
import { getCelGradient } from '../render/CelMaterial';
import { CITY_FAR, CITY_NEAR, PARK_HALF } from './ParkLayout';

/**
 * Manhattan, seen from inside the park.
 *
 * ## Why this exists
 *
 * Central Park is not a wood. It is a rectangle of landscape with a city wall
 * standing on every side of it, and that contrast is the entire experience of
 * being in it — you are always aware of what you are not in. A park that fades
 * into fog at its boundary is a forest clearing; a park with a skyline over the
 * treeline is *this* park. It also does real work for the map: from anywhere
 * inside, the building line tells you which way you are facing, which a
 * symmetrical ring of trees never can.
 *
 * ## What it is made of
 *
 * Boxes. Buildings are one to three stacked cuboids with setbacks, instanced
 * into a single draw call, tinted per instance from a small palette of
 * pre-war limestone, brick and post-war glass. There is no collision and no
 * interior — nothing here is ever closer than 180m.
 *
 * The one shader trick is the facade: a window grid derived from world position
 * in the fragment shader, so no texture is downloaded and the grid stays the
 * same physical size on every building regardless of how the box was scaled.
 *
 * ## What it deliberately does not do
 *
 * No landmark reproduction. The skyline is *massing* — the stepped pre-war
 * towers along Central Park West, the glass slabs of midtown to the south —
 * assembled from public geometry and not modelled from any photograph.
 */

/** Storeys are ~3.4m in this stock, which sets the window grid. */
const STOREY = 3.4;

interface Building {
  /** Footprint centre. */
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Bottom and top of this box, in metres above street level. */
  bottom: number;
  top: number;
  rotationY: number;
  tint: Color;
}

/**
 * The four sides do not look alike, and getting that right is most of the
 * value: midtown to the south is glass and tall, Central Park West to the west
 * is stepped pre-war brick with twin towers, Fifth Avenue to the east is a
 * limestone wall of even cornice height, and the north is lower and plainer.
 */
interface SideProfile {
  /** Height range of the tallest box, in metres. */
  height: [number, number];
  /** Chance a building is glass rather than masonry. */
  glass: number;
  /** How often a building steps back as it rises. */
  setback: number;
  /** Street frontage of one building. */
  width: [number, number];
}

const SIDES: Record<'south' | 'west' | 'east' | 'north', SideProfile> = {
  // Midtown. The tall wall you see across Sheep Meadow — but the *front* rank
  // is Central Park South, which is mid-rise; the towers stand behind it. Rank
  // scaling supplies that, so these are the front-rank heights only.
  south: { height: [46, 80], glass: 0.45, setback: 0.5, width: [26, 48] },
  // Central Park West: the Dakota, the San Remo, the Beresford — stepped
  // masonry with crowns, fairly even, punctuated by twin-towered blocks.
  west: { height: [36, 62], glass: 0.1, setback: 0.75, width: [24, 40] },
  // Fifth Avenue: an unbroken limestone cornice line, very few towers.
  east: { height: [34, 54], glass: 0.15, setback: 0.55, width: [22, 38] },
  // Harlem side: lower, more brick, more sky above it.
  north: { height: [24, 44], glass: 0.06, setback: 0.35, width: [24, 42] },
};

/**
 * How much taller each rank is than the one in front of it, per side.
 *
 * This is the whole shape of a Manhattan view: a moderate, even wall at the
 * park edge, then something much bigger rising behind it. Building the front
 * rank tall instead — which the first pass did — gives a flat grey cliff at
 * the end of the Mall and no depth at all.
 */
const RANK_LIFT: Record<keyof typeof SIDES, [number, number, number]> = {
  south: [1, 1.9, 2.9],
  west: [1, 1.5, 1.9],
  east: [1, 1.35, 1.7],
  north: [1, 1.25, 1.5],
};

export class Cityscape {
  readonly group = new Group();

  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(rng: Rng) {
    this.buildGround();
    this.buildBuildings(rng);
  }

  /**
   * The ground the city stands on: a flat apron from the park wall out past the
   * deepest buildings, with the ring street darkened into it.
   *
   * Built as a *ring*, with the park-shaped hole left out. A full plate would
   * be simpler, but street level is below the park's perimeter shelf and above
   * the lawns at the centre, so a plate would either z-fight the terrain or lie
   * flat across the whole map like a lid.
   *
   * Not collidable. The terrain carries the physics trimesh, and there is no
   * reason to pay for collision on ground no player can reach — the park wall
   * stops them well short of it.
   */
  private buildGround(): void {
    const CELLS = 48;
    const verts = CELLS + 1;
    const positions = new Float32Array(verts * verts * 3);
    const colors = new Float32Array(verts * verts * 3);
    const indices: number[] = [];

    /** Where the apron tucks under the park's perimeter shelf. */
    const SEAM = PARK_HALF - 4;

    const asphalt = new Color(palette.asphalt);
    const pavement = new Color(0x9d9a94);
    const blockFill = new Color(0x6f6a6a);
    const colour = new Color();

    const edgeAt = (i: number) => Math.abs(-CITY_FAR + (i / CELLS) * CITY_FAR * 2);

    for (let iz = 0; iz <= CELLS; iz++) {
      for (let ix = 0; ix <= CELLS; ix++) {
        const i = iz * verts + ix;
        const x = -CITY_FAR + (ix / CELLS) * CITY_FAR * 2;
        const z = -CITY_FAR + (iz / CELLS) * CITY_FAR * 2;
        const edge = Math.max(Math.abs(x), Math.abs(z));

        positions[i * 3] = x;
        // Street level is the datum; the park sits above it on its shelf.
        //
        // Vertices inside the seam are dropped *well* below it rather than
        // just under it. The apron's cells are 18m across and the woodland
        // belt's ground rolls by several metres inside one of them, so an
        // apron tucked a few centimetres under the shelf surfaced through
        // every hollow as a grey slick of pavement lying on the forest floor.
        // Nothing can see this skirt — the park terrain covers its whole
        // footprint — so there is no cost to burying it.
        positions[i * 3 + 1] = edge < PARK_HALF ? -8 : 0;
        positions[i * 3 + 2] = z;

        // Pavement immediately outside the wall, roadway beyond it, then the
        // undifferentiated grey of city blocks.
        const inRoad = edge > PARK_HALF + 4 && edge < CITY_NEAR;
        colour.copy(edge < PARK_HALF + 4 ? pavement : inRoad ? asphalt : blockFill);
        colors[i * 3] = colour.r;
        colors[i * 3 + 1] = colour.g;
        colors[i * 3 + 2] = colour.b;
      }
    }

    for (let iz = 0; iz < CELLS; iz++) {
      for (let ix = 0; ix < CELLS; ix++) {
        // Drop any quad lying wholly inside the park.
        const outer = Math.max(
          Math.max(edgeAt(ix), edgeAt(ix + 1)),
          Math.max(edgeAt(iz), edgeAt(iz + 1)),
        );
        if (outer < SEAM) continue;
        const a = iz * verts + ix;
        indices.push(a, a + verts, a + 1, a + 1, a + verts, a + verts + 1);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new MeshToonMaterial({ gradientMap: getCelGradient(), vertexColors: true });
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    // Drawn beneath the park terrain wherever they overlap; the park shelf sits
    // above it, so there is nothing to fight over.
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this.disposables.push(geometry, material);
  }

  private buildBuildings(rng: Rng): void {
    const buildings: Building[] = [];

    const stone = new Color(palette.cityStone);
    const brick = new Color(palette.cityBrick);
    const glass = new Color(palette.cityGlass);

    // Three ranks per side. The first stands on the far kerb and reads as the
    // building line; the ones behind it only ever show above the roofs of the
    // one in front, which is what turns a row of boxes into a city.
    const ranks = [
      { distance: CITY_NEAR + 28, scale: 1.0, jitter: 10 },
      { distance: CITY_NEAR + 105, scale: 1.2, jitter: 28 },
      { distance: CITY_NEAR + 225, scale: 1.45, jitter: 62 },
    ];

    for (const [name, profile] of Object.entries(SIDES) as Array<
      [keyof typeof SIDES, SideProfile]
    >) {
      ranks.forEach((rank, rankIndex) => {
        let along = -CITY_FAR * 0.85;
        while (along < CITY_FAR * 0.85) {
          const width = rng.range(profile.width[0], profile.width[1]) * rank.scale;
          const depth = rng.range(0.7, 1.4) * width;
          const depthOut = rank.distance + rng.spread(rank.jitter);

          // Each side owns the 45-degree wedge in front of it. Without this the
          // ranks from adjacent sides interpenetrate at the corners into a
          // solid block of geometry, which is the one place a boxed skyline
          // stops looking like buildings.
          if (Math.abs(along) > depthOut) {
            along += width;
            continue;
          }

          // Place along the side, then rotate the whole footprint into place.
          const [x, z] =
            name === 'south' ? [along, depthOut]
            : name === 'north' ? [along, -depthOut]
            : name === 'east' ? [depthOut, along]
            : [-depthOut, along];

          const total =
            rng.range(profile.height[0], profile.height[1]) *
            RANK_LIFT[name][rankIndex]!;

          const isGlass = rng.bool(profile.glass);
          const tint = new Color(isGlass ? glass : rng.bool(0.55) ? stone : brick);
          // Aerial perspective: everything this far away is partly sky. Fog
          // does some of it, but fog alone leaves the near rank looking like a
          // cardboard cutout against the far one.
          // Held back from the earlier 0.5: washing the front rank halfway to
          // sky turned warm limestone and brick into the same pale grey, and
          // the fog already supplies most of the depth cue.
          tint.lerp(new Color(palette.skyHorizon), Math.min(0.34, (depthOut / CITY_FAR) ** 1.6 * 0.55));
          tint.offsetHSL(rng.spread(0.02), rng.spread(0.04), rng.spread(0.05));

          const rotationY = rng.spread(0.05);
          const steps = rng.bool(profile.setback) ? rng.int(2, 4) : 1;
          let bottom = 0;
          let w = width;
          let d = depth;
          for (let s = 0; s < steps; s++) {
            // Each setback is shorter and narrower than the one below it, which
            // is the pre-war zoning envelope in one line.
            const top = s === steps - 1 ? total : bottom + (total - bottom) * rng.range(0.4, 0.72);
            buildings.push({ x, z, width: w, depth: d, bottom, top, rotationY, tint });
            bottom = top;
            w *= rng.range(0.55, 0.78);
            d *= rng.range(0.55, 0.78);
          }

          along += width * rng.range(1.05, 1.5);
        }
      });
    }

    this.group.add(this.buildInstances(buildings));
  }

  private buildInstances(buildings: Building[]): InstancedMesh {
    // A unit box with its origin at the base, so an instance's Y scale is its
    // height and its Y position is its bottom.
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);

    const material = this.createFacadeMaterial();
    const mesh = new InstancedMesh(geometry, material, buildings.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Instanced, so per-instance culling is not available, and the ring is
    // always partly on screen anyway.
    mesh.frustumCulled = false;

    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const up = new Vector3(0, 1, 0);
    const tints = new Float32Array(buildings.length * 3);
    const sizes = new Float32Array(buildings.length * 2);

    buildings.forEach((building, i) => {
      position.set(building.x, building.bottom, building.z);
      quaternion.setFromAxisAngle(up, building.rotationY);
      scale.set(building.width, building.top - building.bottom, building.depth);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);

      tints[i * 3] = building.tint.r;
      tints[i * 3 + 1] = building.tint.g;
      tints[i * 3 + 2] = building.tint.b;
      sizes[i * 2] = building.width;
      sizes[i * 2 + 1] = building.top - building.bottom;
    });

    geometry.setAttribute('aTint', new InstancedBufferAttribute(tints, 3));
    geometry.setAttribute('aSize', new InstancedBufferAttribute(sizes, 2));
    mesh.instanceMatrix.needsUpdate = true;

    this.disposables.push(geometry, material);
    return mesh;
  }

  /**
   * Toon material with a procedural window grid.
   *
   * The grid is generated from the *local* box coordinate rather than from UVs
   * so that the storey height stays constant across buildings of wildly
   * different scales — a UV grid would give a 200m tower and a 30m brownstone
   * the same number of floors, which is the single most obvious way a boxed
   * skyline gives itself away.
   */
  private createFacadeMaterial(): MeshToonMaterial {
    const material = new MeshToonMaterial({ gradientMap: getCelGradient() });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uStorey = { value: STOREY };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aTint;
           attribute vec2 aSize;
           varying vec3 vTint;
           varying vec3 vLocal;
           varying vec2 vSize;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vTint = aTint;
           vSize = aSize;
           // Undo the instance scale, giving a position in metres on the box.
           vLocal = vec3( position.x * aSize.x, position.y * aSize.y, position.z * aSize.x );`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uStorey;
           varying vec3 vTint;
           varying vec3 vLocal;
           varying vec2 vSize;`,
        )
        .replace(
          '#include <map_fragment>',
          `vec3 facade = vTint;
           // Floor bands and window piers. Kept faint: at this distance the
           // grid should read as texture on a mass, never as drawn windows.
           float floors = fract( vLocal.y / uStorey );
           float piers = fract( ( abs( vLocal.x ) + abs( vLocal.z ) ) / 4.2 );
           float window = smoothstep( 0.25, 0.55, floors ) * smoothstep( 0.2, 0.5, piers );
           facade *= mix( 0.86, 1.06, window );
           // A parapet band at the top of each box, so setbacks have a lip.
           float parapet = smoothstep( vSize.y - 1.6, vSize.y - 0.6, vLocal.y );
           facade = mix( facade, facade * 1.12, parapet );
           diffuseColor.rgb = facade;`,
        );
    };

    material.customProgramCacheKey = () => 'cityscape-facade-v1';
    return material;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const item of this.disposables) item.dispose();
  }
}
