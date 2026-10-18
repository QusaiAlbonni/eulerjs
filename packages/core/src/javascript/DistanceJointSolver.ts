import { Vector3 } from 'three';
import type { DistanceJoint } from '../joints/DistanceJoint.js';
import type { Constraint } from './Constraint.js';
import { applyVelocityImpulse, correctPosition, generalizedInverseMass } from './positional.js';
import type { SolverBody } from './SolverBody.js';

const pointA = new Vector3();
const pointB = new Vector3();
const velocityA = new Vector3();
const velocityB = new Vector3();
const impulse = new Vector3();

/** Solves a DistanceJoint, reading its settings every substep and writing its tension back. */
export class DistanceJointSolver implements Constraint {
  readonly bodies: readonly SolverBody[];
  private readonly direction = new Vector3();
  private taut = false;

  constructor(
    private readonly joint: DistanceJoint,
    private readonly bodyA: SolverBody,
    private readonly bodyB: SolverBody | undefined,
  ) {
    this.bodies = bodyB ? [bodyA, bodyB] : [bodyA];
  }

  solvePositions(substep: number): void {
    const distance = this.measureAnchors();
    const error = distance - this.joint.length;
    this.taut = distance > 1e-12 && !(this.joint.slack && error <= 0);
    if (!this.taut) {
      this.joint.tension = 0;
      return;
    }
    this.direction.subVectors(pointA, pointB).divideScalar(distance);
    const impulseMagnitude = correctPosition(
      { bodyA: this.bodyA, pointA, bodyB: this.bodyB, pointB, direction: this.direction, error, compliance: this.joint.compliance },
      substep,
    );
    this.joint.tension = -impulseMagnitude / (substep * substep);
  }

  /** Reports the tension as the force on body B, toward body A; or, for a joint to the world, on body A toward its fixed point. */
  finishStep(): void {
    this.joint.force.copy(this.direction).multiplyScalar(this.taut ? (this.bodyB ? 1 : -1) * this.joint.tension : 0);
    this.joint.torque.set(0, 0, 0);
  }

  solveVelocities(substep: number): void {
    const damping = this.joint.damping;
    if (!this.taut || damping <= 0) return;
    this.measureAnchors();
    const closingSpeed = this.relativeVelocityAlongJoint();
    const inverseMassA = generalizedInverseMass(this.bodyA, pointA, this.direction);
    const inverseMassB = this.bodyB ? generalizedInverseMass(this.bodyB, pointB, this.direction) : 0;
    if (inverseMassA + inverseMassB === 0) return;
    const speedChange = -closingSpeed * Math.min(damping * substep, 1);
    impulse.copy(this.direction).multiplyScalar(speedChange / (inverseMassA + inverseMassB));
    applyVelocityImpulse(this.bodyA, impulse, pointA);
    if (this.bodyB) applyVelocityImpulse(this.bodyB, impulse.negate(), pointB);
  }

  /** Puts the anchors' world positions in `pointA` and `pointB` and returns the distance between them. */
  private measureAnchors(): number {
    this.bodyA.pointToWorld(this.joint.anchorA, pointA);
    if (this.bodyB) this.bodyB.pointToWorld(this.joint.anchorB, pointB);
    else pointB.copy(this.joint.anchorB);
    return pointA.distanceTo(pointB);
  }

  private relativeVelocityAlongJoint(): number {
    this.bodyA.pointVelocity(pointA, velocityA);
    if (this.bodyB) this.bodyB.pointVelocity(pointB, velocityB);
    else velocityB.set(0, 0, 0);
    return velocityA.sub(velocityB).dot(this.direction);
  }
}
