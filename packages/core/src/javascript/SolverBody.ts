import { Quaternion, Vector3 } from 'three';
import type { Body } from '../Body.js';
import type { Collider } from '../colliders/Collider.js';
import { RigidBodyState } from '../RigidBodyState.js';
import type { SubstepState } from './positional.js';

/** A body that stays this close to one place, in metres and radians, counts as still. */
const IN_PLACE_DISTANCE = 0.002;
const IN_PLACE_ANGLE = (0.5 * Math.PI) / 180;

/**
 * The JavaScript backend's copy of a body: the state the solver moves. Settings such as damping
 * and the colliders are read from the body it simulates, so they are never out of date.
 */
export class SolverBody extends RigidBodyState {
  /** Force accumulated for the current step, in world space. */
  readonly force = new Vector3();
  /** Torque about the centre of mass accumulated for the current step, in world space. */
  readonly torque = new Vector3();

  /** Where the body was when the current substep began; set by beginSubstep, undefined before the first. */
  substepStart: SubstepState | undefined;

  /**
   * Whether the bounds the collision system keeps for this body may be out of date. Static and
   * sleeping bodies don't move, so their bounds are kept until this is set: when the body is
   * moved, changes shape or wakes.
   */
  boundsStale = true;
  /** Goes up whenever the mass properties change, so copies of them know to refresh. */
  massVersion = 0;
  /** Bodies this one doesn't collide with, and how many joints say so. */
  private readonly ignoredBodies = new Map<SolverBody, number>();
  private asleep: boolean;
  /** How long the body has been still, in seconds. */
  private stillTime = 0;
  /** Where the body was when it last moved; it counts as still while it stays close to this. */
  private readonly restingPosition = new Vector3();
  private readonly restingQuaternion = new Quaternion();

  constructor(readonly source: Body) {
    super(source.type);
    this.copyMassFrom(source);
    this.copyPoseFrom(source);
    this.copyVelocityFrom(source);
    this.asleep = source.isSleeping;
  }

  get colliders(): readonly Collider[] {
    return this.source.colliders;
  }

  get linearDamping(): number {
    return this.source.linearDamping;
  }

  get angularDamping(): number {
    return this.source.angularDamping;
  }

  get gravityScale(): number {
    return this.source.gravityScale;
  }

  get isSleeping(): boolean {
    return this.asleep;
  }

  /** True for dynamic bodies that are awake: the ones the solver can move. */
  get isMovable(): boolean {
    return this.isDynamic && !this.asleep;
  }

  copyMassFrom(body: Body): void {
    // called when the mass properties or the colliders change
    this.boundsStale = true;
    this.massVersion++;
    if (body.massProperties) this.assignMassProperties(body.massProperties);
    this.refreshDerivedState();
  }

  copyPoseFrom(body: Body): void {
    this.boundsStale = true;
    this.position.copy(body.position);
    this.quaternion.copy(body.quaternion);
    this.restingPosition.copy(this.position);
    this.restingQuaternion.copy(this.quaternion);
    this.refreshDerivedState();
  }

  copyVelocityFrom(body: Body): void {
    this.velocity.copy(body.velocity);
    this.angularVelocity.copy(body.angularVelocity);
  }

  /** Stops this body colliding with `other`, until as many calls to `collideAgainWith`. */
  ignoreCollisionsWith(other: SolverBody): void {
    this.ignoredBodies.set(other, (this.ignoredBodies.get(other) ?? 0) + 1);
  }

  collideAgainWith(other: SolverBody): void {
    const count = this.ignoredBodies.get(other) ?? 0;
    if (count <= 1) this.ignoredBodies.delete(other);
    else this.ignoredBodies.set(other, count - 1);
  }

  ignoresCollisionsWith(other: SolverBody): boolean {
    return this.ignoredBodies.has(other);
  }

  wakeUp(): void {
    this.boundsStale = true;
    this.asleep = false;
    this.stillTime = 0;
    this.restingPosition.copy(this.position);
    this.restingQuaternion.copy(this.quaternion);
  }

  sleep(): void {
    if (!this.isDynamic) return;
    this.asleep = true;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
  }

  /**
   * Counts how long the body has been still: slower than `speed` (m/s) and `spin` (rad/s), or
   * staying within a hair of one place, however fast its velocity says it moves. The solver
   * works velocities out from small corrections to positions, so a body held by several joints
   * and contacts can tremble in place by a fraction of a millimetre with a velocity that looks
   * lively; it should still fall asleep.
   */
  updateStillness(timestep: number, speed: number, spin: number): void {
    if (!this.isMovable) return;
    const slow = this.velocity.lengthSq() < speed * speed && this.angularVelocity.lengthSq() < spin * spin;
    const inPlace =
      this.restingPosition.distanceToSquared(this.position) < IN_PLACE_DISTANCE ** 2 && this.restingQuaternion.angleTo(this.quaternion) < IN_PLACE_ANGLE;
    if (!inPlace) {
      this.restingPosition.copy(this.position);
      this.restingQuaternion.copy(this.quaternion);
    }
    this.stillTime = slow || inPlace ? this.stillTime + timestep : 0;
  }

  /** Whether the body was still on the last step: slow, or staying where it was. */
  get isStill(): boolean {
    return this.stillTime > 0;
  }

  /** Whether the body may sleep and has been still for `timeToSleep` seconds. */
  isReadyToSleep(timeToSleep: number): boolean {
    return this.isMovable && this.source.canSleep && this.stillTime >= timeToSleep;
  }

  clearForces(): void {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /**
   * Renormalises the quaternion, against rounding drift, and recomputes the matrix, world centre
   * of mass and world inverse inertia from the pose.
   */
  updateDerivedState(): void {
    this.quaternion.normalize();
    this.refreshDerivedState();
  }

  /**
   * Renormalises the quaternion and recomputes only the world centre of mass. The solver uses
   * this after each small correction: within a substep a body turns so little that refreshing the
   * matrix and world inverse inertia once per substep is enough.
   */
  updatePoseState(): void {
    this.quaternion.normalize();
    this.refreshCenterOfMass();
  }
}
