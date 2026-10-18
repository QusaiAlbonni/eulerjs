import * as CANNON from 'cannon-es';
import { Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import { Body, BoxCollider, MassProperties, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import {
  boxPile,
  boxPilePositions,
  boxStack,
  rockHull,
  rockPile,
  rockPilePositions,
  runSeconds,
  sphereField,
  sphereFieldPositions,
  stackPositions,
  timeStep,
} from './scenes.js';

// Both engines get the same scenes at 60 steps per second, friction 0.5 unless a test says
// otherwise, sweep-and-prune pair finding and the same sleep thresholds (0.01 m/s for 0.5 s).
// Each keeps its own solver defaults: cannon-es 10 Gauss-Seidel iterations per step, eulerjs 4
// substeps per step of its default solver, soft step (EULER_SOLVER=xpbd for XPBD's).

const TIMESTEP = 1 / 60;
const report = (line: string) => process.stdout.write(`${line}\n`);

function cannonWorld(options: { friction?: number; sleep?: boolean; tilt?: number; frictionReduction?: boolean } = {}): CANNON.World {
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

/** `sleep: 'matched'` uses eulerjs's thresholds (0.01 m/s for 0.5 s), `'default'` cannon's own (0.1 m/s for 1 s). */
type CannonSleep = false | 'matched' | 'default';

function cannonBody(world: CANNON.World, mass: number, shape: CANNON.Shape, position: Vector3, sleep: CannonSleep): CANNON.Body {
  const body = new CANNON.Body({ mass, shape, position: new CANNON.Vec3(position.x, position.y, position.z) });
  body.allowSleep = sleep !== false;
  if (sleep === 'matched') {
    body.sleepSpeedLimit = 0.01;
    body.sleepTimeLimit = 0.5;
  }
  world.addBody(body);
  return body;
}

function cannonBoxPile(sleep: CannonSleep): CANNON.World {
  const world = cannonWorld({ sleep: sleep !== false });
  for (const position of boxPilePositions(5)) cannonBody(world, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), position, sleep);
  return world;
}

function cannonSphereField(sleep: CannonSleep): CANNON.World {
  const world = cannonWorld({ sleep: sleep !== false });
  for (const position of sphereFieldPositions(20)) cannonBody(world, 1, new CANNON.Sphere(0.5), position, sleep);
  return world;
}

function cannonRockPile(): CANNON.World {
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

function runCannon(world: CANNON.World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / TIMESTEP); step++) world.step(TIMESTEP);
}

function compareSpeed(label: string, euler: World, cannon: CANNON.World, settleSeconds: number): void {
  runSeconds(euler, settleSeconds);
  runCannon(cannon, settleSeconds);
  const eulerTime = timeStep(() => euler.fixedStep()) / TIMESTEP;
  const cannonTime = timeStep(() => cannon.step(TIMESTEP)) / TIMESTEP;
  const ratio = cannonTime / eulerTime;
  report(
    `SPEED ${label.padEnd(44)} eulerjs ${eulerTime.toFixed(0).padStart(5)} ms   cannon-es ${cannonTime.toFixed(0).padStart(5)} ms   per simulated second   ` +
      (ratio >= 1 ? `eulerjs ${ratio.toFixed(1)}x faster` : `cannon-es ${(1 / ratio).toFixed(1)}x faster`),
  );
}

it('compares speed with cannon-es', () => {
  compareSpeed('125 boxes falling into a pile', boxPile(5, false), cannonBoxPile(false), 0.5);
  compareSpeed('125 boxes in a pile, never sleeping', boxPile(5, false), cannonBoxPile(false), 3);
  compareSpeed('125 boxes settled, same sleep thresholds', boxPile(5), cannonBoxPile('matched'), 6);
  compareSpeed("125 boxes settled, cannon's looser sleep", boxPile(5), cannonBoxPile('default'), 6);
  compareSpeed('400 spheres spread out, never sleeping', sphereField(20, false), cannonSphereField(false), 1);
  compareSpeed('400 spheres, same sleep thresholds', sphereField(20), cannonSphereField('matched'), 2);
  compareSpeed('64 rocks (42-corner hulls), never sleeping', rockPile(4, false), cannonRockPile(), 3);
}, 600_000);

it('compares accuracy with cannon-es', () => {
  // Stacks kept awake, so that sleep can't hold them: how far the top box wanders in 60 s, at
  // most and at the end (0 is perfect).
  for (const height of [3, 5, 8]) {
    const { world, top } = boxStack(height, undefined, false);
    let furthest = 0;
    for (let step = 0; step < 60 * 60; step++) {
      world.fixedStep();
      furthest = Math.max(furthest, Math.hypot(top.position.x, top.position.z));
    }
    const cannon = cannonWorld();
    let cannonTop: CANNON.Body | undefined;
    for (const position of stackPositions(height)) cannonTop = cannonBody(cannon, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), position, false);
    let cannonFurthest = 0;
    for (let step = 0; step < 60 * 60; step++) {
      cannon.step(1 / 60);
      cannonFurthest = Math.max(cannonFurthest, Math.hypot(cannonTop!.position.x, cannonTop!.position.z));
    }
    const millimetres = (value: number) => `${(value * 1000).toFixed(1)} mm`;
    report(
      `ACCURACY ${height}-box stack awake, top box drift in 60 s (most/end):`.padEnd(62) +
        `eulerjs ${millimetres(furthest)}/${millimetres(Math.hypot(top.position.x, top.position.z))}, cannon-es ${millimetres(cannonFurthest)}/${millimetres(Math.hypot(cannonTop!.position.x, cannonTop!.position.z))}`,
    );
  }

  // Resting contact: how far a box sinks into the ground (0 is perfect).
  {
    const euler = new World();
    euler.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    const box = euler.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: new Vector3(0, 0.5, 0), colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })], canSleep: false }));
    runSeconds(euler, 3);
    const cannon = cannonWorld();
    const cannonBox = cannonBody(cannon, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), new Vector3(0, 0.5, 0), false);
    runCannon(cannon, 3);
    report(`ACCURACY resting box sinks into the ground by:`.padEnd(62) + `eulerjs ${((0.5 - box.position.y) * 1000).toFixed(2)} mm, cannon-es ${((0.5 - cannonBox.position.y) * 1000).toFixed(2)} mm`);
  }

  // Bounce: a ball with restitution 0.5 dropped 3 m should come back to e² = 25% of that.
  {
    const euler = new World();
    euler.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    const ball = euler.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 3.5, 0), colliders: [new SphereCollider({ radius: 0.5, restitution: 0.5 })] }));
    const cannon = cannonWorld();
    const cannonBall = cannonBody(cannon, 1, new CANNON.Sphere(0.5), new Vector3(0, 3.5, 0), false);
    cannon.defaultContactMaterial.restitution = 0.5;
    const peakHeight = (heightOf: () => number, velocityOf: () => number, step: () => void) => {
      let fallen = false;
      let peak = 0;
      for (let index = 0; index < 3 / TIMESTEP; index++) {
        step();
        if (velocityOf() < -1) fallen = true;
        if (fallen && velocityOf() > 0) peak = Math.max(peak, heightOf() - 0.5);
      }
      return peak;
    };
    const eulerPeak = peakHeight(() => ball.position.y, () => ball.velocity.y, () => euler.fixedStep());
    const cannonPeak = peakHeight(() => cannonBall.position.y, () => cannonBall.velocity.y, () => cannon.step(TIMESTEP));
    report(`ACCURACY bounce height error (should reach 0.75 m):`.padEnd(62) + `eulerjs ${((eulerPeak / 0.75 - 1) * 100).toFixed(1)}%, cannon-es ${((cannonPeak / 0.75 - 1) * 100).toFixed(1)}%`);
  }

  // Sliding: on a 0.5 rad slope with friction 0.3, acceleration should be g (sin θ - μ cos θ).
  {
    const tilt = 0.5;
    const friction = 0.3;
    const expected = 9.81 * (Math.sin(tilt) - friction * Math.cos(tilt));
    const downhill = new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
    const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
    const slopeRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt);

    const euler = new World();
    euler.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction, rotation: slopeRotation })] }));
    const block = euler.addBody(
      new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: up.clone().multiplyScalar(0.5), quaternion: slopeRotation, colliders: [new BoxCollider({ size: new Vector3(1, 1, 1), friction })] }),
    );
    const cannonSlope = (frictionReduction: boolean) => {
      const world = cannonWorld({ friction, tilt, frictionReduction });
      const body = cannonBody(world, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), up.clone().multiplyScalar(0.5), false);
      body.quaternion.set(slopeRotation.x, slopeRotation.y, slopeRotation.z, slopeRotation.w);
      return { world, body };
    };

    const acceleration = (speedOf: () => number, run: (seconds: number) => void) => {
      run(0.5);
      const before = speedOf();
      run(1);
      return speedOf() - before;
    };
    const eulerAcceleration = acceleration(() => block.velocity.dot(downhill), (seconds) => runSeconds(euler, seconds));
    const cannonAcceleration = (frictionReduction: boolean) => {
      const { world, body } = cannonSlope(frictionReduction);
      return acceleration(() => new Vector3(body.velocity.x, body.velocity.y, body.velocity.z).dot(downhill), (seconds) => runCannon(world, seconds));
    };
    const percentError = (value: number) => `${((value / expected - 1) * 100).toFixed(1)}%`;
    // Sanity check of the cannon scene: with no friction it must slide at g sin θ.
    const frictionless = cannonWorld({ friction: 0, tilt });
    const frictionlessBlock = cannonBody(frictionless, 10, new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), up.clone().multiplyScalar(0.5), false);
    frictionlessBlock.quaternion.set(slopeRotation.x, slopeRotation.y, slopeRotation.z, slopeRotation.w);
    const frictionlessAcceleration = acceleration(
      () => new Vector3(frictionlessBlock.velocity.x, frictionlessBlock.velocity.y, frictionlessBlock.velocity.z).dot(downhill),
      (seconds) => runCannon(frictionless, seconds),
    );
    report(`CHECK cannon-es scene without friction slides at ${frictionlessAcceleration.toFixed(2)} m/s² (exact ${(9.81 * Math.sin(tilt)).toFixed(2)})`);
    report(
      `ACCURACY sliding acceleration error (should be ${expected.toFixed(2)} m/s²):`.padEnd(62) +
        `eulerjs ${percentError(eulerAcceleration)}, cannon-es ${percentError(cannonAcceleration(false))} (with friction reduction: ${percentError(cannonAcceleration(true))})`,
    );
  }

  // Inertia of a convex hull: cannon-es approximates it with a box around the hull.
  {
    const hull = rockHull();
    const mass = 100;
    const exact = hull.massProperties({ mass }).inertia.elements[0];
    const shape = new CANNON.ConvexPolyhedron({ vertices: hull.vertices.map((vertex) => new CANNON.Vec3(vertex.x, vertex.y, vertex.z)), faces: hull.faces.map((face) => [...face.vertexIndices]) });
    const cannonInertia = new CANNON.Vec3();
    shape.calculateLocalInertia(mass, cannonInertia);
    // a solid ball of radius 0.5 has 2/5 m r² = 10; the 42-corner hull is a little less
    report(`ACCURACY rock hull moment of inertia (a ball would be 10.0):`.padEnd(62) + `eulerjs ${exact.toFixed(2)}, cannon-es ${cannonInertia.x.toFixed(2)}`);
  }
}, 600_000);
