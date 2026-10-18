import { Vector3 } from 'three';
import type { DistanceJoint } from '../../joints/DistanceJoint.js';
import type { SolverBody } from '../SolverBody.js';
import type { BodyTable } from './BodyTable.js';
import { makeSoft, RIGID } from './softness.js';
import type { Softness } from './softness.js';

/**
 * The distance joints of a step for the soft-step solver, one row per joint. A joint's anchors
 * are offsets from its bodies' centres of mass, worked out when the step begins and turned with
 * the bodies on every substep. The impulse each joint ends a step with is where it starts the
 * next, so a weight hanging still is held up from the first substep.
 */

const velocityA = new Float64Array(3);
const velocityB = new Float64Array(3);
const turned = new Float64Array(3);
const worldAnchor = new Vector3();

/** Writes into row `row` of `offsets` the anchor's offset from the body's centre of mass, or, without a body, the fixed point itself. */
function writeOffset(offsets: Float64Array, row: number, body: SolverBody | undefined, anchor: Vector3): void {
  const vector = 3 * row;
  if (!body) {
    offsets[vector] = anchor.x;
    offsets[vector + 1] = anchor.y;
    offsets[vector + 2] = anchor.z;
    return;
  }
  body.pointToWorld(anchor, worldAnchor).sub(body.worldCenterOfMass);
  offsets[vector] = worldAnchor.x;
  offsets[vector + 1] = worldAnchor.y;
  offsets[vector + 2] = worldAnchor.z;
}

export class JointTable {
  count = 0;
  private joints: DistanceJoint[] = [];
  private bodyA = new Int32Array(0);
  /** Body B's row, or -1 for a joint to a fixed point in the world. */
  private bodyB = new Int32Array(0);
  private anchorA = new Float64Array(0);
  /** Body B's anchor offset, or the fixed point itself without a body B. */
  private anchorB = new Float64Array(0);
  /** The anchors' offsets from their bodies' centres of mass now: the step's offsets turned with the bodies. */
  private armA = new Float64Array(0);
  private armB = new Float64Array(0);
  /** Unit vector from B's anchor to A's, as of the last time it was measured. */
  private direction = new Float64Array(0);
  /** The spring's softness, for joints with compliance. */
  private springs: (Softness | undefined)[] = [];
  private impulse = new Float64Array(0);
  /** Impulse each joint started the step with: what it ended the last one with. */
  private readonly carried = new Map<DistanceJoint, number>();

  /** Rows for the joints, each with its bodies and the impulse it ended the last step with. */
  prepare(joints: ReadonlyMap<DistanceJoint, readonly [SolverBody, SolverBody | undefined]>, bodies: BodyTable, substep: number): void {
    this.count = joints.size;
    if (this.impulse.length < this.count) this.grow(Math.max(this.count, 2 * this.impulse.length, 16));
    this.joints.length = this.count;
    let row = 0;
    for (const [joint, [solverA, solverB]] of joints) {
      this.joints[row] = joint;
      this.bodyA[row] = bodies.indexOf.get(solverA)!;
      this.bodyB[row] = solverB ? bodies.indexOf.get(solverB)! : -1;
      writeOffset(this.anchorA, row, solverA, joint.anchorA);
      if (solverB) writeOffset(this.anchorB, row, solverB, joint.anchorB);
      else writeOffset(this.anchorB, row, undefined, joint.anchorB);
      this.turnArms(bodies, row);
      this.measure(bodies, row);
      this.springs[row] = joint.compliance > 0 ? this.springSoftness(bodies, row, joint, substep) : undefined;
      this.impulse[row] = this.carried.get(joint) ?? 0;
      row++;
    }
  }

  /** Turns every joint's anchors with its bodies, after the bodies have moved. */
  updateArms(bodies: BodyTable): void {
    for (let row = 0; row < this.count; row++) this.turnArms(bodies, row);
  }

  warmStart(bodies: BodyTable): void {
    for (let row = 0; row < this.count; row++) {
      const impulse = this.impulse[row]!;
      if (impulse === 0) continue;
      this.measure(bodies, row);
      this.applyAlongJoint(bodies, row, impulse);
    }
  }

  /**
   * One pass over the joints. With `softness` a rigid joint pulls its anchors back to its length
   * as a stiff spring; without it (the relaxing pass) it only stops them moving apart. A joint
   * with compliance is the same spring on both passes.
   */
  solve(bodies: BodyTable, substep: number, softness: Softness | undefined): void {
    for (let row = 0; row < this.count; row++) {
      const joint = this.joints[row]!;
      const distance = this.measure(bodies, row);
      const error = distance - joint.length;
      const spring = this.springs[row];
      let bias: number;
      let massScale = 1;
      let impulseScale = 0;
      if (joint.slack && error < 0) {
        // slack: let the anchors come no further apart than the length by the end of the substep
        bias = error / substep;
      } else {
        const soft = spring ?? softness ?? RIGID;
        bias = soft.biasRate * error;
        massScale = soft.massScale;
        impulseScale = soft.impulseScale;
      }
      const inverseMass = this.inverseMassAlongJoint(bodies, row);
      if (inverseMass === 0) continue;
      const speed = this.speedApart(bodies, row);
      const change = (-massScale * (speed + bias)) / inverseMass - impulseScale * this.impulse[row]!;
      let impulse = this.impulse[row]! + change;
      // a rope only pulls
      if (joint.slack) impulse = Math.min(impulse, 0);
      const applied = impulse - this.impulse[row]!;
      this.impulse[row] = impulse;
      if (applied !== 0) this.applyAlongJoint(bodies, row, applied);
    }
  }

  /** Forgets the impulse of a joint that has been taken out. */
  forget(joint: DistanceJoint): void {
    this.carried.delete(joint);
  }

  /** Writes each joint's tension, and keeps its impulse for the next step. */
  finish(substep: number): void {
    for (let row = 0; row < this.count; row++) {
      const joint = this.joints[row]!;
      joint.tension = Math.max(-this.impulse[row]! / substep, joint.slack ? 0 : -Infinity);
      this.carried.set(joint, this.impulse[row]!);
    }
  }

  private turnArms(bodies: BodyTable, row: number): void {
    const vector = 3 * row;
    bodies.turnedSinceStart(this.bodyA[row]!, this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!, turned);
    this.armA[vector] = turned[0]!;
    this.armA[vector + 1] = turned[1]!;
    this.armA[vector + 2] = turned[2]!;
    if (this.bodyB[row]! < 0) return;
    bodies.turnedSinceStart(this.bodyB[row]!, this.anchorB[vector]!, this.anchorB[vector + 1]!, this.anchorB[vector + 2]!, turned);
    this.armB[vector] = turned[0]!;
    this.armB[vector + 1] = turned[1]!;
    this.armB[vector + 2] = turned[2]!;
  }

  /** Measures the anchors as they are now: writes the direction between them, and returns the distance. */
  private measure(bodies: BodyTable, row: number): number {
    const vector = 3 * row;
    const indexA = this.bodyA[row]!;
    const indexB = this.bodyB[row]!;
    let gapX = bodies.centers[3 * indexA]! + this.armA[vector]!;
    let gapY = bodies.centers[3 * indexA + 1]! + this.armA[vector + 1]!;
    let gapZ = bodies.centers[3 * indexA + 2]! + this.armA[vector + 2]!;
    if (indexB >= 0) {
      gapX -= bodies.centers[3 * indexB]! + this.armB[vector]!;
      gapY -= bodies.centers[3 * indexB + 1]! + this.armB[vector + 1]!;
      gapZ -= bodies.centers[3 * indexB + 2]! + this.armB[vector + 2]!;
    } else {
      gapX -= this.anchorB[vector]!;
      gapY -= this.anchorB[vector + 1]!;
      gapZ -= this.anchorB[vector + 2]!;
    }
    const distance = Math.sqrt(gapX * gapX + gapY * gapY + gapZ * gapZ);
    // keep the last direction if the anchors meet
    if (distance > 1e-12) {
      this.direction[vector] = gapX / distance;
      this.direction[vector + 1] = gapY / distance;
      this.direction[vector + 2] = gapZ / distance;
    }
    return distance;
  }

  /** How hard the joint's bodies are to move apart along it, as last measured. */
  private inverseMassAlongJoint(bodies: BodyTable, row: number): number {
    const vector = 3 * row;
    const directionX = this.direction[vector]!;
    const directionY = this.direction[vector + 1]!;
    const directionZ = this.direction[vector + 2]!;
    let inverseMass = bodies.inverseMassAlong(this.bodyA[row]!, this.armA[vector]!, this.armA[vector + 1]!, this.armA[vector + 2]!, directionX, directionY, directionZ);
    if (this.bodyB[row]! >= 0) inverseMass += bodies.inverseMassAlong(this.bodyB[row]!, this.armB[vector]!, this.armB[vector + 1]!, this.armB[vector + 2]!, directionX, directionY, directionZ);
    return inverseMass;
  }

  /** How fast the anchors move apart along the joint, as last measured. */
  private speedApart(bodies: BodyTable, row: number): number {
    const vector = 3 * row;
    bodies.pointVelocity(this.bodyA[row]!, this.armA[vector]!, this.armA[vector + 1]!, this.armA[vector + 2]!, velocityA);
    let speedX = velocityA[0]!;
    let speedY = velocityA[1]!;
    let speedZ = velocityA[2]!;
    if (this.bodyB[row]! >= 0) {
      bodies.pointVelocity(this.bodyB[row]!, this.armB[vector]!, this.armB[vector + 1]!, this.armB[vector + 2]!, velocityB);
      speedX -= velocityB[0]!;
      speedY -= velocityB[1]!;
      speedZ -= velocityB[2]!;
    }
    return speedX * this.direction[vector]! + speedY * this.direction[vector + 1]! + speedZ * this.direction[vector + 2]!;
  }

  /** Pushes A's anchor by `impulse` along the joint's direction, and B's by the opposite, as last measured. */
  private applyAlongJoint(bodies: BodyTable, row: number, impulse: number): void {
    const vector = 3 * row;
    const impulseX = this.direction[vector]! * impulse;
    const impulseY = this.direction[vector + 1]! * impulse;
    const impulseZ = this.direction[vector + 2]! * impulse;
    bodies.applyImpulse(this.bodyA[row]!, impulseX, impulseY, impulseZ, this.armA[vector]!, this.armA[vector + 1]!, this.armA[vector + 2]!);
    if (this.bodyB[row]! >= 0) bodies.applyImpulse(this.bodyB[row]!, -impulseX, -impulseY, -impulseZ, this.armB[vector]!, this.armB[vector + 1]!, this.armB[vector + 2]!);
  }

  /**
   * A spring of stiffness k = 1 / compliance as a soft constraint, for the mass m the joint moves
   * along its line: frequency ω = √(k / m), and damping ratio d / 2ω for the joint's damping d,
   * the rate at which motion along it dies out.
   */
  private springSoftness(bodies: BodyTable, row: number, joint: DistanceJoint, substep: number): Softness {
    const angularFrequency = Math.sqrt(this.inverseMassAlongJoint(bodies, row) / joint.compliance);
    if (angularFrequency === 0) return RIGID;
    return makeSoft(angularFrequency / (2 * Math.PI), joint.damping / (2 * angularFrequency), substep);
  }

  private grow(capacity: number): void {
    this.bodyA = new Int32Array(capacity);
    this.bodyB = new Int32Array(capacity);
    this.anchorA = new Float64Array(3 * capacity);
    this.anchorB = new Float64Array(3 * capacity);
    this.direction = new Float64Array(3 * capacity);
    this.armA = new Float64Array(3 * capacity);
    this.armB = new Float64Array(3 * capacity);
    this.impulse = new Float64Array(capacity);
  }
}
