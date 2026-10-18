import { BoxGeometry, IcosahedronGeometry, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Scene } from 'three';
import { ConvexCollider } from 'eulerjs';
import type { Body, World } from 'eulerjs';
import { Buoyancy } from '@eulerjs/marine';
import type { Ocean, WaveSurface } from '@eulerjs/marine';

/**
 * Things to sail around: rocks standing on the sea floor that nothing moves, and crates drifting
 * on the waves that the boat can shove aside. Laid out the same way every time, around the
 * boat's starting point at the origin.
 */

export interface Obstacles {
  readonly rocks: readonly Body[];
  readonly crates: readonly FloatingCrate[];
}

export interface FloatingCrate {
  readonly body: Body;
  readonly buoyancy: Buoyancy;
}

const ROCK_COUNT = 9;
/** Rocks stay out of this circle around the start, so the boat can get going. */
const CLEAR_START_RADIUS = 30;
const ROCK_FIELD_RADIUS = 130;
const CRATE_COUNT = 10;
const CRATE_FIELD = { nearest: 12, furthest: 60 };
/** Edge of the cubes buoyancy samples a crate with: a few dozen per crate is plenty. */
const CRATE_CELL_SIZE = 0.25;
/**
 * How far apart the wave surface is sampled under a crate. Sampling the waves is what floating
 * costs, and every metre floats a crate as well as the default half metre does, for half the cost.
 */
const CRATE_SURFACE_SPACING = 1;
/** Room left between a crate's starting place and a rock, beyond the rock's own size. */
const CRATE_ROCK_CLEARANCE = 4;

/** Crates, planks and pallets: size in metres and density in kg/m³ (wood is 400 to 700). */
const CRATE_KINDS = [
  { size: new Vector3(1, 1, 1), density: 450 },
  { size: new Vector3(1.4, 0.9, 1), density: 500 },
  { size: new Vector3(2.4, 0.3, 0.6), density: 600 },
  { size: new Vector3(1.6, 0.25, 1.6), density: 550 },
] as const;

const rockMaterial = new MeshStandardMaterial({ color: 0x3d3935, roughness: 0.95, flatShading: true });
const crateMaterial = new MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 });

export function createObstacles(world: World, scene: Scene, ocean: Ocean<WaveSurface>): Obstacles {
  const random = seededRandom(7);
  const rocks = createRocks(world, scene, random);
  return { rocks, crates: createCrates(world, scene, ocean, rocks, random) };
}

function createRocks(world: World, scene: Scene, random: () => number): Body[] {
  const rocks: Body[] = [];
  while (rocks.length < ROCK_COUNT) {
    const distance = CLEAR_START_RADIUS + 10 + random() * (ROCK_FIELD_RADIUS - CLEAR_START_RADIUS - 10);
    const bearing = random() * 2 * Math.PI;
    const radius = 4 + random() * 6;
    const shape = rockShape(radius, random);
    const mesh = new Mesh(shape.toGeometry(), rockMaterial);
    // standing on the bottom with about half of it out of the water
    mesh.position.set(Math.sin(bearing) * distance, -radius * 0.4, Math.cos(bearing) * distance);
    mesh.rotation.y = random() * 2 * Math.PI;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    rocks.push(world.addBody(mesh, { type: 'static', collider: shape }));
  }
  return rocks;
}

/** A lumpy convex rock about `radius` across: an icosphere with every corner pushed in or out a little. */
function rockShape(radius: number, random: () => number): ConvexCollider {
  const sphere = new IcosahedronGeometry(radius, 1);
  const positions = sphere.getAttribute('position');
  const stretch = new Vector3(1 + random() * 0.4, 0.8 + random() * 0.5, 1 + random() * 0.4);
  const points: Vector3[] = [];
  for (let index = 0; index < positions.count; index++) {
    points.push(new Vector3().fromBufferAttribute(positions, index).multiplyScalar(0.8 + random() * 0.3).multiply(stretch));
  }
  sphere.dispose();
  return new ConvexCollider({ points, friction: 0.6 });
}

function createCrates(world: World, scene: Scene, ocean: Ocean<WaveSurface>, rocks: readonly Body[], random: () => number): FloatingCrate[] {
  const crates: FloatingCrate[] = [];
  for (let index = 0; index < CRATE_COUNT; index++) {
    const kind = CRATE_KINDS[index % CRATE_KINDS.length]!;
    const mesh = new Mesh(new BoxGeometry(kind.size.x, kind.size.y, kind.size.z), crateMaterial);
    const place = clearPlaceForCrate(rocks, random);
    mesh.position.set(place.x, ocean.surfaceHeight(place.x, place.z, world.time), place.z);
    mesh.rotation.y = random() * 2 * Math.PI;
    mesh.castShadow = true;
    scene.add(mesh);
    const body = world.addBody(mesh, { density: kind.density, shape: 'voxels', cellSize: CRATE_CELL_SIZE, collider: 'box' });
    crates.push({ body, buoyancy: body.addBehavior(new Buoyancy({ ocean, surfaceSampleSpacing: CRATE_SURFACE_SPACING })) });
  }
  return crates;
}

/** A spot on the water in the crate field that no rock is near. */
function clearPlaceForCrate(rocks: readonly Body[], random: () => number): Vector3 {
  for (;;) {
    const distance = CRATE_FIELD.nearest + random() * (CRATE_FIELD.furthest - CRATE_FIELD.nearest);
    const bearing = random() * 2 * Math.PI;
    const place = new Vector3(Math.sin(bearing) * distance, 0, Math.cos(bearing) * distance);
    const clear = rocks.every((rock) => {
      const rockRadius = rock.colliders[0]!.boundingRadius;
      return Math.hypot(place.x - rock.position.x, place.z - rock.position.z) > rockRadius + CRATE_ROCK_CLEARANCE;
    });
    if (clear) return place;
  }
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
