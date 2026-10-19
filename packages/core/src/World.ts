import { Quaternion, Vector3 } from 'three';
import type { InstancedMesh, Object3D } from 'three';
import type { Contact, PhysicsBackend, StepSettings } from './backend.js';
import type { Collider } from './colliders/Collider.js';
import { Body } from './Body.js';
import type { InstancedBodyOptions, ObjectBodyOptions } from './Body.js';
import { EulerError } from './errors.js';
import { JavaScriptBackend } from './javascript/JavaScriptBackend.js';
import type { Joint } from './joints/Joint.js';
import { EventHub } from './events.js';
import type { WorldEventListener, WorldEventName } from './events.js';
import type { Plugin } from './plugins.js';
import type { OverlapHit, OverlapOptions, QueryHit, RayCastOptions, ShapeCastOptions } from './queries.js';
import type { BodyMotion } from './RigidBodyState.js';

export interface WorldOptions {
  /** Defaults to (0, -9.81, 0). */
  gravity?: Vector3 | undefined;
  /**
   * Length of one fixed step in seconds. Defaults to 1/60; substeps (see `substeps`) give joints
   * and contacts their stiffness, and behaviours such as buoyancy run once per step.
   */
  timestep?: number | undefined;
  /**
   * Most fixed steps one `step(frameDelta)` call may run. When rendering falls further behind,
   * the extra time is dropped and the simulation runs slower instead of freezing the page.
   */
  maxStepsPerFrame?: number | undefined;
  /**
   * The backend's accuracy setting. For the JavaScript backend, how many substeps each step is
   * split into when there are joints or contacts to solve. Defaults to 4, which suits games in
   * the browser; 8 makes joints and contacts stiffer and more accurate, for when that matters
   * more than speed, and halves the small energy loss every position-based solver has, as each
   * doubling does. A world with nothing to solve integrates each step in one go.
   */
  substeps?: number | undefined;
  /** Bodies slower than this (m/s) and `sleepSpin` for `timeToSleep` seconds fall asleep. Defaults to 0.01, as in Box2D. */
  sleepSpeed?: number | undefined;
  /** In rad/s. Defaults to 0.035 (2° per second). */
  sleepSpin?: number | undefined;
  /** In seconds. Defaults to 0.5. */
  timeToSleep?: number | undefined;
  /** What simulates the world. Defaults to a new JavaScriptBackend. */
  backend?: PhysicsBackend | undefined;
}

const identity = new Quaternion();

/** Substeps per step unless a world asks for others: enough for games, see `WorldOptions.substeps`. */
const DEFAULT_SUBSTEPS = 4;

/** Tolerance for floating-point drift when deciding whether a full step's time has accumulated. */
const ACCUMULATOR_EPSILON = 1e-9;

/**
 * The simulation: bodies, joints and plugins, stepped at a fixed timestep by its backend. Make one
 * next to your three.js scene, add bodies bound to your objects, and call `update` with each
 * frame's time to step it and move the objects to their bodies.
 */
export class World implements StepSettings {
  readonly gravity: Vector3;
  readonly timestep: number;
  maxStepsPerFrame: number;
  substeps: number;
  sleepSpeed: number;
  sleepSpin: number;
  timeToSleep: number;

  readonly backend: PhysicsBackend;

  private readonly bodyList: Body[] = [];
  private readonly pluginList: Plugin[] = [];
  private readonly jointList: Joint[] = [];
  /** For each body, the bodies it doesn't collide with because `setCollisionsBetween` said so. */
  private readonly noCollisions = new Map<Body, Set<Body>>();
  /** Each body's motion as the backend last had it, to tell which ones you changed: in the order of `bodyList`. */
  private readonly syncedList: SyncedMotion[] = [];
  /**
   * For each body in `bodyList`, 1 while this step leaves it be: a static body that nothing has
   * moved, woken or put to sleep since the last step, which the backend already has as it is.
   */
  private leftBe = new Uint8Array(0);
  private readonly bodiesByObject = new Map<Object3D, Body>();
  private readonly bodiesByInstance = new Map<InstancedMesh, Map<number, Body>>();
  private readonly events = new EventHub();
  private simulatedTime = 0;
  private completedSteps = 0;
  private accumulatedTime = 0;

  constructor(options: WorldOptions = {}) {
    this.gravity = options.gravity?.clone() ?? new Vector3(0, -9.81, 0);
    this.timestep = options.timestep ?? 1 / 60;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? 8;
    this.substeps = options.substeps ?? DEFAULT_SUBSTEPS;
    this.sleepSpeed = options.sleepSpeed ?? 0.01;
    this.sleepSpin = options.sleepSpin ?? (2 * Math.PI) / 180;
    this.timeToSleep = options.timeToSleep ?? 0.5;
    this.backend = options.backend ?? new JavaScriptBackend();
    if (!Number.isInteger(this.substeps) || this.substeps < 1) {
      throw new EulerError(`substeps must be a whole number of at least 1, got ${this.substeps}`);
    }
    if (!(this.timestep > 0) || !Number.isFinite(this.timestep)) {
      throw new EulerError(`timestep must be a positive number of seconds, got ${this.timestep}`);
    }
  }

  /** Simulated time in seconds: the number of completed steps times the timestep. */
  get time(): number {
    return this.simulatedTime;
  }

  get stepCount(): number {
    return this.completedSteps;
  }

  /** How far rendering is between the last two steps, from 0 to 1. */
  get interpolationAlpha(): number {
    return this.accumulatedTime / this.timestep;
  }

  /**
   * The moment bodies are drawn at after `syncObjects`: alpha of the way through the last step.
   * Animate anything that should match the bodies, such as water, with this time.
   */
  get renderTime(): number {
    return Math.max(0, this.simulatedTime - (1 - this.interpolationAlpha) * this.timestep);
  }

  get bodies(): readonly Body[] {
    return this.bodyList;
  }

  get plugins(): readonly Plugin[] {
    return this.pluginList;
  }

  get joints(): readonly Joint[] {
    return this.jointList;
  }

  /** The contacts that pushed bodies apart during the last step, one for each touching point. */
  get contacts(): readonly Contact[] {
    return this.backend.contacts;
  }

  /**
   * The first collider a ray from `origin` along `direction` meets, with where and how far away:
   * for shooting, picking, line of sight and checking for ground. Sensors are skipped unless the
   * options include them, and a ray starting inside a solid meets it at once.
   */
  castRay(origin: Vector3, direction: Vector3, options: RayCastOptions = {}): QueryHit | undefined {
    return this.queryRay(origin, direction, options, false)[0];
  }

  /** Every collider a ray from `origin` along `direction` meets, nearest first. */
  castRayAll(origin: Vector3, direction: Vector3, options: RayCastOptions = {}): QueryHit[] {
    return this.queryRay(origin, direction, options, true);
  }

  /**
   * Where a convex `shape` (a sphere, capsule, box, hull, cylinder or cone), starting at
   * `position` and sliding along `direction`, first touches a collider: the usual way to move a
   * character or check that something fits. The shape needn't belong to any body.
   */
  castShape(shape: Collider, position: Vector3, direction: Vector3, options: ShapeCastOptions = {}): QueryHit | undefined {
    const unit = this.unitDirection(direction);
    this.writePosesForQuery();
    return this.backend.castShape(shape, position, options.quaternion ?? identity, unit, options.maxDistance ?? Infinity, options);
  }

  /** Every collider a convex `shape` at `position` overlaps or touches: what is inside an explosion, say. */
  overlap(shape: Collider, position: Vector3, options: OverlapOptions = {}): OverlapHit[] {
    this.writePosesForQuery();
    return this.backend.overlap(shape, position, options.quaternion ?? identity, options);
  }

  /**
   * Listens for an event, sent after each step: contacts beginning and ending, things entering
   * and leaving sensors, joints breaking. Returns a function that stops listening.
   */
  on<Name extends WorldEventName>(name: Name, listener: WorldEventListener<Name>): () => void {
    return this.events.on(name, listener);
  }

  off<Name extends WorldEventName>(name: Name, listener: WorldEventListener<Name>): void {
    this.events.off(name, listener);
  }

  /**
   * Every collider in a sensor as of the last step, and its body: what `sensorEnter` brought in
   * and `sensorExit` hasn't taken out, including bodies asleep in it.
   */
  inSensor(sensor: Collider): OverlapHit[] {
    return this.events.inSensor(sensor);
  }

  /** Adds a joint between bodies already in this world. */
  addJoint<SomeJoint extends Joint>(joint: SomeJoint): SomeJoint {
    if (this.jointList.includes(joint)) return joint;
    if (joint.bodies.some((body) => body.world !== this)) {
      throw new EulerError('Add the bodies a joint ties together to the world before the joint');
    }
    joint.settleCollideConnected(() => this.jointBodiesOverlap(joint.bodyA, joint.bodyB));
    this.backend.addJoint(joint);
    this.jointList.push(joint);
    return joint;
  }

  /** Whether any collider of one body overlaps one of the other, for `collideConnected: 'unlessOverlapping'`. */
  private jointBodiesOverlap(bodyA: Body, bodyB: Body | undefined): boolean {
    if (!bodyB) return false;
    for (const [one, other] of [[bodyA, bodyB], [bodyB, bodyA]] as const) {
      for (const collider of one.colliders) {
        if (collider.sensor) continue;
        try {
          if (this.overlap(collider, one.position, { quaternion: one.quaternion, filter: (body, found) => body === other && !found.sensor }).length > 0) return true;
        } catch (error) {
          // a shape that can't be tested for overlaps, such as a plane: the other body's are tried too
          if (!(error instanceof EulerError)) throw error;
        }
      }
    }
    return false;
  }

  removeJoint(joint: Joint): void {
    const index = this.jointList.indexOf(joint);
    if (index === -1) return;
    this.jointList.splice(index, 1);
    this.backend.removeJoint(joint);
  }

  /**
   * Adds a body. Given a three.js object instead, makes a body for it first: mass properties
   * from its meshes (water density unless you give a mass or density), starting pose from where
   * the object is. It collides as `options.collider` says and only then: without it the body has
   * no colliders and falls through everything, on purpose, since the mesh drawn is seldom the
   * shape to collide as.
   */
  addBody<SomeBody extends Body>(body: SomeBody): SomeBody;
  addBody(object: Object3D, options?: ObjectBodyOptions): Body;
  addBody(bodyOrObject: Body | Object3D, options?: ObjectBodyOptions): Body {
    if (!(bodyOrObject instanceof Body) && (bodyOrObject as InstancedMesh).isInstancedMesh) {
      throw new EulerError('An InstancedMesh draws many bodies, not one: world.addInstances(mesh, options) makes a body for each instance');
    }
    const body = bodyOrObject instanceof Body ? bodyOrObject : Body.fromObject(bodyOrObject, options);
    if (body.world === this) return body;
    if (body.world !== undefined) {
      throw new EulerError('Body already belongs to another world; remove it there first');
    }
    if (body.object && this.bodiesByObject.has(body.object)) {
      throw new EulerError('That object already has a body in this world');
    }
    if (body.instance && this.bodiesByInstance.get(body.instance.mesh)?.has(body.instance.index)) {
      throw new EulerError(`Instance ${body.instance.index} of that mesh already has a body in this world`);
    }
    this.backend.addBody(body);
    this.bodyList.push(body);
    this.syncedList.push(new SyncedMotion(body));
    if (body.object) this.bodiesByObject.set(body.object, body);
    if (body.instance) {
      let byIndex = this.bodiesByInstance.get(body.instance.mesh);
      if (!byIndex) this.bodiesByInstance.set(body.instance.mesh, (byIndex = new Map()));
      byIndex.set(body.instance.index, body);
    }
    body.setWorld(this);
    return body;
  }

  /**
   * Adds a body for every instance of an InstancedMesh, each drawn as its instance: posed where
   * the instance is, colliding as `options.collider` says, and weighed from the mesh's geometry
   * (water density unless you give a mass or density, which is each body's). Returns them in the
   * instances' order.
   */
  addInstances(mesh: InstancedMesh, options?: InstancedBodyOptions): Body[] {
    return Body.fromInstances(mesh, options).map((body) => this.addBody(body));
  }

  /** Removes the body, and the joints that tie it to others. */
  removeBody(body: Body): void {
    const index = this.bodyList.indexOf(body);
    if (index === -1) return;
    for (const joint of this.jointList.filter((candidate) => candidate.bodies.includes(body))) this.removeJoint(joint);
    this.events.removeBody(body);
    for (const other of [...(this.noCollisions.get(body) ?? [])]) this.setCollisionsBetween(body, other, true);
    this.bodyList.splice(index, 1);
    this.syncedList.splice(index, 1);
    if (body.object) this.bodiesByObject.delete(body.object);
    if (body.instance) this.bodiesByInstance.get(body.instance.mesh)?.delete(body.instance.index);
    this.backend.removeBody(body);
    body.setWorld(undefined);
  }

  /**
   * Stops two bodies in this world colliding with each other, or lets them again: say, parts of a
   * ragdoll near each other that touch when it folds up. Bodies tied by a joint can instead have
   * it set `collideConnected: false`.
   */
  setCollisionsBetween(bodyA: Body, bodyB: Body, enabled: boolean): void {
    if (bodyA.world !== this || bodyB.world !== this) throw new EulerError('Both bodies must be in this world');
    const colliding = !(this.noCollisions.get(bodyA)?.has(bodyB) ?? false);
    if (colliding === enabled) return;
    for (const [one, other] of [[bodyA, bodyB], [bodyB, bodyA]] as const) {
      if (enabled) {
        this.noCollisions.get(one)!.delete(other);
      } else {
        if (!this.noCollisions.has(one)) this.noCollisions.set(one, new Set());
        this.noCollisions.get(one)!.add(other);
      }
    }
    this.backend.setCollisionsBetween(bodyA, bodyB, enabled);
  }

  /** @internal Called by a body in this world when its mass properties or colliders change. */
  bodyChanged(body: Body): void {
    this.backend.updateBody(body);
  }

  /**
   * The body that moves `object`, or one of its ancestors: e.g. the body of a mesh a raycast hit.
   * For an InstancedMesh, give the instance too, as a three.js raycast's `instanceId` gives it.
   */
  bodyOf(object: Object3D, instanceId?: number): Body | undefined {
    if (instanceId !== undefined && (object as InstancedMesh).isInstancedMesh) return this.bodiesByInstance.get(object as InstancedMesh)?.get(instanceId);
    for (let current: Object3D | null = object; current; current = current.parent) {
      const body = this.bodiesByObject.get(current);
      if (body) return body;
    }
    return undefined;
  }

  use<SomePlugin extends Plugin>(plugin: SomePlugin): SomePlugin {
    if (this.pluginList.includes(plugin)) return plugin;
    this.pluginList.push(plugin);
    plugin.install?.(this);
    return plugin;
  }

  removePlugin(plugin: Plugin): void {
    const index = this.pluginList.indexOf(plugin);
    if (index === -1) return;
    this.pluginList.splice(index, 1);
    plugin.dispose?.(this);
  }

  /**
   * Advances the simulation by a frame's worth of real time, in as many fixed steps as fit.
   * Returns the interpolation alpha to pass to `syncObjects`.
   */
  step(frameDelta: number): number {
    if (frameDelta > 0) {
      this.accumulatedTime = Math.min(this.accumulatedTime + frameDelta, this.maxStepsPerFrame * this.timestep);
    }
    while (this.accumulatedTime >= this.timestep - ACCUMULATOR_EPSILON) {
      this.fixedStep();
      this.accumulatedTime = Math.max(0, this.accumulatedTime - this.timestep);
    }
    return this.interpolationAlpha;
  }

  /** `step` then `syncObjects`: everything a render loop needs. Returns the interpolation alpha. */
  update(frameDelta: number): number {
    const alpha = this.step(frameDelta);
    this.syncObjects(alpha);
    return alpha;
  }

  /**
   * Runs exactly one fixed step. Useful for tests and for driving the clock yourself.
   *
   * Changes you make to bodies between steps reach the backend before the behaviours run;
   * changes made by behaviours and plugins reach it before it simulates.
   */
  fixedStep(): void {
    const timestep = this.timestep;
    const bodies = this.bodyList;
    const syncedList = this.syncedList;
    if (this.leftBe.length < bodies.length) this.leftBe = new Uint8Array(Math.max(bodies.length, 2 * this.leftBe.length));
    const leftBe = this.leftBe;
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!;
      const synced = syncedList[index]!;
      // still scenery the step has nothing to do for, which is most of the bodies of many scenes
      if (isUntouchedStatic(body, synced)) {
        leftBe[index] = 1;
        continue;
      }
      leftBe[index] = 0;
      // a sleeping body given a velocity by hand wakes up
      if (body.isSleeping && (body.velocity.lengthSq() > 0 || body.angularVelocity.lengthSq() > 0)) body.wakeUp();
      body.beginStep();
      this.writeChanges(body, synced);
    }
    for (const plugin of this.pluginList) plugin.beforeStep?.(this, timestep);
    for (const body of bodies) {
      for (const behavior of body.behaviors) behavior.fixedUpdate(body, timestep, this);
    }
    for (const plugin of this.pluginList) plugin.applyForces?.(this, timestep);
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!;
      const synced = syncedList[index]!;
      if (leftBe[index] && !isUntouchedStatic(body, synced)) {
        // moved since the step began, by a behaviour or a plugin: it began the step where it was
        leftBe[index] = 0;
        body.previousPosition.copy(synced.position);
        body.previousQuaternion.copy(synced.quaternion);
      }
      if (!leftBe[index]) this.writeChanges(body, synced);
      this.writeLoads(body);
    }
    this.backend.step(this);
    for (let index = 0; index < bodies.length; index++) if (!leftBe[index]) this.readResults(bodies[index]!, syncedList[index]!);
    for (const joint of this.jointList.filter((candidate) => candidate.isOverloaded)) {
      const force = joint.force.length();
      const torque = joint.torque.length();
      joint.broken = true;
      this.removeJoint(joint);
      this.events.emit('jointBreak', { joint, force, torque });
    }
    this.events.afterStep(
      () => this.backend.contacts,
      () => this.backend.sensorOverlaps,
    );
    this.completedSteps++;
    this.simulatedTime = this.completedSteps * timestep;
    for (const plugin of this.pluginList) plugin.afterStep?.(this, timestep);
  }

  private queryRay(origin: Vector3, direction: Vector3, options: RayCastOptions, all: boolean): QueryHit[] {
    const unit = this.unitDirection(direction);
    this.writePosesForQuery();
    return this.backend.castRay(origin, unit, options.maxDistance ?? Infinity, options, all);
  }

  private unitDirection(direction: Vector3): Vector3 {
    const length = direction.length();
    if (!(length > 0) || !Number.isFinite(length)) throw new EulerError('A query needs a direction that is not zero');
    return direction.clone().divideScalar(length);
  }

  /**
   * Lets the backend see poses changed by hand since it last had them before it answers a query:
   * a look at every body, about 10 ns each.
   */
  private writePosesForQuery(): void {
    const bodies = this.bodyList;
    const syncedList = this.syncedList;
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!;
      const synced = syncedList[index]!;
      if (synced.hasPoseOf(body)) continue;
      this.backend.writePose(body);
      synced.copyPose(body);
    }
  }

  /** Passes on whatever about the body's motion and sleep has changed since the backend last had it. */
  private writeChanges(body: Body, synced: SyncedMotion): void {
    if (!synced.hasPoseOf(body)) this.backend.writePose(body);
    if (!synced.hasVelocityOf(body)) this.backend.writeVelocity(body);
    synced.copy(body);
    const request = body.takeSleepRequest();
    if (request === 'wake') this.backend.wakeUp(body);
    else if (request === 'sleep') this.backend.sleep(body);
  }

  private writeLoads(body: Body): void {
    if (body.force.lengthSq() === 0 && body.torque.lengthSq() === 0) return;
    this.backend.applyLoads(body, body.force, body.torque);
    body.clearForces();
  }

  private readResults(body: Body, synced: SyncedMotion): void {
    this.backend.readMotion(body, body);
    body.setSleepState(this.backend.isSleeping(body));
    body.refreshAfterStep();
    // A static body's pose is compared as it is, with nothing renormalising it from step to step,
    // so that it stays the same, and is left be, until something moves it.
    if (body.type === 'static') synced.copy(body);
    else synced.copyRenormalized(body);
  }

  /** Moves every bound three.js object to its body's pose, interpolated between the last two steps. */
  syncObjects(alpha = this.interpolationAlpha): void {
    for (const body of this.bodyList) body.syncObject(alpha);
  }

  /** Removes every plugin (calling their dispose hooks) and body, then disposes of the backend. */
  dispose(): void {
    for (const plugin of [...this.pluginList]) this.removePlugin(plugin);
    for (const body of [...this.bodyList]) this.removeBody(body);
    this.backend.dispose?.();
  }
}

/** Whether `body` is static, and nothing has moved, woken or put it to sleep since the backend last had it. */
function isUntouchedStatic(body: Body, synced: SyncedMotion): boolean {
  return body.type === 'static' && !body.hasSleepRequest && synced.hasPoseOf(body) && synced.hasVelocityOf(body);
}

/** A copy of a body's motion as the backend has it. */
class SyncedMotion implements BodyMotion {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly velocity = new Vector3();
  readonly angularVelocity = new Vector3();

  constructor(motion: BodyMotion) {
    this.copyRenormalized(motion);
  }

  hasPoseOf(motion: BodyMotion): boolean {
    const position = motion.position;
    const quaternion = motion.quaternion;
    return (
      this.position.x === position.x &&
      this.position.y === position.y &&
      this.position.z === position.z &&
      this.quaternion.x === quaternion.x &&
      this.quaternion.y === quaternion.y &&
      this.quaternion.z === quaternion.z &&
      this.quaternion.w === quaternion.w
    );
  }

  hasVelocityOf(motion: BodyMotion): boolean {
    const velocity = motion.velocity;
    const angularVelocity = motion.angularVelocity;
    return (
      this.velocity.x === velocity.x &&
      this.velocity.y === velocity.y &&
      this.velocity.z === velocity.z &&
      this.angularVelocity.x === angularVelocity.x &&
      this.angularVelocity.y === angularVelocity.y &&
      this.angularVelocity.z === angularVelocity.z
    );
  }

  copyPose(motion: BodyMotion): void {
    this.position.copy(motion.position);
    this.quaternion.copy(motion.quaternion);
  }

  copy(motion: BodyMotion): void {
    this.position.copy(motion.position);
    this.quaternion.copy(motion.quaternion);
    this.velocity.copy(motion.velocity);
    this.angularVelocity.copy(motion.angularVelocity);
  }

  /**
   * Copies the motion of a body that is about to wait for the next step, with the quaternion
   * renormalised: the body's own is renormalised when the step begins, before they are compared,
   * and the backend renormalises its copy too, so renormalising alone never counts as a change.
   */
  copyRenormalized(motion: BodyMotion): void {
    this.copy(motion);
    this.quaternion.normalize();
  }
}
