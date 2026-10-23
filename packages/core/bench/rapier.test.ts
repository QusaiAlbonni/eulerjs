import RAPIER from '@dimforge/rapier3d-compat';
import RAPIER_SIMD from '@dimforge/rapier3d-simd-compat';
import type * as CANNON from 'cannon-es';
import { Quaternion, Vector3 } from 'three';
import { beforeAll, it } from 'vitest';
import type { World } from '@eulerjs/core';
import { boxPile, boxPilePositions, rockHull, rockPile, rockPilePositions, runSeconds, sphereField, sphereFieldPositions, timeStep, wallRing } from './scenes.js';
import { cannonBoxPile, cannonRockPile, cannonSphereField, cannonWallRing, runCannon } from './cannonScenes.js';

// The same scenes as against cannon-es, given to cannon-es (as cannonScenes.ts has them) and Rapier
// (WebAssembly, in its plain and its SIMD builds) in the same run, at 60 steps per second with
// friction 0.5, no restitution and no damping; eulerjs's balls are given no rolling resistance,
// which the others don't have. Each engine keeps its own
// solver defaults: Rapier 4 solver iterations a step, eulerjs 4 substeps of soft step. Rapier
// doesn't let JavaScript set its sleep thresholds (its own, measured: about 0.1 m/s and 0.2 rad/s
// for 0.5 s), so in the sleeping scenes it keeps them, and cannon-es is given eulerjs's.

const TIMESTEP = 1 / 60;
const report = (line: string) => process.stdout.write(`${line}\n`);

type Rapier = typeof RAPIER;

beforeAll(async () => {
  await RAPIER.init();
  await RAPIER_SIMD.init();
});

function rapierWorld(rapier: Rapier): InstanceType<Rapier['World']> {
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = TIMESTEP;
  // the ground: a slab whose top is at y = 0, as the eulerjs plane's
  world.createCollider(rapier.ColliderDesc.cuboid(2000, 1, 2000).setTranslation(0, -1, 0).setFriction(0.5).setRestitution(0));
  return world;
}

function addDynamic(rapier: Rapier, world: InstanceType<Rapier['World']>, collider: InstanceType<Rapier['ColliderDesc']>, position: Vector3, canSleep: boolean, velocity?: Vector3) {
  const description = rapier.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCanSleep(canSleep);
  if (velocity) description.setLinvel(velocity.x, velocity.y, velocity.z);
  const body = world.createRigidBody(description);
  world.createCollider(collider.setFriction(0.5).setRestitution(0), body);
  return body;
}

function rapierBoxPile(rapier: Rapier, canSleep: boolean) {
  const world = rapierWorld(rapier);
  // a 1 m box of 10 kg
  for (const position of boxPilePositions(5)) addDynamic(rapier, world, rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(10), position, canSleep);
  return world;
}

function rapierSphereField(rapier: Rapier, canSleep: boolean) {
  const world = rapierWorld(rapier);
  // a ball of radius 0.5 and 1 kg
  const density = 1 / ((4 / 3) * Math.PI * 0.5 ** 3);
  for (const position of sphereFieldPositions(20)) addDynamic(rapier, world, rapier.ColliderDesc.ball(0.5).setDensity(density), position, canSleep);
  return world;
}

function rapierRockPile(rapier: Rapier) {
  const world = rapierWorld(rapier);
  const points = new Float32Array(rockHull().vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]));
  for (const position of rockPilePositions(4)) addDynamic(rapier, world, rapier.ColliderDesc.convexHull(points)!.setDensity(2500), position, false);
  return world;
}

/** As `wallRing` in scenes.ts: `count` static walls round a ring, `sliding` boxes sliding round inside it. */
function rapierWallRing(rapier: Rapier, count: number, sliding: number) {
  const world = rapierWorld(rapier);
  const radius = 600;
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    const ring = radius + (index % 2) * 30;
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -angle);
    const halfLength = ((2 * Math.PI * ring) / (count / 2) + 0.2) / 2;
    world.createCollider(
      rapier.ColliderDesc.cuboid(0.6, 0.55, halfLength)
        .setTranslation(Math.cos(angle) * ring, 0.55, Math.sin(angle) * ring)
        .setRotation({ x: turn.x, y: turn.y, z: turn.z, w: turn.w })
        .setFriction(0.5),
    );
  }
  for (let index = 0; index < sliding; index++) {
    const angle = (index / sliding) * Math.PI * 2;
    const position = new Vector3(Math.cos(angle) * (radius + 15), 0.5, Math.sin(angle) * (radius + 15));
    addDynamic(rapier, world, rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(10), position, false, new Vector3(-Math.sin(angle) * 8, 0, Math.cos(angle) * 8));
  }
  return world;
}

function rapierTime(world: InstanceType<Rapier['World']>, settleSeconds: number): number {
  for (let step = 0; step < Math.round(settleSeconds / TIMESTEP); step++) world.step();
  const time = timeStep(() => world.step()) / TIMESTEP;
  world.free();
  return time;
}

function compareSpeed(label: string, euler: World, cannon: CANNON.World, rapier: (build: Rapier) => InstanceType<Rapier['World']>, settleSeconds: number): void {
  runSeconds(euler, settleSeconds);
  const eulerTime = timeStep(() => euler.fixedStep()) / TIMESTEP;
  runCannon(cannon, settleSeconds);
  const cannonTime = timeStep(() => cannon.step(TIMESTEP)) / TIMESTEP;
  const plainTime = rapierTime(rapier(RAPIER), settleSeconds);
  const simdTime = rapierTime(rapier(RAPIER_SIMD as unknown as Rapier), settleSeconds);
  report(
    `SPEED ${label.padEnd(44)} eulerjs ${eulerTime.toFixed(0).padStart(5)} ms   cannon-es ${cannonTime.toFixed(0).padStart(5)} ms   Rapier ${plainTime.toFixed(0).padStart(5)} ms   Rapier SIMD ${simdTime.toFixed(0).padStart(5)} ms   per simulated second   ` +
      `eulerjs ÷ Rapier ${(eulerTime / plainTime).toFixed(1)}×, ÷ cannon-es ${(eulerTime / cannonTime).toFixed(2)}×`,
  );
}

it('compares speed with cannon-es and Rapier', () => {
  compareSpeed('125 boxes falling into a pile', boxPile(5, false), cannonBoxPile(false), (rapier) => rapierBoxPile(rapier, false), 0.5);
  compareSpeed('125 boxes in a pile, never sleeping', boxPile(5, false), cannonBoxPile(false), (rapier) => rapierBoxPile(rapier, false), 3);
  compareSpeed('125 boxes settled', boxPile(5), cannonBoxPile('matched'), (rapier) => rapierBoxPile(rapier, true), 6);
  compareSpeed('400 spheres spread out, never sleeping', sphereField(20, false), cannonSphereField(false), (rapier) => rapierSphereField(rapier, false), 1);
  compareSpeed('400 spheres, sleeping', sphereField(20), cannonSphereField('matched'), (rapier) => rapierSphereField(rapier, true), 3);
  compareSpeed('64 rocks (42-corner hulls), never sleeping', rockPile(4, false), cannonRockPile(), (rapier) => rapierRockPile(rapier), 3);
  compareSpeed('1860 static walls, 8 boxes sliding', wallRing(1860, 8), cannonWallRing(1860, 8), (rapier) => rapierWallRing(rapier, 1860, 8), 1);
}, 900_000);
