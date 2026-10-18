import type { Quaternion, Vector3 } from 'three';
import type { Body } from './Body.js';
import type { Collider } from './colliders/Collider.js';
import type { Joint } from './joints/Joint.js';
import type { OverlapHit, QueryFilter, QueryHit } from './queries.js';
import type { BodyMotion } from './RigidBodyState.js';

/** A contact that pushed two bodies apart during the last step, for reading after it. */
export interface Contact {
  readonly bodyA: Body;
  readonly bodyB: Body;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
  /** Where the bodies touch, in world space. */
  readonly point: Vector3;
  /** Unit vector from B toward A. */
  readonly normal: Vector3;
  /** How far the colliders overlapped when the contact was found, in metres (negative for a gap). */
  readonly depth: number;
  /** Impulse along the normal over the whole step, in N·s; divide by the timestep for the average force. */
  readonly normalImpulse: number;
}

/** Two colliders overlapping during the last step, at least one of them a sensor. */
export interface SensorOverlap {
  readonly bodyA: Body;
  readonly bodyB: Body;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
}

/** The world's settings a backend steps with. The world passes itself; they can change between steps. */
export interface StepSettings {
  readonly gravity: Vector3;
  /** Length of the step in seconds. */
  readonly timestep: number;
  /** The backend's accuracy setting: how many smaller steps it splits a step into, or its nearest equivalent. */
  readonly substeps: number;
  /** Bodies slower than this (m/s) and `sleepSpin` (rad/s) for `timeToSleep` seconds fall asleep. */
  readonly sleepSpeed: number;
  readonly sleepSpin: number;
  readonly timeToSleep: number;
}

/**
 * What actually simulates a world. The world, its bodies and joints are the same whatever the
 * backend; the backend keeps its own copy of each body and the world keeps the two in step:
 *
 * 1. before a step, it writes the poses and velocities you changed, wake and sleep requests,
 *    and the forces gathered during the step;
 * 2. `step` simulates;
 * 3. it reads every body's motion and sleep state back.
 *
 * Backends read a body's settings (type, damping, gravity scale, `canSleep`, collider
 * materials) and a joint's settings from the objects themselves, so changes to those take
 * effect on the next step. Bodies a joint ties together don't collide with each other while it
 * is in the world if its `collideConnected` is false. `updateBody` is called when its mass properties or colliders change.
 */
export interface PhysicsBackend {
  readonly name: string;
  addBody(body: Body): void;
  removeBody(body: Body): void;
  /** The body's mass properties or list of colliders changed. */
  updateBody(body: Body): void;
  /** Throws an EulerError for a kind of joint the backend can't simulate. */
  addJoint(joint: Joint): void;
  removeJoint(joint: Joint): void;
  /**
   * Stops two bodies colliding with each other, or lets them again. The world calls it at most
   * once each way per pair, and with `enabled` true for every pair it disabled before either body
   * is removed. Joints with `collideConnected` false keep their bodies apart on their own.
   */
  setCollisionsBetween(bodyA: Body, bodyB: Body, enabled: boolean): void;
  /** Moves the backend's copy of the body to the body's position and quaternion. */
  writePose(body: Body): void;
  /** Sets the backend's copy of the body's velocity and angular velocity to the body's. */
  writeVelocity(body: Body): void;
  /** Wakes the body and restarts its sleep timer, even if it is already awake. */
  wakeUp(body: Body): void;
  /** Puts the body to sleep now, stopping it. */
  sleep(body: Body): void;
  /** Adds a force through the centre of mass and a torque about it, both in world space, to the next step only. */
  applyLoads(body: Body, force: Vector3, torque: Vector3): void;
  step(settings: StepSettings): void;
  /** Writes the backend's pose and velocities for the body into `target`. */
  readMotion(body: Body, target: BodyMotion): void;
  isSleeping(body: Body): boolean;
  /** The contacts that pushed during the last step, one for each touching point. */
  readonly contacts: readonly Contact[];
  /** Each pair of colliders, one or both a sensor, that overlapped during the last step, among bodies at least one of which was awake. */
  readonly sensorOverlaps: readonly SensorOverlap[];
  /**
   * Every collider a ray from `origin` along the unit `direction` meets within `maxDistance`, with
   * where it first meets it, nearest first; only the nearest unless `all`. Uses the bodies as the
   * backend last had them: the world writes poses you changed before asking.
   */
  castRay(origin: Vector3, direction: Vector3, maxDistance: number, filter: QueryFilter, all: boolean): QueryHit[];
  /** Where `shape`, at `position` turned by `quaternion` and swept along the unit `direction`, first touches a collider within `maxDistance`. */
  castShape(shape: Collider, position: Vector3, quaternion: Quaternion, direction: Vector3, maxDistance: number, filter: QueryFilter): QueryHit | undefined;
  /** Every collider that `shape`, at `position` turned by `quaternion`, overlaps or touches. */
  overlap(shape: Collider, position: Vector3, quaternion: Quaternion, filter: QueryFilter): OverlapHit[];
  /** Frees whatever the backend holds; called by `world.dispose()`. */
  dispose?(): void;
}
