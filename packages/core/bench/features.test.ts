import { Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import {
  Body,
  BoxCollider,
  ConeCollider,
  ConeTwistJoint,
  CylinderCollider,
  DistanceJoint,
  HeightfieldCollider,
  HingeJoint,
  MassProperties,
  SphereCollider,
  TargetJoint,
  World,
} from '@eulerjs/core';
import type { Joint } from '@eulerjs/core';
import { benchmarkBackend, boxPile, groundedWorld, runSeconds, timeStep } from './scenes.js';

// Not pass/fail: prints what the newer features cost, to compare changes. Run with `npm run bench`
// (soft step) or `npm run bench:xpbd`.

const report = (line: string) => process.stdout.write(`${line}\n`);
const perSimulatedSecond = (world: World, stepTime: number) => `${stepTime.toFixed(2)} ms per step, ${(stepTime / world.timestep).toFixed(0)} ms per simulated second`;

/** A seeded random number from -1 to 1, so every run casts the same rays. */
function randomSource(seed: number): () => number {
  let state = seed;
  return () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** Median microseconds per call of `query`, over `count` calls a batch. */
function timeQuery(count: number, query: (index: number) => unknown): number {
  return (timeStep(() => {
    for (let index = 0; index < count; index++) query(index);
  }, 7, 1) * 1000) / count;
}

it('reports scene query cost', () => {
  // a town's worth: 900 static boxes on a 30 by 30 grid, 200 balls rolling among them
  const world = groundedWorld();
  for (let row = 0; row < 30; row++) {
    for (let column = 0; column < 30; column++) {
      const size = new Vector3(2, 1 + ((row * 7 + column * 3) % 5), 2);
      world.addBody(new Body({ type: 'static', position: new Vector3(column * 5 - 75, size.y / 2, row * 5 - 75), colliders: [new BoxCollider({ size })] }));
    }
  }
  const random = randomSource(5);
  for (let index = 0; index < 200; index++) {
    world.addBody(new Body({ massProperties: MassProperties.sphere(0.4, 1), position: new Vector3(random() * 70, 8 + random() * 4, random() * 70), canSleep: false, colliders: [new SphereCollider({ radius: 0.4 })] }));
  }
  runSeconds(world, 1);
  const origins = Array.from({ length: 1000 }, () => new Vector3(random() * 75, 20, random() * 75));
  const directions = Array.from({ length: 1000 }, () => new Vector3(random(), random() * 0.1, random()).normalize());
  const down = new Vector3(0, -1, 0);
  const probe = new SphereCollider({ radius: 0.5 });
  const crate = new BoxCollider({ size: new Vector3(1, 1, 1) });
  report(`QUERIES 900 static boxes and 200 rolling balls (${world.bodies.length} bodies):`);
  report(`     ray straight down to the ground: ${timeQuery(1000, (index) => world.castRay(origins[index]!, down)).toFixed(1)} µs`);
  report(`     ray across the town, 50 m: ${timeQuery(1000, (index) => world.castRay(origins[index]!.clone().setY(1), directions[index]!, { maxDistance: 50 })).toFixed(1)} µs`);
  report(`     every hit across the town, 50 m: ${timeQuery(1000, (index) => world.castRayAll(origins[index]!.clone().setY(1), directions[index]!, { maxDistance: 50 })).toFixed(1)} µs`);
  report(`     sphere cast down: ${timeQuery(500, (index) => world.castShape(probe, origins[index]!, down)).toFixed(1)} µs`);
  report(`     box cast across, 20 m: ${timeQuery(500, (index) => world.castShape(crate, origins[index]!.clone().setY(1), directions[index]!, { maxDistance: 20 })).toFixed(1)} µs`);
  report(`     overlap of a 3 m sphere: ${timeQuery(500, (index) => world.overlap(new SphereCollider({ radius: 3 }), origins[index]!.clone().setY(1))).toFixed(1)} µs`);
}, 600_000);

/** Rolling hills, `cells` by `cells` metres. */
function hills(cells: number): HeightfieldCollider {
  const heights = Array.from({ length: cells + 1 }, (_unused, row) => Array.from({ length: cells + 1 }, (_unused2, column) => 2 * Math.sin(row / 6) * Math.cos(column / 7)));
  return new HeightfieldCollider({ heights, cellSize: 1 });
}

/** 100 balls, 50 boxes and 50 barrels dropped over the ground of `world`, never sleeping. */
function dropMixedBodies(world: World): void {
  const random = randomSource(9);
  const barrel = new CylinderCollider({ radius: 0.4, height: 1 });
  for (let index = 0; index < 200; index++) {
    const position = new Vector3(random() * 50, 5 + random() * 2, random() * 50);
    const collider = index < 100 ? new SphereCollider({ radius: 0.5 }) : index < 150 ? new BoxCollider({ size: new Vector3(1, 1, 1) }) : barrel;
    world.addBody(new Body({ massProperties: collider.massProperties({ density: 500 }), position, quaternion: new Quaternion(random(), random(), random(), 1).normalize(), canSleep: false, colliders: [collider] }));
  }
}

it('reports terrain and round shape cost', () => {
  const flat = groundedWorld();
  dropMixedBodies(flat);
  const terrain = new World({ backend: benchmarkBackend() });
  terrain.addBody(new Body({ type: 'static', colliders: [hills(128)] }));
  dropMixedBodies(terrain);
  for (const [label, world] of [
    ['on a plane', flat],
    ['on a 128 by 128 heightfield', terrain],
  ] as const) {
    runSeconds(world, 2);
    report(`TERRAIN 100 balls, 50 boxes, 50 barrels rolling ${label}: ${perSimulatedSecond(world, timeStep(() => world.fixedStep()))}`);
  }
  const boxes = boxPile(5, false);
  const barrels = roundPile(new CylinderCollider({ radius: 0.5, height: 1 }));
  const cones = roundPile(new ConeCollider({ radius: 0.5, height: 1 }));
  for (const [label, world] of [
    ['125 boxes', boxes],
    ['125 barrels (cylinders)', barrels],
    ['125 cones', cones],
  ] as const) {
    runSeconds(world, 3);
    report(`ROUND ${label} in a pile, never sleeping: ${perSimulatedSecond(world, timeStep(() => world.fixedStep()))}`);
  }
}, 600_000);

/** 125 of `collider`, staggered as in the box pile, never sleeping. */
function roundPile(collider: CylinderCollider | ConeCollider): World {
  const world = groundedWorld();
  const massProperties = collider.massProperties({ density: 500 });
  for (let layer = 0; layer < 5; layer++) {
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 5; column++) {
        world.addBody(new Body({ massProperties, position: new Vector3(column * 1.1 + (layer % 2) * 0.3, 0.6 + layer * 1.1, row * 1.1), canSleep: false, colliders: [collider] }));
      }
    }
  }
  return world;
}

/** 50 chains of 10 links hanging from a beam and swinging, joined by `link`. */
function hangingChains(link: (bodyA: Body, bodyB: Body | undefined, anchor: Vector3) => Joint): World {
  const world = new World({ backend: benchmarkBackend() });
  const size = new Vector3(0.1, 0.3, 0.1);
  for (let chain = 0; chain < 50; chain++) {
    let above: Body | undefined;
    for (let index = 0; index < 10; index++) {
      const anchor = new Vector3(chain * 0.5, -index * 0.3, 0);
      const body = world.addBody(new Body({ massProperties: MassProperties.box(size, 1), position: anchor.clone().add(new Vector3(0, -0.15, 0)), velocity: new Vector3(0, 0, 1), canSleep: false, colliders: [] }));
      world.addJoint(above ? link(body, above, anchor) : link(body, undefined, anchor));
      above = body;
    }
  }
  return world;
}

it('reports joint cost', () => {
  const offset = (body: Body, anchor: Vector3) => body.worldToLocal(anchor.clone());
  const kinds: [string, (bodyA: Body, bodyB: Body | undefined, anchor: Vector3) => Joint][] = [
    ['distance pins', (bodyA, bodyB, anchor) => new DistanceJoint({ bodyA, anchorA: offset(bodyA, anchor), bodyB, anchorB: bodyB ? offset(bodyB, anchor) : anchor, length: 0 })],
    ['hinges', (bodyA, bodyB, anchor) => new HingeJoint({ bodyA, bodyB, anchor, axis: new Vector3(1, 0, 0) })],
    ['hinges with limits', (bodyA, bodyB, anchor) => new HingeJoint({ bodyA, bodyB, anchor, axis: new Vector3(1, 0, 0), limits: { lower: -0.4, upper: 0.4 } })],
    ['cone-twist joints', (bodyA, bodyB, anchor) => new ConeTwistJoint({ bodyA, bodyB, anchor, axis: new Vector3(0, -1, 0), swingLimit: 0.5, twistLimits: { lower: -0.2, upper: 0.2 } })],
    ['hinges with friction', (bodyA, bodyB, anchor) => new HingeJoint({ bodyA, bodyB, anchor, axis: new Vector3(1, 0, 0), friction: 0.2 })],
    ['cone-twist joints with friction', (bodyA, bodyB, anchor) => new ConeTwistJoint({ bodyA, bodyB, anchor, axis: new Vector3(0, -1, 0), swingLimit: 0.5, friction: 0.2 })],
    [
      'cone-twist joints with orientation drives',
      (bodyA, bodyB, anchor) => new ConeTwistJoint({ bodyA, bodyB, anchor, axis: new Vector3(0, -1, 0), swingLimit: 0.5, orientationDrive: { target: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3), frequency: 4 } }),
    ],
  ];
  for (const [label, link] of kinds) {
    const world = hangingChains(link);
    runSeconds(world, 1);
    report(`JOINTS 50 chains of 10 links joined by ${label} (500 joints): ${perSimulatedSecond(world, timeStep(() => world.fixedStep()))}`);
  }
  const motors = new World({ gravity: new Vector3(), backend: benchmarkBackend() });
  for (let index = 0; index < 500; index++) {
    const wheel = motors.addBody(new Body({ massProperties: MassProperties.cylinder(0.3, 0.1, 2), position: new Vector3(index, 0, 0), canSleep: false, colliders: [] }));
    motors.addJoint(new HingeJoint({ bodyA: wheel, anchor: wheel.position, axis: new Vector3(0, 1, 0), motor: { targetVelocity: 5, maxForce: 1 } }));
  }
  runSeconds(motors, 0.5);
  report(`JOINTS 500 wheels on motor-driven hinges: ${perSimulatedSecond(motors, timeStep(() => motors.fixedStep()))}`);
  const carried = new World({ backend: benchmarkBackend() });
  const targets: TargetJoint[] = [];
  for (let index = 0; index < 500; index++) {
    const box = carried.addBody(new Body({ massProperties: MassProperties.box(new Vector3(0.3, 0.3, 0.3), 2), position: new Vector3(index, 1, 0), canSleep: false, colliders: [] }));
    targets.push(carried.addJoint(new TargetJoint({ body: box, frequency: 3, maxForce: 100 })));
  }
  const goal = new Vector3();
  const sway = () => targets.forEach((target, index) => target.setTarget(goal.set(index, 1 + 0.3 * Math.sin(carried.time * 2 + index), 0)));
  runSeconds(carried, 0.5);
  report(`JOINTS 500 boxes carried by target joints: ${perSimulatedSecond(carried, timeStep(() => (sway(), carried.fixedStep())))}`);
}, 600_000);

it('reports event and sensor cost', () => {
  for (const listening of [false, true]) {
    const world = boxPile(5, false);
    if (listening) {
      world.on('contactBegin', () => {});
      world.on('contactEnd', () => {});
    }
    runSeconds(world, 3);
    report(`EVENTS 125 boxes in a pile, ${listening ? 'with' : 'without'} contact listeners: ${perSimulatedSecond(world, timeStep(() => world.fixedStep()))}`);
  }
  for (const sensors of [0, 25]) {
    const world = groundedWorld();
    for (let index = 0; index < sensors; index++) {
      world.addBody(new Body({ type: 'static', position: new Vector3((index % 5) * 8, 2, Math.floor(index / 5) * 8), colliders: [new BoxCollider({ size: new Vector3(6, 4, 6), sensor: true })] }));
    }
    world.on('sensorEnter', () => {});
    world.on('sensorExit', () => {});
    const random = randomSource(3);
    for (let index = 0; index < 200; index++) {
      world.addBody(new Body({ massProperties: MassProperties.sphere(0.4, 1), position: new Vector3(16 + random() * 20, 0.4, 16 + random() * 20), velocity: new Vector3(random() * 4, 0, random() * 4), canSleep: false, colliders: [new SphereCollider({ radius: 0.4 })] }));
    }
    runSeconds(world, 1);
    report(`EVENTS 200 balls rolling among ${sensors} sensors: ${perSimulatedSecond(world, timeStep(() => world.fixedStep()))}`);
  }
}, 600_000);
