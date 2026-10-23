import RAPIER from '@dimforge/rapier3d-compat';
import RAPIER_SIMD from '@dimforge/rapier3d-simd-compat';
import * as CANNON from 'cannon-es';
import { Vector3 } from 'three';
import { beforeAll, it } from 'vitest';
import { Body, BoxCollider, ConeTwistJoint, CylinderCollider, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import type { Collider } from '@eulerjs/core';
import { rockHull } from './scenes.js';

/** The same random numbers every run, so that every engine gets the same scenes. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// The scenes physics engines are measured by (after Box2D's benchmarks and Jolt's), made the same
// in eulerjs, cannon-es and Rapier (WebAssembly, plain and SIMD), at 60 steps a second, sleeping
// off: a pyramid of boxes; a pile of mixed shapes; a block of 5,000 boxes smashed by one big one,
// 5,001 bodies; a storm of ray casts through still scenery; and a large grid of ball joints. Each
// engine keeps its own solver's defaults: eulerjs 4 substeps of its soft step, cannon-es 10
// Gauss-Seidel iterations, Rapier its own; none damps, and eulerjs's round shapes are given no
// rolling resistance, which the others don't have. Not pass/fail: `npm run bench` prints them.

const TIMESTEP = 1 / 60;
const report = (line: string) => process.stdout.write(`${line}\n`);
type Rapier = typeof RAPIER;

beforeAll(async () => {
  await RAPIER.init();
  await RAPIER_SIMD.init();
});

/** One engine's scene: a step, and, for the query storm, a step's queries. */
interface Running {
  step(): void;
  queries?(): void;
  free?(): void;
}

interface Scene {
  name: string;
  /** Run before timing, in seconds; then timed for `seconds`, every engine over the same steps. */
  settle: number;
  seconds: number;
  eulerjs(): Running;
  cannon(): Running;
  rapier(rapier: Rapier): Running;
}

/**
 * Milliseconds of computing per simulated second, the mean over the timed steps: all of them, for
 * every engine, since a scene such as the smash costs more at some moments than others.
 */
function measure(running: Running, scene: Scene): number {
  const work = () => {
    running.step();
    running.queries?.();
  };
  for (let step = 0; step < Math.round(scene.settle / TIMESTEP); step++) running.step();
  const steps = Math.round(scene.seconds / TIMESTEP);
  const started = performance.now();
  for (let step = 0; step < steps; step++) work();
  const perStep = (performance.now() - started) / steps;
  running.free?.();
  return perStep / TIMESTEP;
}

// the shapes, in each engine

const rock = rockHull();
const rockPoints = rock.vertices;
const rockVolume = rock.massProperties({ density: 1 }).mass;

function eulerjsWorld(gravity = -9.81, ground = true): World {
  const world = new World({ gravity: new Vector3(0, gravity, 0) });
  if (ground) world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.5 })] }));
  return world;
}

function cannonWorld(gravity = -9.81, ground = true): CANNON.World {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, gravity, 0), allowSleep: false });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.defaultContactMaterial.friction = 0.5;
  world.defaultContactMaterial.restitution = 0;
  if (ground) {
    const plane = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    plane.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(plane);
  }
  return world;
}

function rapierWorld(rapier: Rapier, gravity = -9.81, ground = true): InstanceType<Rapier['World']> {
  const world = new rapier.World({ x: 0, y: gravity, z: 0 });
  world.timestep = TIMESTEP;
  if (ground) world.createCollider(rapier.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, -1, 0).setFriction(0.5).setRestitution(0));
  return world;
}

type Shape = 'box' | 'sphere' | 'cylinder' | 'rock';

/** A shape about 1 m across of `kind`, as each engine has it, of density 1000 kg/m³. */
const shapes = {
  eulerjs(kind: Shape): Collider {
    if (kind === 'box') return new BoxCollider({ size: new Vector3(1, 1, 1), friction: 0.5 });
    // no rolling resistance, as the others have none
    if (kind === 'sphere') return new SphereCollider({ radius: 0.5, friction: 0.5, rollingResistance: 0 });
    if (kind === 'cylinder') return new CylinderCollider({ radius: 0.5, height: 1, friction: 0.5, rollingResistance: 0 });
    return rock;
  },
  cannon(kind: Shape): { shape: CANNON.Shape; mass: number } {
    if (kind === 'box') return { shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), mass: 1000 };
    if (kind === 'sphere') return { shape: new CANNON.Sphere(0.5), mass: 1000 * (4 / 3) * Math.PI * 0.125 };
    if (kind === 'cylinder') return { shape: new CANNON.Cylinder(0.5, 0.5, 1, 16), mass: 1000 * Math.PI * 0.25 };
    const shape = new CANNON.ConvexPolyhedron({ vertices: rockPoints.map((point) => new CANNON.Vec3(point.x, point.y, point.z)), faces: rock.faces.map((face) => [...face.vertexIndices]) });
    return { shape, mass: 1000 * rockVolume };
  },
  rapier(rapier: Rapier, kind: Shape): InstanceType<Rapier['ColliderDesc']> {
    const desc =
      kind === 'box'
        ? rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        : kind === 'sphere'
          ? rapier.ColliderDesc.ball(0.5)
          : kind === 'cylinder'
            ? rapier.ColliderDesc.cylinder(0.5, 0.5)
            : rapier.ColliderDesc.convexHull(new Float32Array(rockPoints.flatMap((point) => [point.x, point.y, point.z])))!;
    return desc.setDensity(1000).setFriction(0.5).setRestitution(0);
  },
};

function eulerjsDynamic(world: World, kind: Shape, position: Vector3, velocity?: Vector3, size = 1): Body {
  const collider = kind === 'box' && size !== 1 ? new BoxCollider({ size: new Vector3(size, size, size), friction: 0.5 }) : shapes.eulerjs(kind);
  return world.addBody(new Body({ position, velocity, colliders: [collider], canSleep: false }));
}

function cannonDynamic(world: CANNON.World, kind: Shape, position: Vector3, velocity?: Vector3, size = 1): CANNON.Body {
  const { shape, mass } = kind === 'box' && size !== 1 ? { shape: new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2)), mass: 1000 * size ** 3 } : shapes.cannon(kind);
  const body = new CANNON.Body({ mass, shape, position: new CANNON.Vec3(position.x, position.y, position.z), linearDamping: 0, angularDamping: 0 });
  if (velocity) body.velocity.set(velocity.x, velocity.y, velocity.z);
  body.allowSleep = false;
  world.addBody(body);
  return body;
}

function rapierDynamic(rapier: Rapier, world: InstanceType<Rapier['World']>, kind: Shape, position: Vector3, velocity?: Vector3, size = 1): InstanceType<Rapier['RigidBody']> {
  const description = rapier.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCanSleep(false);
  if (velocity) description.setLinvel(velocity.x, velocity.y, velocity.z);
  const body = world.createRigidBody(description);
  const collider = kind === 'box' && size !== 1 ? rapier.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setDensity(1000).setFriction(0.5).setRestitution(0) : shapes.rapier(rapier, kind);
  world.createCollider(collider, body);
  return body;
}

// the scenes

/** A square pyramid of 1 m boxes, `base` along each side at the bottom: 1,015 boxes for 14. */
function pyramidPositions(base: number): Vector3[] {
  const positions: Vector3[] = [];
  for (let level = 0; level < base; level++) {
    const side = base - level;
    for (let row = 0; row < side; row++) for (let column = 0; column < side; column++) positions.push(new Vector3(column - side / 2 + 0.5, 0.5 + level, row - side / 2 + 0.5));
  }
  return positions;
}

const pyramid: Scene = (() => {
  const positions = pyramidPositions(14);
  return {
    name: `pyramid of ${positions.length} boxes, standing`,
    settle: 1,
    seconds: 2,
    eulerjs() {
      const world = eulerjsWorld();
      for (const position of positions) eulerjsDynamic(world, 'box', position);
      return { step: () => world.fixedStep() };
    },
    cannon() {
      const world = cannonWorld();
      for (const position of positions) cannonDynamic(world, 'box', position);
      return { step: () => world.step(TIMESTEP) };
    },
    rapier(rapier) {
      const world = rapierWorld(rapier);
      for (const position of positions) rapierDynamic(rapier, world, 'box', position);
      return { step: () => world.step(), free: () => world.free() };
    },
  };
})();

/** 400 bodies, a hundred each of boxes, balls, cylinders and rocks, in columns, dropped onto the ground. */
const mixedPile: Scene = (() => {
  const kinds: Shape[] = ['box', 'sphere', 'cylinder', 'rock'];
  const random = seeded(3);
  // ten by ten a layer, four layers, the shapes in turn, a little off true so that they tumble
  const bodies = Array.from({ length: 400 }, (_unused, index) => ({
    kind: kinds[index % 4]!,
    position: new Vector3((index % 10) * 1.3 - 6 + random() * 0.2, 1 + Math.floor(index / 100) * 1.4, (Math.floor(index / 10) % 10) * 1.3 - 6 + random() * 0.2),
  }));
  return {
    name: 'mixed-shape pile: 400 boxes, balls, cylinders and rocks',
    settle: 1.5,
    seconds: 3,
    eulerjs() {
      const world = eulerjsWorld();
      for (const { kind, position } of bodies) eulerjsDynamic(world, kind, position);
      return { step: () => world.fixedStep() };
    },
    cannon() {
      const world = cannonWorld();
      for (const { kind, position } of bodies) cannonDynamic(world, kind, position);
      return { step: () => world.step(TIMESTEP) };
    },
    rapier(rapier) {
      const world = rapierWorld(rapier);
      for (const { kind, position } of bodies) rapierDynamic(rapier, world, kind, position);
      return { step: () => world.step(), free: () => world.free() };
    },
  };
})();

/** 5,000 half-metre boxes floating in a block, no gravity, and a 4 m box flying into it at 40 m/s: 5,001 bodies. */
const smash: Scene = (() => {
  const positions: Vector3[] = [];
  for (let across = 0; across < 20; across++) for (let up = 0; up < 10; up++) for (let along = 0; along < 25; along++) positions.push(new Vector3(across * 0.55, up * 0.55, along * 0.55 - 6.6));
  const hammer = { position: new Vector3(-6, 2.5, 0), velocity: new Vector3(40, 0, 0) };
  const small = (world: { add: (position: Vector3) => void }) => positions.forEach((position) => world.add(position));
  return {
    name: 'smash: a 4 m box through 5,000 floating boxes',
    settle: 0,
    seconds: 1.5,
    eulerjs() {
      const world = eulerjsWorld(0, false);
      small({ add: (position) => world.addBody(new Body({ position, colliders: [new BoxCollider({ size: new Vector3(0.5, 0.5, 0.5), friction: 0.5 })], canSleep: false })) });
      eulerjsDynamic(world, 'box', hammer.position, hammer.velocity, 4);
      return { step: () => world.fixedStep() };
    },
    cannon() {
      const world = cannonWorld(0, false);
      small({
        add: (position) => {
          const body = new CANNON.Body({ mass: 125, shape: new CANNON.Box(new CANNON.Vec3(0.25, 0.25, 0.25)), position: new CANNON.Vec3(position.x, position.y, position.z), linearDamping: 0, angularDamping: 0 });
          body.allowSleep = false;
          world.addBody(body);
        },
      });
      cannonDynamic(world, 'box', hammer.position, hammer.velocity, 4);
      return { step: () => world.step(TIMESTEP) };
    },
    rapier(rapier) {
      const world = rapierWorld(rapier, 0, false);
      small({
        add: (position) => {
          const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCanSleep(false));
          world.createCollider(rapier.ColliderDesc.cuboid(0.25, 0.25, 0.25).setDensity(1000).setFriction(0.5).setRestitution(0), body);
        },
      });
      rapierDynamic(rapier, world, 'box', hammer.position, hammer.velocity, 4);
      return { step: () => world.step(), free: () => world.free() };
    },
  };
})();

/** How many of the storm's rays each engine's casts hit, to see that they all cast the same. */
const stormHits = { eulerjs: 0, cannon: 0, rapier: 0 };

/** 2,000 still boxes and balls through a 100 m cube, and 5,000 rays a step across it, each to its first hit. */
const queryStorm: Scene = (() => {
  const random = seeded(9);
  const scenery = Array.from({ length: 2000 }, (_unused, index) => ({ kind: (index % 2 === 0 ? 'box' : 'sphere') as Shape, position: new Vector3(random() * 100 - 50, random() * 100 - 50, random() * 100 - 50) }));
  const rays = Array.from({ length: 5000 }, () => {
    const origin = new Vector3(random() * 100 - 50, random() * 100 - 50, -55);
    const direction = new Vector3(random() - 0.5, random() - 0.5, 1).normalize();
    return { origin, direction, to: origin.clone().addScaledVector(direction, 120) };
  });
  return {
    name: 'query storm: 5,000 rays a step through 2,000 still shapes',
    settle: 0.1,
    seconds: 0.5,
    eulerjs() {
      const world = eulerjsWorld(-9.81, false);
      for (const { kind, position } of scenery) world.addBody(new Body({ type: 'static', position, colliders: [shapes.eulerjs(kind)] }));
      return {
        step: () => world.fixedStep(),
        queries: () => {
          let hits = 0;
          for (const { origin, direction } of rays) if (world.castRay(origin, direction, { maxDistance: 120 })) hits++;
          stormHits.eulerjs = hits;
        },
      };
    },
    cannon() {
      const world = cannonWorld(-9.81, false);
      for (const { kind, position } of scenery) world.addBody(new CANNON.Body({ mass: 0, shape: shapes.cannon(kind).shape, position: new CANNON.Vec3(position.x, position.y, position.z) }));
      const result = new CANNON.RaycastResult();
      const from = new CANNON.Vec3();
      const to = new CANNON.Vec3();
      return {
        step: () => world.step(TIMESTEP),
        queries: () => {
          let hits = 0;
          for (const ray of rays) {
            from.set(ray.origin.x, ray.origin.y, ray.origin.z);
            to.set(ray.to.x, ray.to.y, ray.to.z);
            result.reset();
            if (world.raycastClosest(from, to, {}, result)) hits++;
          }
          stormHits.cannon = hits;
        },
      };
    },
    rapier(rapier) {
      const world = rapierWorld(rapier, -9.81, false);
      for (const { kind, position } of scenery) world.createCollider(shapes.rapier(rapier, kind).setTranslation(position.x, position.y, position.z));
      const casts = rays.map(({ origin, direction }) => new rapier.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: direction.x, y: direction.y, z: direction.z }));
      return {
        step: () => world.step(),
        queries: () => {
          let hits = 0;
          for (const ray of casts) if (world.castRay(ray, 120, true)) hits++;
          stormHits.rapier = hits;
        },
        free: () => world.free(),
      };
    },
  };
})();

/** A 40 × 40 net of balls a metre apart, each joined to its neighbours by a ball joint, hanging from one edge. */
const jointGrid: Scene = (() => {
  const size = 40;
  const at = (row: number, column: number) => new Vector3(column - size / 2, 50, row);
  const links: [number, number, number, number][] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (column + 1 < size) links.push([row, column, row, column + 1]);
      if (row + 1 < size) links.push([row, column, row + 1, column]);
    }
  }
  return {
    name: `joint grid: ${size * size} balls, ${links.length} ball joints, hanging`,
    settle: 0.5,
    seconds: 2,
    eulerjs() {
      const world = eulerjsWorld(-9.81, false);
      const bodies = Array.from({ length: size }, (_unused, row) =>
        Array.from({ length: size }, (_ignored, column) => world.addBody(new Body({ type: row === 0 ? 'static' : 'dynamic', position: at(row, column), colliders: [new SphereCollider({ radius: 0.25 })], canSleep: false }))),
      );
      for (const [row, column, otherRow, otherColumn] of links) {
        const bodyA = bodies[row]![column]!;
        const bodyB = bodies[otherRow]![otherColumn]!;
        world.addJoint(new ConeTwistJoint({ bodyA, bodyB, anchor: bodyA.position.clone().add(bodyB.position).multiplyScalar(0.5) }));
      }
      return { step: () => world.fixedStep() };
    },
    cannon() {
      const world = cannonWorld(-9.81, false);
      const bodies = Array.from({ length: size }, (_unused, row) =>
        Array.from({ length: size }, (_ignored, column) => {
          const position = at(row, column);
          const body = new CANNON.Body({ mass: row === 0 ? 0 : 1000 * (4 / 3) * Math.PI * 0.25 ** 3, shape: new CANNON.Sphere(0.25), position: new CANNON.Vec3(position.x, position.y, position.z), linearDamping: 0, angularDamping: 0 });
          body.allowSleep = false;
          world.addBody(body);
          return body;
        }),
      );
      for (const [row, column, otherRow, otherColumn] of links) {
        const bodyA = bodies[row]![column]!;
        const bodyB = bodies[otherRow]![otherColumn]!;
        const half = new CANNON.Vec3((bodyB.position.x - bodyA.position.x) / 2, (bodyB.position.y - bodyA.position.y) / 2, (bodyB.position.z - bodyA.position.z) / 2);
        world.addConstraint(new CANNON.PointToPointConstraint(bodyA, half, bodyB, half.negate()));
      }
      return { step: () => world.step(TIMESTEP) };
    },
    rapier(rapier) {
      const world = rapierWorld(rapier, -9.81, false);
      const bodies = Array.from({ length: size }, (_unused, row) =>
        Array.from({ length: size }, (_ignored, column) => {
          const position = at(row, column);
          const body = world.createRigidBody((row === 0 ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic().setCanSleep(false)).setTranslation(position.x, position.y, position.z));
          world.createCollider(rapier.ColliderDesc.ball(0.25).setDensity(1000), body);
          return body;
        }),
      );
      for (const [row, column, otherRow, otherColumn] of links) {
        const bodyA = bodies[row]![column]!;
        const bodyB = bodies[otherRow]![otherColumn]!;
        const from = bodyA.translation();
        const to = bodyB.translation();
        const half = { x: (to.x - from.x) / 2, y: (to.y - from.y) / 2, z: (to.z - from.z) / 2 };
        world.createImpulseJoint(rapier.JointData.spherical(half, { x: -half.x, y: -half.y, z: -half.z }), bodyA, bodyB, true);
      }
      return { step: () => world.step(), free: () => world.free() };
    },
  };
})();

it('compares the standard scenes with cannon-es and Rapier', () => {
  report(`${'STANDARD'.padEnd(64)} ${'eulerjs'.padStart(9)} ${'cannon-es'.padStart(10)} ${'Rapier'.padStart(9)} ${'SIMD'.padStart(9)}   ms per simulated second; eulerjs ÷ Rapier, ÷ cannon-es`);
  for (const scene of [pyramid, mixedPile, smash, queryStorm, jointGrid]) {
    const eulerjs = measure(scene.eulerjs(), scene);
    const cannon = measure(scene.cannon(), scene);
    const plain = measure(scene.rapier(RAPIER), scene);
    const simd = measure(scene.rapier(RAPIER_SIMD as unknown as Rapier), scene);
    if (scene === queryStorm) report(`STANDARD   rays hit: eulerjs ${stormHits.eulerjs}, cannon-es ${stormHits.cannon}, Rapier ${stormHits.rapier} of 5000`);
    report(`STANDARD ${scene.name.padEnd(55)} ${eulerjs.toFixed(0).padStart(9)} ${cannon.toFixed(0).padStart(10)} ${plain.toFixed(0).padStart(9)} ${simd.toFixed(0).padStart(9)}   ${(eulerjs / plain).toFixed(1)}× Rapier, ${(eulerjs / cannon).toFixed(2)}× cannon-es`);
  }
}, 900_000);
