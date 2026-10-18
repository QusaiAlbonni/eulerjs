import { Vector3 } from 'three';
import type { Contact } from '../../backend.js';
import type { Collider } from '../../colliders/Collider.js';
import {
  angularInverseMass,
  applyAngularPositionalImpulse,
  applyAngularVelocityImpulse,
  applyVelocityImpulse,
  correctPosition,
  generalizedInverseMass,
  rotationSinceSubstepStart,
} from '../positional.js';
import type { SolverBody } from '../SolverBody.js';
import { anchorFor } from './contactAnchors.js';
import { rollingRadius } from './round.js';
import type { ContactAnchor } from './contactAnchors.js';
import type { ContactPoint } from './narrowphase.js';

const pointA = new Vector3();
const pointB = new Vector3();
const startA = new Vector3();
const startB = new Vector3();
const nowA = new Vector3();
const nowB = new Vector3();
const relativeMotion = new Vector3();
const motionB = new Vector3();
const tangent = new Vector3();
const velocityA = new Vector3();
const velocityB = new Vector3();
const impulse = new Vector3();
const rollingSpin = new Vector3();
const rollingImpulse = new Vector3();
const turnA = new Vector3();
const turnB = new Vector3();

/**
 * One touching point between two bodies, solved like a joint that only pushes. It is found once
 * per step, with its normal fixed for the step; each substep re-measures how deep it is where it
 * is anchored on the two bodies (see ContactAnchor).
 */
export class ContactConstraint {
  readonly point = new Vector3();
  readonly normal: Vector3;
  readonly depth: number;
  /** Impulse along the normal on the current substep. */
  normalImpulse = 0;
  /** Impulse along the normal summed over the step so far. */
  stepImpulse = 0;
  private readonly anchorA: ContactAnchor;
  private readonly anchorB: ContactAnchor;
  private readonly worldPointA = new Vector3();
  private readonly worldPointB = new Vector3();
  /** Coulomb coefficient for this pair of colliders. */
  readonly friction: number;
  private readonly restitution: number;
  /** Rolling resistance times the radius of the round collider that rolls: the most torque per unit of normal force. */
  private readonly rollingTorqueArm: number;
  /** Speed along the normal when the contact first touched, for restitution. */
  private normalSpeedBefore: number;
  private touched = false;
  /** Both bodies' generalized inverse masses along the normal, worked out once for the step. */
  private readonly normalInverseMass: number;
  /** Positional impulse along the normal on this substep; 0 if the contact didn't push. */
  private substepCorrection = 0;
  /** The slide slideImpulse last measured, kept for removeSlide to use when nothing has moved since. */
  private readonly measuredDirection = new Vector3();
  private measuredSlide = 0;
  private measuredInverseMass = 0;
  private slideIsFresh = false;

  constructor(
    readonly bodyA: SolverBody,
    readonly bodyB: SolverBody,
    readonly colliderA: Collider,
    readonly colliderB: Collider,
    contactPoint: ContactPoint,
  ) {
    this.normal = contactPoint.normal;
    this.depth = contactPoint.depth;
    // the normal points from B toward A, so A's side faces against it
    this.anchorA = anchorFor(bodyA, colliderA, contactPoint.pointA, this.normal.clone().negate());
    this.anchorB = anchorFor(bodyB, colliderB, contactPoint.pointB, this.normal);
    this.friction = Math.sqrt(colliderA.friction * colliderB.friction);
    this.restitution = Math.max(colliderA.restitution, colliderB.restitution);
    this.rollingTorqueArm = Math.max(colliderA.rollingResistance, colliderB.rollingResistance) * (rollingRadius(colliderA) ?? rollingRadius(colliderB) ?? 0);
    this.normalSpeedBefore = this.relativeVelocity(contactPoint.pointA, contactPoint.pointB).dot(this.normal);
    this.normalInverseMass = this.inverseMassAlong(this.normal, contactPoint.pointA, contactPoint.pointB);
  }

  /** Forgets what the contact did on the previous substep. */
  beginSubstep(): void {
    this.substepCorrection = 0;
    this.normalImpulse = 0;
  }

  /** Pushes the bodies apart along the normal until they no longer overlap at this contact. */
  separate(substep: number): void {
    this.anchorA.current(pointA);
    this.anchorB.current(pointB);
    const depth = relativeMotion.subVectors(pointB, pointA).dot(this.normal);
    if (depth <= 0) return;
    if (!this.touched) {
      // The contact was found up to a step early; the impact speed is the speed as it first touches.
      this.touched = true;
      this.normalSpeedBefore = this.relativeVelocity(pointA, pointB).dot(this.normal);
    }
    this.substepCorrection += correctPosition(
      { bodyA: this.bodyA, pointA, bodyB: this.bodyB, pointB, direction: this.normal, error: -depth, inverseMass: this.normalInverseMass },
      substep,
    );
    this.point.addVectors(pointA, pointB).multiplyScalar(0.5);
  }

  /** Positional impulse along the normal on this substep, in kg·m; 0 if the contact didn't push. */
  get normalCorrection(): number {
    return this.substepCorrection;
  }

  /** Writes the point midway between where the contact is on the two bodies now. */
  midpoint(target: Vector3): Vector3 {
    this.anchorA.current(pointA);
    this.anchorB.current(pointB);
    return target.addVectors(pointA, pointB).multiplyScalar(0.5);
  }

  /** The positional impulse it would take to undo how far the touching points slid along each other this substep. */
  slideImpulse(): number {
    this.measuredSlide = this.measureSlide();
    this.measuredInverseMass = this.measuredSlide === 0 ? 0 : this.inverseMassAlong(tangent, pointA, pointB);
    this.measuredDirection.copy(tangent);
    this.slideIsFresh = true;
    return this.measuredInverseMass === 0 ? 0 : this.measuredSlide / this.measuredInverseMass;
  }

  /**
   * Static friction, once its patch has found it can hold: puts the touching points back where
   * they started. Reuses the slide slideImpulse just measured if nothing has moved since.
   */
  removeSlide(substep: number): void {
    if (this.substepCorrection <= 0) return;
    if (this.slideIsFresh) {
      this.slideIsFresh = false;
      if (this.measuredInverseMass === 0) return;
      this.anchorA.current(pointA);
      this.anchorB.current(pointB);
      correctPosition(
        { bodyA: this.bodyA, pointA, bodyB: this.bodyB, pointB, direction: this.measuredDirection, error: this.measuredSlide, inverseMass: this.measuredInverseMass },
        substep,
      );
      return;
    }
    const slide = this.measureSlide();
    if (slide === 0) return;
    correctPosition({ bodyA: this.bodyA, pointA, bodyB: this.bodyB, pointB, direction: tangent, error: slide }, substep);
  }

  /**
   * Sets the speed along the normal: bouncing back with a share of the impact speed, or, for
   * slow contacts (about as fast as gravity accelerates things in two substeps), none at all.
   */
  settleNormalSpeed(substep: number, gravityStrength: number): void {
    if (this.substepCorrection <= 0) return;
    this.normalImpulse = this.substepCorrection / substep;
    // positions don't change in the velocity pass, so resistSliding reuses these points
    this.anchorA.current(this.worldPointA);
    this.anchorB.current(this.worldPointB);
    pointA.copy(this.worldPointA);
    pointB.copy(this.worldPointB);
    const normalSpeed = this.relativeVelocity(pointA, pointB).dot(this.normal);
    const restitution = Math.abs(this.normalSpeedBefore) > 2 * gravityStrength * substep ? this.restitution : 0;
    const targetSpeed = Math.max(-restitution * this.normalSpeedBefore, 0);
    if (this.normalInverseMass === 0) return;
    const speedImpulse = (targetSpeed - normalSpeed) / this.normalInverseMass;
    this.applyVelocityImpulse(impulse.copy(this.normal).multiplyScalar(speedImpulse));
    // the contact's real push is the position correction plus this, which can pull back a little
    this.normalImpulse = Math.max(0, this.normalImpulse + speedImpulse);
  }

  /** Sliding friction: an impulse against the sliding, at most friction × the net normal impulse. */
  resistSliding(): void {
    if (this.normalImpulse <= 0) return;
    pointA.copy(this.worldPointA);
    pointB.copy(this.worldPointB);
    const relative = this.relativeVelocity(pointA, pointB);
    tangent.copy(relative).addScaledVector(this.normal, -relative.dot(this.normal));
    const tangentSpeed = tangent.length();
    if (tangentSpeed < 1e-9) return;
    tangent.divideScalar(tangentSpeed);
    const inverseMass = this.inverseMassAlong(tangent);
    if (inverseMass === 0) return;
    const frictionImpulse = Math.min(this.friction * this.normalImpulse, tangentSpeed / inverseMass);
    this.applyVelocityImpulse(impulse.copy(tangent).multiplyScalar(-frictionImpulse));
  }

  /**
   * How far the touching material points slid along each other this substep. Leaves the points
   * where the contact is now in `pointA` and `pointB`, and the direction of the slide in `tangent`.
   */
  private measureSlide(): number {
    this.anchorA.current(pointA);
    this.anchorB.current(pointB);
    this.anchorA.materialMotion(startA, nowA);
    this.anchorB.materialMotion(startB, nowB);
    motionB.subVectors(nowB, startB);
    relativeMotion.subVectors(nowA, startA).sub(motionB);
    relativeMotion.addScaledVector(this.normal, -relativeMotion.dot(this.normal));
    const slide = relativeMotion.length();
    if (slide < 1e-12) return 0;
    tangent.copy(relativeMotion).divideScalar(slide);
    return slide;
  }

  /**
   * Holds the bodies from rolling over each other, or spinning on the spot, this substep if
   * rolling resistance can: turns them back by how far they turned, when that takes less torque
   * than the rolling resistance times the radius times the normal correction. The rolling
   * counterpart of static friction.
   */
  holdRolling(): void {
    if (this.rollingTorqueArm === 0 || this.substepCorrection <= 0) return;
    rotationSinceSubstepStart(this.bodyA, turnA);
    rotationSinceSubstepStart(this.bodyB, turnB);
    rollingSpin.subVectors(turnA, turnB);
    const angle = rollingSpin.length();
    if (angle < 1e-12) return;
    rollingSpin.divideScalar(angle);
    const inverseInertia = angularInverseMass(this.bodyA, rollingSpin) + angularInverseMass(this.bodyB, rollingSpin);
    if (inverseInertia === 0) return;
    const angularImpulse = angle / inverseInertia;
    if (angularImpulse > this.rollingTorqueArm * this.substepCorrection) return;
    applyAngularPositionalImpulse(this.bodyA, rollingImpulse.copy(rollingSpin).multiplyScalar(-angularImpulse));
    applyAngularPositionalImpulse(this.bodyB, rollingImpulse.negate());
  }

  /**
   * Rolling resistance: an angular impulse against the two bodies rolling over each other or
   * spinning on the spot, at most the rolling resistance times the radius times the net normal
   * impulse. A real contact is a small patch, which resists both; a ball that only spun would
   * otherwise never come to rest.
   */
  resistRolling(): void {
    if (this.rollingTorqueArm === 0 || this.normalImpulse <= 0) return;
    rollingSpin.subVectors(this.bodyA.angularVelocity, this.bodyB.angularVelocity);
    const spin = rollingSpin.length();
    if (spin < 1e-9) return;
    rollingSpin.divideScalar(spin);
    const inverseInertia = angularInverseMass(this.bodyA, rollingSpin) + angularInverseMass(this.bodyB, rollingSpin);
    if (inverseInertia === 0) return;
    const angularImpulse = Math.min(spin / inverseInertia, this.rollingTorqueArm * this.normalImpulse);
    applyAngularVelocityImpulse(this.bodyA, rollingImpulse.copy(rollingSpin).multiplyScalar(-angularImpulse));
    applyAngularVelocityImpulse(this.bodyB, rollingImpulse.negate());
  }

  private relativeVelocity(worldPointA: Vector3, worldPointB: Vector3): Vector3 {
    this.bodyA.pointVelocity(worldPointA, velocityA);
    this.bodyB.pointVelocity(worldPointB, velocityB);
    return velocityA.sub(velocityB);
  }

  private inverseMassAlong(direction: Vector3, worldPointA = pointA, worldPointB = pointB): number {
    return generalizedInverseMass(this.bodyA, worldPointA, direction) + generalizedInverseMass(this.bodyB, worldPointB, direction);
  }

  /** Adds this substep's normal impulse to the step's total; call once each substep is solved. */
  accumulateImpulse(): void {
    this.stepImpulse += this.normalImpulse;
  }

  /** What the contact did over the step, reported with the bodies the solver bodies stand for. */
  report(): Contact {
    return {
      bodyA: this.bodyA.source,
      bodyB: this.bodyB.source,
      colliderA: this.colliderA,
      colliderB: this.colliderB,
      point: this.point.clone(),
      normal: this.normal.clone(),
      depth: this.depth,
      normalImpulse: this.stepImpulse,
    };
  }

  private applyVelocityImpulse(impulseOnA: Vector3): void {
    applyVelocityImpulse(this.bodyA, impulseOnA, pointA);
    applyVelocityImpulse(this.bodyB, impulseOnA.negate(), pointB);
  }
}
