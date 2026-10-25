import type { Quaternion, Vector3 } from 'three';
import type { Contact, PhysicsBackend, SensorOverlap, StepSettings } from '../backend.js';
import type { Body } from '../Body.js';
import type { Collider } from '../colliders/Collider.js';
import type { OverlapHit, QueryFilter, QueryHit } from '../queries.js';
import { EulerError } from '../errors.js';
import { DistanceJoint } from '../joints/DistanceJoint.js';
import type { Joint } from '../joints/Joint.js';
import { SixDofJoint } from '../joints/SixDofJoint.js';
import type { BodyMotion } from '../RigidBodyState.js';
import { CollisionSystem } from './collision/CollisionSystem.js';
import { SceneQueries } from './collision/SceneQueries.js';
import type { Constraint } from './Constraint.js';
import { DistanceJointSolver } from './DistanceJointSolver.js';
import { SixDofJointSolver } from './SixDofJointSolver.js';
import { integrateBody } from './integration.js';
import { beginSubstep, deriveVelocitiesIfCorrected } from './positional.js';
import { SoftStepSolver } from './soft/SoftStepSolver.js';
import { SolverBody } from './SolverBody.js';

export interface JavaScriptBackendOptions {
  /**
   * How joints and contacts are solved: 'soft-step' (the default), velocity impulses that carry
   * over from step to step, after Box2D v3, which keeps stacks still and energy steady; or
   * 'xpbd', extended position-based dynamics, whose joints and contacts give less under load.
   */
  solver?: 'xpbd' | 'soft-step' | undefined;
}

/**
 * The built-in backend, in plain JavaScript: semi-implicit Euler integration with an exact
 * gyroscopic term, and joints and contacts solved over `substeps` substeps per step, by extended
 * position-based dynamics (XPBD) or by soft step (see JavaScriptBackendOptions).
 */
export class JavaScriptBackend implements PhysicsBackend {
  readonly name = 'javascript';

  private readonly solverBodies = new Map<Body, SolverBody>();
  /** The solver bodies in the order their bodies were added, which is the order they are solved in. */
  private bodyList: SolverBody[] = [];
  /**
   * The same but for static ones, in the same order: what moves, or may. A static body's state
   * is brought up to date when it is added or moved by hand, and nothing in a step changes it, so
   * the step's loops over bodies needn't visit it: with a great deal of still scenery, that is
   * most of the bodies.
   */
  private movingList: SolverBody[] = [];
  /** The union-find of `putIslandsToSleep`, reused from step to step: each body's parent, and whether each island may sleep. */
  private islandParents = new Int32Array(0);
  private islandReady = new Uint8Array(0);
  private readonly constraints = new Map<Joint, Constraint>();
  /** The same constraints, in an array to go through quickly on every substep. */
  private constraintList: Constraint[] = [];
  /** Each joint's two solver bodies, by kind, for the soft-step solver. */
  private readonly distanceJointBodies = new Map<DistanceJoint, readonly [SolverBody, SolverBody | undefined]>();
  private readonly sixDofJointBodies = new Map<SixDofJoint, readonly [SolverBody, SolverBody | undefined]>();
  private readonly collisions = new CollisionSystem();
  private stepsTaken = 0;
  private readonly queries = new SceneQueries(
    () => this.movingList,
    () => this.stepsTaken,
  );
  /** The soft-step solver, if this backend uses it rather than XPBD. */
  private readonly softStep: SoftStepSolver | undefined;

  constructor(options: JavaScriptBackendOptions = {}) {
    if ((options.solver ?? 'soft-step') === 'soft-step') this.softStep = new SoftStepSolver();
  }

  get contacts(): readonly Contact[] {
    return this.softStep ? this.softStep.contacts : this.collisions.contacts;
  }

  get sensorOverlaps(): readonly SensorOverlap[] {
    return this.collisions.sensorOverlaps.map(({ bodyA, bodyB, colliderA, colliderB }) => ({ bodyA: bodyA.source, bodyB: bodyB.source, colliderA, colliderB }));
  }

  addBody(body: Body): void {
    if (this.solverBodies.has(body)) return;
    const solverBody = new SolverBody(body);
    this.solverBodies.set(body, solverBody);
    this.bodyList.push(solverBody);
    if (solverBody.type === 'static') this.settleStatic(solverBody);
    else this.movingList.push(solverBody);
    this.queries.bodyChanged(solverBody);
  }

  /**
   * Brings a static body's state up to date for the steps to come, as each step would otherwise
   * do for it: its pose renormalised, the matrix and inertia it gives, and, for the position-based
   * solver, where it is at the start of each substep.
   */
  private settleStatic(solverBody: SolverBody): void {
    solverBody.updateDerivedState();
    beginSubstep(solverBody);
  }

  removeBody(body: Body): void {
    const solverBody = this.solverBodies.get(body);
    if (!solverBody) return;
    // what rested on it falls
    this.collisions.wakeAround(solverBody);
    this.solverBodies.delete(body);
    this.bodyList = this.bodyList.filter((candidate) => candidate !== solverBody);
    this.movingList = this.movingList.filter((candidate) => candidate !== solverBody);
    this.queries.bodyRemoved(solverBody);
  }

  updateBody(body: Body): void {
    const solverBody = this.solverBodyOf(body);
    // where its colliders were: what one taken away held up falls
    this.collisions.wakeAround(solverBody);
    solverBody.copyMassFrom(body);
    this.queries.bodyChanged(solverBody);
  }

  addJoint(joint: Joint): void {
    if (this.constraints.has(joint)) return;
    if (!(joint instanceof DistanceJoint || joint instanceof SixDofJoint)) {
      throw new EulerError(`The JavaScript backend can't simulate a ${(joint as object).constructor.name}`);
    }
    const bodyA = this.solverBodyOf(joint.bodyA);
    const bodyB = joint.bodyB && this.solverBodyOf(joint.bodyB);
    const constraint: Constraint = joint instanceof DistanceJoint ? new DistanceJointSolver(joint, bodyA, bodyB) : new SixDofJointSolver(joint, bodyA, bodyB);
    this.constraints.set(joint, constraint);
    this.constraintList.push(constraint);
    if (joint instanceof DistanceJoint) this.distanceJointBodies.set(joint, [bodyA, bodyB]);
    else this.sixDofJointBodies.set(joint, [bodyA, bodyB]);
    if (bodyB && !joint.collideConnected) {
      bodyA.ignoreCollisionsWith(bodyB);
      bodyB.ignoreCollisionsWith(bodyA);
    }
  }

  removeJoint(joint: Joint): void {
    const constraint = this.constraints.get(joint);
    if (!constraint) return;
    this.constraints.delete(joint);
    if (joint instanceof DistanceJoint) this.distanceJointBodies.delete(joint);
    else this.sixDofJointBodies.delete(joint);
    this.softStep?.forget(joint);
    this.constraintList = this.constraintList.filter((candidate) => candidate !== constraint);
    const [bodyA, bodyB] = constraint.bodies ?? [];
    // what the joint held up, as a lamp hanging from it asleep, falls
    for (const held of [bodyA, bodyB]) if (held?.isSleeping) held.wakeUp();
    if (bodyA && bodyB && !joint.collideConnected) {
      bodyA.collideAgainWith(bodyB);
      bodyB.collideAgainWith(bodyA);
    }
  }

  setCollisionsBetween(bodyA: Body, bodyB: Body, enabled: boolean): void {
    const solverA = this.solverBodyOf(bodyA);
    const solverB = this.solverBodyOf(bodyB);
    if (enabled) {
      solverA.collideAgainWith(solverB);
      solverB.collideAgainWith(solverA);
    } else {
      solverA.ignoreCollisionsWith(solverB);
      solverB.ignoreCollisionsWith(solverA);
    }
  }

  writePose(body: Body): void {
    const solverBody = this.solverBodyOf(body);
    // moved by hand: what rested on it where it was, and what it is moved into, wake
    this.collisions.wakeAround(solverBody);
    solverBody.copyPoseFrom(body);
    this.collisions.wakeAround(solverBody);
    if (solverBody.type === 'static') this.settleStatic(solverBody);
    this.queries.bodyChanged(solverBody);
  }

  writeVelocity(body: Body): void {
    this.solverBodyOf(body).copyVelocityFrom(body);
  }

  wakeUp(body: Body): void {
    this.solverBodyOf(body).wakeUp();
  }

  sleep(body: Body): void {
    this.solverBodyOf(body).sleep();
    this.collisions.bodiesFellAsleep();
  }

  applyLoads(body: Body, force: Vector3, torque: Vector3): void {
    const solverBody = this.solverBodyOf(body);
    // nothing moves a static body
    if (solverBody.type === 'static') return;
    solverBody.force.add(force);
    solverBody.torque.add(torque);
  }

  readMotion(body: Body, target: BodyMotion): void {
    const solverBody = this.solverBodyOf(body);
    target.position.copy(solverBody.position);
    target.quaternion.copy(solverBody.quaternion);
    target.velocity.copy(solverBody.velocity);
    target.angularVelocity.copy(solverBody.angularVelocity);
  }

  castRay(origin: Vector3, direction: Vector3, maxDistance: number, filter: QueryFilter, all: boolean): QueryHit[] {
    return this.queries.castRay(origin, direction, maxDistance, filter, all);
  }

  castShape(shape: Collider, position: Vector3, quaternion: Quaternion, direction: Vector3, maxDistance: number, filter: QueryFilter): QueryHit | undefined {
    return this.queries.castShape(shape, position, quaternion, direction, maxDistance, filter);
  }

  overlap(shape: Collider, position: Vector3, quaternion: Quaternion, filter: QueryFilter): OverlapHit[] {
    return this.queries.overlap(shape, position, quaternion, filter);
  }

  isSleeping(body: Body): boolean {
    return this.solverBodyOf(body).isSleeping;
  }

  step(settings: StepSettings): void {
    this.stepsTaken++;
    const { gravity, timestep } = settings;
    const moving = this.movingList;
    for (const body of moving) body.updateDerivedState();
    const colliding = this.collisions.hasColliders(this.bodyList);
    if (!colliding) {
      this.collisions.sensorOverlaps = [];
      this.collisions.touchingFirst.length = 0;
      this.collisions.touchingSecond.length = 0;
    }
    if (this.constraints.size === 0 && !colliding) {
      for (const body of moving) integrateBody(body, gravity, timestep);
    } else {
      // Everything that wakes this step does so before any contact is made: a contact works out
      // once, for the whole step, how easily each of its bodies moves.
      this.wakeJointPartners();
      if (colliding) this.collisions.findCandidatePairs(this.bodyList, timestep, 2 * settings.sleepSpeed, () => this.wakeJointPartners());
      if (this.softStep) {
        this.softStep.step(moving, this.distanceJointBodies, this.sixDofJointBodies, colliding ? this.collisions.findManifolds() : [], settings);
      } else {
        if (colliding) this.collisions.detectContacts();
        this.runSubsteps(settings, colliding);
      }
    }
    for (const body of moving) {
      body.clearForces();
      body.updateStillness(timestep, settings.sleepSpeed, settings.sleepSpin);
    }
    this.putStillBodiesToSleep(settings.timeToSleep);
  }

  dispose(): void {
    this.solverBodies.clear();
    this.bodyList = [];
    this.movingList = [];
    this.constraints.clear();
    this.constraintList = [];
    this.distanceJointBodies.clear();
    this.sixDofJointBodies.clear();
  }

  /**
   * Puts bodies that have been still long enough to sleep. Bodies tied together by joints sleep
   * only all at once, when every one of them is ready: one asleep on its own would wake the
   * others, and be woken by them, on the next step. And none sleeps while it touches, directly or
   * through other awake bodies, one that won't sleep, such as a lift that may not or a moving
   * kinematic platform: asleep, it would be an immovable wall to it (a box resting on the lift
   * would hold it down when it rose).
   */
  private putStillBodiesToSleep(timeToSleep: number): void {
    if (!this.movingList.some((body) => body.isReadyToSleep(timeToSleep))) return;
    const keptAwake = this.keptAwakeByContact();
    if (this.softStep) this.putIslandsToSleep(timeToSleep, keptAwake);
    else {
      const groups = this.jointGroups();
      for (const body of this.movingList) {
        if (!body.isReadyToSleep(timeToSleep) || keptAwake.has(body)) continue;
        const group = groups.get(body);
        if (!group) body.sleep();
        else if (group.every((member) => !member.isMovable || (member.isReadyToSleep(timeToSleep) && !keptAwake.has(member)))) for (const member of group) member.sleep();
      }
    }
    this.collisions.bodiesFellAsleep();
  }

  /**
   * Under soft step, bodies sleep island by island: the awake bodies touching or tied to one
   * another, directly or through others of them (static ones hold things up without joining
   * them), fall asleep together once every one of them is ready, and wake together (see
   * `SolverBody.sleepingIsland`), so a pile is never half asleep, its sleeping half a wall to the
   * rest. XPBD sleeps body by body instead: a tall stack of its creeps too much to be still all at once.
   */
  private putIslandsToSleep(timeToSleep: number, keptAwake: ReadonlySet<SolverBody>): void {
    const bodies = this.movingList;
    const count = bodies.length;
    for (let index = 0; index < count; index++) bodies[index]!.islandIndex = index;
    if (this.islandParents.length < count) this.islandParents = new Int32Array(2 * count);
    const parents = this.islandParents;
    for (let index = 0; index < count; index++) parents[index] = index;
    const rootOf = (index: number): number => {
      let root = index;
      while (parents[root] !== root) root = parents[root] = parents[parents[root]!]!;
      return root;
    };
    // the lower root of the two joined becomes the other's, so islands come out the same whatever order they are joined in
    const join = (first: SolverBody, second: SolverBody) => {
      if (!first.isMovable || !second.isMovable || first.isSleeping || second.isSleeping) return;
      const firstRoot = rootOf(first.islandIndex);
      const secondRoot = rootOf(second.islandIndex);
      if (firstRoot < secondRoot) parents[secondRoot] = firstRoot;
      else if (secondRoot < firstRoot) parents[firstRoot] = secondRoot;
    };
    const { touchingFirst, touchingSecond } = this.collisions;
    for (let index = 0; index < touchingFirst.length; index++) join(touchingFirst[index]!, touchingSecond[index]!);
    for (const constraint of this.constraintList) {
      const tied = constraint.bodies ?? [];
      for (let index = 1; index < tied.length; index++) join(tied[0]!, tied[index]!);
    }
    // an island sleeps when every body of it is ready to and none is kept awake
    if (this.islandReady.length < count) this.islandReady = new Uint8Array(2 * count);
    const ready = this.islandReady;
    ready.fill(1, 0, count);
    for (let index = 0; index < count; index++) {
      const body = bodies[index]!;
      if (body.isSleeping || !body.isMovable) ready[index] = 0;
      else if (!body.isReadyToSleep(timeToSleep) || keptAwake.has(body)) ready[rootOf(index)] = 0;
    }
    const islands = new Map<number, SolverBody[]>();
    for (let index = 0; index < count; index++) {
      const body = bodies[index]!;
      if (body.isSleeping || !body.isMovable) continue;
      const root = rootOf(index);
      if (!ready[root]) continue;
      let island = islands.get(root);
      if (!island) islands.set(root, (island = []));
      island.push(body);
    }
    for (const island of islands.values()) {
      for (const body of island) {
        body.sleep();
        body.sleepingIsland = island.length > 1 ? island : undefined;
      }
    }
  }

  /** The sets of awake bodies that joints tie together, each body mapped to its set. */
  private jointGroups(): Map<SolverBody, SolverBody[]> {
    const groups = new Map<SolverBody, SolverBody[]>();
    for (const constraint of this.constraintList) {
      const movable = (constraint.bodies ?? []).filter((body) => body.isMovable);
      if (movable.length < 2) continue;
      const merged = [...new Set(movable.flatMap((body) => groups.get(body) ?? [body]))];
      for (const body of merged) groups.set(body, merged);
    }
    return groups;
  }

  /**
   * The awake bodies tied, by touching or by joints, to one that won't sleep: one that may not, or
   * a kinematic body on the move. Found by spreading out from those through the bodies they touch.
   */
  private keptAwakeByContact(): Set<SolverBody> {
    const neighbours = new Map<SolverBody, SolverBody[]>();
    const link = (first: SolverBody, second: SolverBody) => {
      for (const [one, other] of [[first, second], [second, first]] as const) {
        const list = neighbours.get(one);
        if (list) list.push(other);
        else neighbours.set(one, [other]);
      }
    };
    const { touchingFirst, touchingSecond } = this.collisions;
    for (let index = 0; index < touchingFirst.length; index++) link(touchingFirst[index]!, touchingSecond[index]!);
    for (const constraint of this.constraintList) {
      const bodies = constraint.bodies ?? [];
      for (let index = 1; index < bodies.length; index++) link(bodies[0]!, bodies[index]!);
    }
    const sleepless = (body: SolverBody) => (body.isMovable && !body.source.canSleep) || (body.type === 'kinematic' && !body.isSleeping && (body.velocity.lengthSq() > 0 || body.angularVelocity.lengthSq() > 0));
    const kept = new Set<SolverBody>();
    const frontier = [...neighbours.keys()].filter(sleepless);
    for (const body of frontier) kept.add(body);
    while (frontier.length > 0) {
      const body = frontier.pop()!;
      for (const other of neighbours.get(body) ?? []) {
        if (kept.has(other) || !other.isMovable) continue;
        kept.add(other);
        frontier.push(other);
      }
    }
    return kept;
  }

  /** Bodies tied by a constraint sleep and wake together: a sleeping end would act like a wall. */
  private wakeJointPartners(): void {
    for (const constraint of this.constraints.values()) {
      const bodies = constraint.bodies;
      if (bodies?.some((body) => body.isSleeping) && bodies.some((body) => body.isMovable)) {
        for (const body of bodies) body.wakeUp();
      }
    }
  }

  /** The forces gathered for the step act through every substep; constraints run in each. */
  private runSubsteps(settings: StepSettings, colliding: boolean): void {
    const substep = settings.timestep / settings.substeps;
    const gravityStrength = settings.gravity.length();
    for (let substepIndex = 0; substepIndex < settings.substeps; substepIndex++) {
      for (const body of this.movingList) {
        beginSubstep(body);
        integrateBody(body, settings.gravity, substep);
      }
      for (const constraint of this.constraintList) constraint.solvePositions(substep);
      // contacts last, so nothing a joint does leaves bodies inside each other
      if (colliding) this.collisions.solvePositions(substep);
      for (const body of this.movingList) deriveVelocitiesIfCorrected(body, substep);
      for (const constraint of this.constraintList) constraint.solveVelocities?.(substep);
      if (colliding) this.collisions.solveVelocities(substep, gravityStrength);
    }
    for (const constraint of this.constraintList) constraint.finishStep?.(settings.timestep);
  }

  private solverBodyOf(body: Body): SolverBody {
    const solverBody = this.solverBodies.get(body);
    if (!solverBody) throw new EulerError('That body is not in this world');
    return solverBody;
  }
}
