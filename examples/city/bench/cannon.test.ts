import * as CANNON from 'cannon-es';
import { Matrix3, Quaternion, Scene, Vector3 } from 'three';
import { BoxCollider, CapsuleCollider, ConeCollider, ConvexCollider, CylinderCollider, JavaScriptBackend, PlaneCollider, SphereCollider, World } from 'eulerjs';
import type { Body, Collider, JavaScriptBackendOptions } from 'eulerjs';
import { test } from 'vitest';
import { createCity } from '../src/city/createCity.js';
import { Crowd } from '../src/people/Crowd.js';
import { placePart } from '../src/people/walkCycle.js';
import { followForce } from './followForce.js';
import type { Pedestrian } from '../src/people/Pedestrian.js';
import { RAGDOLL_JOINTS, RAGDOLL_PARTS } from '../src/people/ragdollLayout.js';
import type { PartName } from '../src/people/ragdollLayout.js';
import { advanceRoute, newPlacement, placeOnRoute, startingRoutes } from '../src/people/routes.js';
import { standingPose, walkPose } from '../src/people/walkCycle.js';

/**
 * The city with a walking crowd in eulerjs, under both its solvers, and in cannon-es: the same
 * bodies, built from the eulerjs city body for body, the same ragdolls walking the same routes.
 * eulerjs walkers are active ragdolls, their joints' drives holding the walk's pose and a target
 * joint carrying their hips; cannon-es has no joint drives, so its walkers are pulled along by a
 * force and torque on every part toward its place in the walk. No car, so nobody gets knocked
 * down; the comparison is of a city full of sleeping props and awake walkers. Both at 60 steps a
 * second with the same sleep thresholds (0.01 m/s for 0.5 s); eulerjs with its default 4
 * substeps, cannon-es with its 10 solver iterations.
 *
 * cannon-es has no capsule, so each limb there is a cylinder with a sphere on each end, and it
 * works out inertia from the bounding box. The joints are its cone-twist constraints for the spine, neck, shoulders and hips, with the same
 * limits, and its hinges for the elbows and knees, which have no limits in cannon-es; joined parts
 * collide with each other where the eulerjs ones do.
 */

const CROWD_SIZES = [0, 25, 50, 100];
const WARM_UP_SECONDS = 2;
const MEASURED_SECONDS = 20;
const TIMESTEP = 1 / 60;
const SEED = 17;

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

type Solver = JavaScriptBackendOptions['solver'];

/** The city and its crowd in eulerjs, walking, with no car. */
function eulerjsCity(crowdSize: number, solver: Solver = 'xpbd'): { world: World; crowd: Crowd } {
  const world = new World({ backend: new JavaScriptBackend({ solver }) });
  const city = createCity(world, new Scene());
  const crowd = world.use(new Crowd(world, { count: crowdSize, blocks: city.blocks, random: seededRandom(SEED) }));
  return { world, crowd };
}

const toVec3 = (vector: Vector3) => new CANNON.Vec3(vector.x, vector.y, vector.z);
const toCannonQuaternion = (quaternion: Quaternion) => new CANNON.Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
/** cannon-es planes face +z; eulerjs planes face +y. */
const planeFacingUp = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

/** Adds the cannon-es shapes for one eulerjs collider, placed relative to the body's centre of mass. */
function addShapes(target: CANNON.Body, collider: Collider, centerOfMass: Vector3): void {
  const offset = collider.offset.clone().sub(centerOfMass);
  if (collider instanceof BoxCollider) {
    target.addShape(new CANNON.Box(toVec3(collider.halfExtents)), toVec3(offset), toCannonQuaternion(collider.rotation));
  } else if (collider instanceof SphereCollider) {
    target.addShape(new CANNON.Sphere(collider.radius), toVec3(offset));
  } else if (collider instanceof PlaneCollider) {
    target.addShape(new CANNON.Plane(), toVec3(offset), toCannonQuaternion(collider.rotation.clone().multiply(planeFacingUp)));
  } else if (collider instanceof CapsuleCollider) {
    const end = new Vector3(0, collider.length / 2, 0).applyQuaternion(collider.rotation);
    target.addShape(new CANNON.Cylinder(collider.radius, collider.radius, collider.length, 12), toVec3(offset), toCannonQuaternion(collider.rotation));
    target.addShape(new CANNON.Sphere(collider.radius), toVec3(offset.clone().add(end)));
    target.addShape(new CANNON.Sphere(collider.radius), toVec3(offset.clone().sub(end)));
  } else if (collider instanceof CylinderCollider || collider instanceof ConeCollider) {
    // cannon-es's cylinders stand along y, as eulerjs's do; a cone is one with a point for a top
    const top = collider instanceof ConeCollider ? 0.01 : collider.radius;
    target.addShape(new CANNON.Cylinder(top, collider.radius, collider.height, 16), toVec3(offset), toCannonQuaternion(collider.rotation));
  } else if (collider instanceof ConvexCollider) {
    const shape = new CANNON.ConvexPolyhedron({
      vertices: collider.vertices.map((vertex) => toVec3(vertex.clone().applyQuaternion(collider.rotation))),
      faces: collider.faces.map((face) => [...face.vertexIndices]),
    });
    target.addShape(shape, toVec3(offset));
  } else {
    throw new Error(`no cannon-es shape for ${collider.shape}`);
  }
}

interface CannonCity {
  readonly world: CANNON.World;
  readonly bodies: ReadonlyMap<Body, CANNON.Body>;
  readonly joints: readonly CANNON.PointToPointConstraint[];
}

/** The eulerjs world's bodies and the crowd's joints and collision exclusions, rebuilt in cannon-es. */
function mirrorInCannon(world: World, people: readonly Pedestrian[]): CannonCity {
  const cannonWorld = new CANNON.World({ gravity: toVec3(world.gravity), allowSleep: true });
  cannonWorld.broadphase = new CANNON.SAPBroadphase(cannonWorld);
  cannonWorld.defaultContactMaterial.friction = 0.6;
  cannonWorld.defaultContactMaterial.restitution = 0;
  const bodies = new Map<Body, CANNON.Body>();
  for (const body of world.bodies) {
    const centerOfMass = body.massProperties?.centerOfMass ?? new Vector3();
    const target = new CANNON.Body({
      mass: body.type === 'dynamic' ? body.mass : 0,
      position: toVec3(body.pointToWorld(centerOfMass)),
      quaternion: toCannonQuaternion(body.quaternion),
    });
    for (const collider of body.colliders) addShapes(target, collider, centerOfMass);
    target.allowSleep = body.canSleep;
    target.sleepSpeedLimit = 0.01;
    target.sleepTimeLimit = 0.5;
    cannonWorld.addBody(target);
    bodies.set(body, target);
  }
  const joints: CANNON.PointToPointConstraint[] = [];
  for (const person of people) {
    person.joints.forEach((joint, index) => {
      // the same joints as cannon-es has them: its cone-twist joint for the ball joints, its hinge (without limits) for elbows and knees
      const settings = RAGDOLL_JOINTS[index]!.joint;
      const options = {
        pivotA: toVec3(joint.frameA.position),
        pivotB: toVec3(joint.frameB.position),
        axisA: toVec3(new Vector3(1, 0, 0).applyQuaternion(joint.frameA.quaternion)),
        axisB: toVec3(new Vector3(1, 0, 0).applyQuaternion(joint.frameB.quaternion)),
      };
      const bodyA = bodies.get(joint.bodyA)!;
      const bodyB = bodies.get(joint.bodyB!)!;
      const constraint =
        settings.kind === 'ball'
          ? new CANNON.ConeTwistConstraint(bodyA, bodyB, { ...options, angle: settings.swingLimit, twistAngle: settings.twistLimit })
          : new CANNON.HingeConstraint(bodyA, bodyB, options);
      constraint.collideConnected = joint.collideConnected;
      cannonWorld.addConstraint(constraint);
      joints.push(constraint);
    });
  }
  return { world: cannonWorld, bodies, joints };
}

const inertiaOf = new Map<PartName, Matrix3>(
  RAGDOLL_PARTS.map((layout) => [layout.name, new CapsuleCollider({ radius: layout.radius, length: layout.length }).massProperties({ mass: layout.mass }).inertia]),
);

/** Drives cannon-es ragdolls along the same routes with the same walk as the eulerjs crowd. */
function cannonCrowdDriver(city: CannonCity, people: readonly Pedestrian[], crowdSize: number, blocks: readonly Vector3[]): () => void {
  // the same random sequence the eulerjs crowd started from, so the same routes in the same order
  const routes = startingRoutes(crowdSize, blocks, seededRandom(SEED));
  const walkers = routes.map((route, index) => ({ route, parts: [...people[index]!.parts.entries()].map(([name, part]) => ({ name, body: city.bodies.get(part)! })), pose: standingPose(), placement: newPlacement() }));
  const targetPosition = new Vector3();
  const targetQuaternion = new Quaternion();
  const force = new Vector3();
  const torque = new Vector3();
  const motion = { position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), angularVelocity: new Vector3(), mass: 0, inertia: new Matrix3() };
  const gravity = new Vector3(0, -9.81, 0);
  return () => {
    for (const walker of walkers) {
      advanceRoute(walker.route, TIMESTEP);
      placeOnRoute(walker.route, walker.placement);
      walkPose(walker.route.phase, walker.pose);
      for (const { name, body } of walker.parts) {
        placePart(walker.placement, walker.pose, name, targetPosition, targetQuaternion);
        motion.position.set(body.position.x, body.position.y, body.position.z);
        motion.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
        motion.velocity.set(body.velocity.x, body.velocity.y, body.velocity.z);
        motion.angularVelocity.set(body.angularVelocity.x, body.angularVelocity.y, body.angularVelocity.z);
        Object.assign(motion, { mass: body.mass, inertia: inertiaOf.get(name)! });
        followForce(motion, targetPosition, targetQuaternion, walker.placement.velocity, gravity, force, torque);
        body.force.x += force.x;
        body.force.y += force.y;
        body.force.z += force.z;
        body.torque.x += torque.x;
        body.torque.y += torque.y;
        body.torque.z += torque.z;
      }
    }
  };
}

interface Measurement {
  msPerSecond: number;
  awake: number;
  dynamic: number;
  /** How far the walkers' pelvises strayed from walking height on average, in metres. */
  pelvisError: number;
  /** The widest any joint opened, in metres. */
  widestJoint: number;
}

function measureEulerjs(crowdSize: number, solver: Solver): Measurement {
  const { world, crowd } = eulerjsCity(crowdSize, solver);
  const steps = (seconds: number) => Math.round(seconds / TIMESTEP);
  for (let step = 0; step < steps(WARM_UP_SECONDS); step++) world.fixedStep();
  const dynamic = world.bodies.filter((body) => body.type === 'dynamic');
  let awake = 0;
  let pelvisError = 0;
  let widestJoint = 0;
  let time = 0;
  for (let step = 0; step < steps(MEASURED_SECONDS); step++) {
    const started = performance.now();
    world.fixedStep();
    time += performance.now() - started;
    awake += dynamic.filter((body) => !body.isSleeping).length;
    for (const person of crowd.people) pelvisError += Math.abs(person.parts.get('pelvis')!.position.y - 0.95) / Math.max(crowd.people.length, 1);
    if (step % 10 === 0) for (const person of crowd.people) for (const joint of person.joints) widestJoint = Math.max(widestJoint, joint.measure().linear.length());
  }
  const count = steps(MEASURED_SECONDS);
  return { msPerSecond: time / MEASURED_SECONDS, awake: awake / count, dynamic: dynamic.length, pelvisError: pelvisError / count, widestJoint };
}

function measureCannon(crowdSize: number): Measurement {
  // the eulerjs city supplies the layout; it is never stepped
  const { world, crowd } = eulerjsCity(crowdSize);
  const city = mirrorInCannon(world, crowd.people);
  const blocks = createCity(new World(), new Scene()).blocks;
  const drive = cannonCrowdDriver(city, crowd.people, crowdSize, blocks);
  const steps = (seconds: number) => Math.round(seconds / TIMESTEP);
  for (let step = 0; step < steps(WARM_UP_SECONDS); step++) {
    drive();
    city.world.step(TIMESTEP);
  }
  const dynamic = [...city.bodies.values()].filter((body) => body.mass > 0);
  const pelvises = crowd.people.map((person) => city.bodies.get(person.parts.get('pelvis')!)!);
  let awake = 0;
  let pelvisError = 0;
  let widestJoint = 0;
  let time = 0;
  for (let step = 0; step < steps(MEASURED_SECONDS); step++) {
    const started = performance.now();
    drive();
    city.world.step(TIMESTEP);
    time += performance.now() - started;
    awake += dynamic.filter((body) => body.sleepState !== CANNON.Body.SLEEPING).length;
    for (const pelvis of pelvises) pelvisError += Math.abs(pelvis.position.y - 0.95) / Math.max(pelvises.length, 1);
    if (step % 10 === 0) {
      for (const joint of city.joints) {
        const pointA = joint.bodyA.pointToWorldFrame(joint.pivotA);
        const pointB = joint.bodyB.pointToWorldFrame(joint.pivotB);
        widestJoint = Math.max(widestJoint, pointA.distanceTo(pointB));
      }
    }
  }
  const count = steps(MEASURED_SECONDS);
  return { msPerSecond: time / MEASURED_SECONDS, awake: awake / count, dynamic: dynamic.length, pelvisError: pelvisError / count, widestJoint };
}

test('the city with a walking crowd, eulerjs against cannon-es', () => {
  for (const crowdSize of CROWD_SIZES) {
    const results = { 'eulerjs xpbd': measureEulerjs(crowdSize, 'xpbd'), 'eulerjs soft-step': measureEulerjs(crowdSize, 'soft-step'), 'cannon-es': measureCannon(crowdSize) };
    process.stdout.write(`CITY VS CANNON ${crowdSize} people (${results['eulerjs xpbd'].dynamic} dynamic bodies)\n`);
    for (const [engine, result] of Object.entries(results)) {
      const walking = crowdSize > 0 ? `, walkers' pelvis off walking height by ${(result.pelvisError * 1000).toFixed(0)} mm on average, joints opened up to ${(result.widestJoint * 1000).toFixed(0)} mm` : '';
      process.stdout.write(`     ${engine.padEnd(17)} ${result.msPerSecond.toFixed(0).padStart(5)} ms per simulated second, ${result.awake.toFixed(0)} awake on average${walking}\n`);
    }
  }
});
