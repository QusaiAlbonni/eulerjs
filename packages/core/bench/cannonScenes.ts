import * as CANNON from 'cannon-es';
import { Quaternion, Vector3 } from 'three';
import { boxPilePositions, rockHull, rockPilePositions, sphereFieldPositions } from './scenes.js';

// The scenes of scenes.ts as cannon-es has them, for the benchmarks that put it beside eulerjs:
// friction 0.5 unless asked otherwise, no restitution, sweep-and-prune pair finding.

const TIMESTEP = 1 / 60;

export function cannonWorld(options: { friction?: number; sleep?: boolean; tilt?: number; frictionReduction?: boolean } = {}): CANNON.World {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0), allowSleep: options.sleep ?? false });
  world.broadphase = new CANNON.SAPBroadphase(world);
  // Off by default: every contact point then gets its own friction limit of mu |g| m.
  world.narrowphase.enableFrictionReduction = options.frictionReduction ?? false;
  world.defaultContactMaterial.friction = options.friction ?? 0.5;
  world.defaultContactMaterial.restitution = 0;
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  // cannon's plane faces +z; turn it to face +y, then tilt it about z like the eulerjs slope
  const facingUp = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const tilted = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), options.tilt ?? 0).multiply(facingUp);
  ground.quaternion.set(tilted.x, tilted.y, tilted.z, tilted.w);
  world.addBody(ground);
  return world;
}

/** `sleep: 'matched'` uses eulerjs's thresholds (0.05 m/s for 0.5 s), `'default'` cannon's own (0.1 m/s for 1 s). */
export type CannonSleep = false | 'matched' | 'default';

export function cannonBody(world: CANNON.World, mass: number, shape: CANNON.Shape, position: Vector3, sleep: CannonSleep): CANNON.Body {
  // no damping, as eulerjs and Rapier have none unless asked (cannon-es's own is 0.01)
  const body = new CANNON.Body({ mass, shape, position: new CANNON.Vec3(position.x, position.y, position.z), linearDamping: 0, angularDamping: 0 });
  body.allowSleep = sleep !== false;
  if (sleep === 'matched') {
    body.sleepSpeedLimit = 0.05;
    body.sleepTimeLimit = 0.5;
  }
  world.addBody(body);
  return body;
}

export function cannonBoxPile(sleep: CannonSleep): CANNON.World {
  const world = cannonWorld({ sleep: sleep !== false });
  for (const position of boxPilePositions(5)) cannonBody(world, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), position, sleep);
  return world;
}

export function cannonSphereField(sleep: CannonSleep): CANNON.World {
  const world = cannonWorld({ sleep: sleep !== false });
  for (const position of sphereFieldPositions(20)) cannonBody(world, 1, new CANNON.Sphere(0.5), position, sleep);
  return world;
}

export function cannonRockPile(): CANNON.World {
  const world = cannonWorld();
  const hull = rockHull();
  const shape = new CANNON.ConvexPolyhedron({
    vertices: hull.vertices.map((vertex) => new CANNON.Vec3(vertex.x, vertex.y, vertex.z)),
    faces: hull.faces.map((face) => [...face.vertexIndices]),
  });
  const mass = hull.massProperties({ density: 2500 }).mass;
  for (const position of rockPilePositions(4)) cannonBody(world, mass, shape, position, false);
  return world;
}

export function runCannon(world: CANNON.World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / TIMESTEP); step++) world.step(TIMESTEP);
}

/** As `wallRing` in scenes.ts: `count` static walls round a ring, `sliding` boxes sliding round inside it. */
export function cannonWallRing(count: number, sliding: number): CANNON.World {
  const world = cannonWorld();
  const radius = 600;
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    const ring = radius + (index % 2) * 30;
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -angle);
    const wall = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(0.6, 0.55, ((2 * Math.PI * ring) / (count / 2) + 0.2) / 2)), position: new CANNON.Vec3(Math.cos(angle) * ring, 0.55, Math.sin(angle) * ring) });
    wall.quaternion.set(turn.x, turn.y, turn.z, turn.w);
    world.addBody(wall);
  }
  for (let index = 0; index < sliding; index++) {
    const angle = (index / sliding) * Math.PI * 2;
    const box = cannonBody(world, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), new Vector3(Math.cos(angle) * (radius + 15), 0.5, Math.sin(angle) * (radius + 15)), false);
    box.velocity.set(-Math.sin(angle) * 8, 0, Math.cos(angle) * 8);
  }
  return world;
}
