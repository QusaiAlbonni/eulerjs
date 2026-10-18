import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { BufferGeometry, Material, Scene } from 'three';
import { Body, PlaneCollider } from 'eulerjs';
import type { ObjectBodyOptions, World } from 'eulerjs';

/**
 * A grid of city blocks with streets between them, all on flat ground: towers, a plaza with crates
 * stacked up, a park, street lamps on the corners, and cones and barrels out in the streets.
 * Streets run along every multiple of BLOCK_PITCH in x and z, so the car starts on one at the origin.
 */

export interface City {
  /** Centre of every block, at street level. */
  readonly blocks: readonly Vector3[];
  readonly ground: Body;
  readonly buildings: readonly Body[];
  /** Everything loose that the car can knock about. */
  readonly props: readonly Body[];
  /** Fixed street furniture: lamp posts and tree trunks. */
  readonly fixtures: readonly Body[];
}

export const BLOCK_SIZE = 36;
export const STREET_WIDTH = 14;
export const BLOCK_PITCH = BLOCK_SIZE + STREET_WIDTH;
/**
 * People walk round each block in two lanes, one each way: squares centred on the block, this
 * far out from its centre, on the pavement between the towers and the kerb.
 */
export const WALKWAY_LANES = [BLOCK_SIZE / 2 - 1.7, BLOCK_SIZE / 2 - 0.9] as const;
/** Gap between a tower and the edge of its lot, at least. */
const BUILDING_SETBACK = 2.5;
/** Lamp posts stand this far in from the kerb, outside the walkway. */
const LAMP_INSET = 0.4;
/** Blocks on each side of the origin, in each direction. */
const BLOCKS_PER_SIDE = 3;
const CITY_EXTENT = BLOCKS_PER_SIDE * BLOCK_PITCH;
const BARREL_GROUPS = 8;

const WALL_COLORS = [0xb9b2a6, 0x8f9aa3, 0xc9b79c, 0x7d8a8f, 0xa49a90, 0xd2cbc0, 0x6f7a80];
const asphalt = new MeshStandardMaterial({ color: 0x2f3236, roughness: 0.95 });
const pavement = new MeshStandardMaterial({ color: 0x8b8a86, roughness: 0.9 });
const grass = new MeshStandardMaterial({ color: 0x4f7a3a, roughness: 1 });
const roadPaint = new MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.8 });
const coneOrange = new MeshStandardMaterial({ color: 0xff6a13, roughness: 0.6 });
const barrelBlue = new MeshStandardMaterial({ color: 0x2d5c9e, roughness: 0.5, metalness: 0.2 });
const crateWood = new MeshStandardMaterial({ color: 0xa47a4a, roughness: 0.85 });
const lampMetal = new MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.5, metalness: 0.6 });
const bark = new MeshStandardMaterial({ color: 0x5a4030, roughness: 1 });
const leaves = new MeshStandardMaterial({ color: 0x3f6b2f, roughness: 1 });

export function createCity(world: World, scene: Scene): City {
  const random = seededRandom(11);
  const ground = createGround(world, scene);
  addLaneMarkings(scene);
  const buildings: Body[] = [];
  const props: Body[] = [];
  const fixtures: Body[] = [];
  const blocks: Vector3[] = [];
  const windows = windowTexture();

  for (let column = -BLOCKS_PER_SIDE; column < BLOCKS_PER_SIDE; column++) {
    for (let row = -BLOCKS_PER_SIDE; row < BLOCKS_PER_SIDE; row++) {
      const center = new Vector3((column + 0.5) * BLOCK_PITCH, 0, (row + 0.5) * BLOCK_PITCH);
      blocks.push(center);
      addStaticMesh(scene, new BoxGeometry(BLOCK_SIZE, 0.04, BLOCK_SIZE), pavement, center.clone().setY(0.02));
      if (column === 0 && row === 0) {
        props.push(...createPlaza(world, scene, center));
      } else if (column === -1 && row === 1) {
        fixtures.push(...createPark(world, scene, center, random));
      } else {
        buildings.push(...createBuildings(world, scene, center, windows, random));
      }
      fixtures.push(...createLamps(world, scene, center));
    }
  }
  props.push(...createSlalom(world, scene), ...createBarrels(world, scene, random));
  return { blocks, ground, buildings, props, fixtures };
}

function createGround(world: World, scene: Scene): Body {
  const size = 2 * CITY_EXTENT + 200;
  const road = new Mesh(new PlaneGeometry(size, size).rotateX(-Math.PI / 2), asphalt);
  road.receiveShadow = true;
  scene.add(road);
  return world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9 })] }));
}

/** Dashed centre lines down every street. */
function addLaneMarkings(scene: Scene): void {
  const dashLength = 3;
  const spacing = 8;
  const dashes: Matrix4[] = [];
  for (let line = -BLOCKS_PER_SIDE; line <= BLOCKS_PER_SIDE; line++) {
    for (let along = -CITY_EXTENT; along < CITY_EXTENT; along += spacing) {
      dashes.push(new Matrix4().makeTranslation(line * BLOCK_PITCH, 0.01, along));
      dashes.push(new Matrix4().makeRotationY(Math.PI / 2).setPosition(along, 0.01, line * BLOCK_PITCH));
    }
  }
  const markings = new InstancedMesh(new BoxGeometry(0.15, 0.01, dashLength), roadPaint, dashes.length);
  dashes.forEach((dash, index) => markings.setMatrixAt(index, dash));
  markings.receiveShadow = true;
  scene.add(markings);
}

/** One to four towers on a block, each its own static body. */
function createBuildings(world: World, scene: Scene, blockCenter: Vector3, windows: DataTexture, random: () => number): Body[] {
  const lotsPerSide = random() < 0.3 ? 1 : 2;
  const lotSize = BLOCK_SIZE / lotsPerSide;
  const buildings: Body[] = [];
  for (let lotColumn = 0; lotColumn < lotsPerSide; lotColumn++) {
    for (let lotRow = 0; lotRow < lotsPerSide; lotRow++) {
      // set back at least 2 m from the lot edge, which leaves the outer edge of the pavement free to walk on
      const width = lotSize - BUILDING_SETBACK * 2 - random() * 4;
      const depth = lotSize - BUILDING_SETBACK * 2 - random() * 4;
      const height = 8 + random() * random() * 60;
      const center = new Vector3(
        blockCenter.x + (lotColumn - (lotsPerSide - 1) / 2) * lotSize,
        height / 2,
        blockCenter.z + (lotRow - (lotsPerSide - 1) / 2) * lotSize,
      );
      const facade = windows.clone();
      facade.repeat.set(width / 4, height / 3.5);
      facade.needsUpdate = true;
      const material = new MeshStandardMaterial({ color: WALL_COLORS[Math.floor(random() * WALL_COLORS.length)]!, map: facade, roughness: 0.8 });
      const mesh = addStaticMesh(scene, new BoxGeometry(width, height, depth), material, center);
      buildings.push(world.addBody(mesh, { type: 'static', collider: 'box' }));
    }
  }
  return buildings;
}

/** An open square with two pyramids of crates to drive into. */
function createPlaza(world: World, scene: Scene, center: Vector3): Body[] {
  const crates: Body[] = [];
  const geometry = new BoxGeometry(1, 1, 1);
  for (const side of [-1, 1]) {
    for (let level = 0; level < 4; level++) {
      for (let place = 0; place < 4 - level; place++) {
        const position = new Vector3(center.x + side * 8 + (place - (3 - level) / 2) * 1.02, 0.5 + level * 1.001, center.z);
        crates.push(addLooseProp(world, scene, geometry, crateWood, position, { mass: 40, collider: 'box' }));
      }
    }
  }
  return crates;
}

/** Grass and trees: trunks are fixed, the crowns are only drawn. */
function createPark(world: World, scene: Scene, center: Vector3, random: () => number): Body[] {
  addStaticMesh(scene, new BoxGeometry(BLOCK_SIZE - 2, 0.06, BLOCK_SIZE - 2), grass, center.clone().setY(0.04));
  const trunks: Body[] = [];
  const trunkGeometry = new CylinderGeometry(0.25, 0.3, 4, 8);
  const crownGeometry = new SphereGeometry(2.2, 10, 8);
  for (let tree = 0; tree < 9; tree++) {
    const position = new Vector3(center.x + (random() - 0.5) * 28, 2, center.z + (random() - 0.5) * 28);
    const trunk = addStaticMesh(scene, trunkGeometry, bark, position);
    // the body is fitted to the trunk alone, so the crown goes on afterwards
    trunks.push(world.addBody(trunk, { type: 'static', collider: 'convex' }));
    const crown = new Mesh(crownGeometry, leaves);
    crown.position.set(0, 3.2, 0);
    crown.castShadow = true;
    trunk.add(crown);
  }
  return trunks;
}

/** A lamp post on each corner of a block. */
function createLamps(world: World, scene: Scene, blockCenter: Vector3): Body[] {
  const posts: Body[] = [];
  const postGeometry = new BoxGeometry(0.2, 6, 0.2);
  const inset = BLOCK_SIZE / 2 - LAMP_INSET;
  for (const [east, north] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const position = new Vector3(blockCenter.x + east * inset, 3, blockCenter.z + north * inset);
    const post = addStaticMesh(scene, postGeometry, lampMetal, position);
    posts.push(world.addBody(post, { type: 'static', collider: 'box' }));
  }
  return posts;
}

/** Cones to weave between, down the street ahead of where the car starts. */
function createSlalom(world: World, scene: Scene): Body[] {
  const geometry = new ConeGeometry(0.25, 0.7, 12).translate(0, 0.35, 0);
  const cones: Body[] = [];
  for (let index = 0; index < 8; index++) {
    const position = new Vector3(index % 2 === 0 ? -1.5 : 1.5, 0, 15 + index * 8);
    cones.push(addLooseProp(world, scene, geometry, coneOrange, position, { mass: 4, collider: 'cone' }));
  }
  return cones;
}

/** Groups of three barrels standing in street crossings, each crossing used once. */
function createBarrels(world: World, scene: Scene, random: () => number): Body[] {
  const geometry = new CylinderGeometry(0.3, 0.3, 0.9, 14).translate(0, 0.45, 0);
  const crossings: Vector3[] = [];
  for (let column = -BLOCKS_PER_SIDE + 1; column < BLOCKS_PER_SIDE; column++) {
    for (let row = -BLOCKS_PER_SIDE + 1; row < BLOCKS_PER_SIDE; row++) {
      // the car starts on the crossing at the origin
      if (column !== 0 || row !== 0) crossings.push(new Vector3(column * BLOCK_PITCH, 0, row * BLOCK_PITCH));
    }
  }
  const barrels: Body[] = [];
  for (let group = 0; group < BARREL_GROUPS; group++) {
    const [crossing] = crossings.splice(Math.floor(random() * crossings.length), 1);
    // off to one side of the centre lines
    const corner = crossing!.add(new Vector3(3, 0, 3));
    for (const [east, north] of [[0, 0], [0.7, 0], [0.35, 0.6]] as const) {
      barrels.push(addLooseProp(world, scene, geometry, barrelBlue, corner.clone().add(new Vector3(east, 0, north)), { mass: 30, collider: 'cylinder' }));
    }
  }
  return barrels;
}

function addStaticMesh(scene: Scene, geometry: BufferGeometry, material: Material, position: Vector3): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function addLooseProp(world: World, scene: Scene, geometry: BufferGeometry, material: Material, position: Vector3, options: ObjectBodyOptions): Body {
  return world.addBody(addStaticMesh(scene, geometry, material, position), options);
}

/** Rows of windows on a wall, one window per repeat of the texture. */
function windowTexture(): DataTexture {
  const width = 8;
  const height = 8;
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const isWindow = column >= 2 && column <= 5 && row >= 2 && row <= 6;
      const shade = isWindow ? new Color(0x2a3540) : new Color(0xffffff);
      pixels.set([shade.r * 255, shade.g * 255, shade.b * 255, 255], (row * width + column) * 4);
    }
  }
  const texture = new DataTexture(pixels, width, height);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The same sequence of numbers from 0 to 1 for the same seed (mulberry32). */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
