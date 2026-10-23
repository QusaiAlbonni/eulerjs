import { invertSymmetric } from '../../joints/sixDofMath.js';
import type { BodyTable } from './BodyTable.js';
import { RIGID } from './softness.js';
import type { Softness } from './softness.js';

/**
 * The ball joints of a step that are nothing more (every angle free, nothing driving them or
 * holding them back), in flat arrays, one after another: each holds the point where its two
 * frames' origins meet as one block, as `SixDofTable` holds any joint's point, and that is all
 * there is to solve for them. A net or a chain of thousands of them is mostly this loop.
 */
export class BallJointTable {
  count = 0;
  /** The bodies, or -1 for a joint to the world, whose anchor is then fixed at `worldAnchors`. */
  private indexA = new Int32Array(0);
  private indexB = new Int32Array(0);
  /** The frames' origins as offsets from the centres of mass when the step began, in world space: A's, then B's. */
  private startArms = new Float64Array(0);
  /** The offsets and origins as measured on this substep, A's then B's. */
  private arms = new Float64Array(0);
  private points = new Float64Array(0);
  private worldAnchors = new Float64Array(0);
  /** The impulse each holds its point with, and the inverse of its point's effective inverse mass. */
  private impulses = new Float64Array(0);
  private masses = new Float64Array(0);

  /** Room for `count` joints, the old impulses kept. */
  reset(count: number): void {
    if (this.indexA.length < count) {
      const capacity = Math.max(count, 2 * this.indexA.length, 32);
      this.indexA = new Int32Array(capacity);
      this.indexB = new Int32Array(capacity);
      this.startArms = new Float64Array(6 * capacity);
      this.arms = new Float64Array(6 * capacity);
      this.points = new Float64Array(6 * capacity);
      this.worldAnchors = new Float64Array(3 * capacity);
      this.impulses = new Float64Array(3 * capacity);
      this.masses = new Float64Array(6 * capacity);
    }
    this.count = 0;
  }

  /** Adds a joint: its bodies, its frames' origins' offsets when the step began, where its world anchor is, and the impulse it ended the last step with. */
  add(indexA: number, indexB: number, startArmA: { x: number; y: number; z: number }, startArmB: { x: number; y: number; z: number }, worldAnchor: { x: number; y: number; z: number }, impulse: Float64Array): number {
    const joint = this.count++;
    this.indexA[joint] = indexA;
    this.indexB[joint] = indexB;
    const six = 6 * joint;
    this.startArms[six] = startArmA.x;
    this.startArms[six + 1] = startArmA.y;
    this.startArms[six + 2] = startArmA.z;
    this.startArms[six + 3] = startArmB.x;
    this.startArms[six + 4] = startArmB.y;
    this.startArms[six + 5] = startArmB.z;
    const three = 3 * joint;
    this.worldAnchors[three] = worldAnchor.x;
    this.worldAnchors[three + 1] = worldAnchor.y;
    this.worldAnchors[three + 2] = worldAnchor.z;
    this.impulses[three] = impulse[0]!;
    this.impulses[three + 1] = impulse[1]!;
    this.impulses[three + 2] = impulse[2]!;
    return joint;
  }

  /** Measures every joint, works out its point's mass for the substep, and applies the impulse it ended the last one with. */
  warmStart(bodies: BodyTable): void {
    for (let joint = 0; joint < this.count; joint++) {
      this.measure(bodies, joint);
      this.preparePoint(bodies, joint);
      const three = 3 * joint;
      const impulseX = this.impulses[three]!;
      const impulseY = this.impulses[three + 1]!;
      const impulseZ = this.impulses[three + 2]!;
      if (impulseX !== 0 || impulseY !== 0 || impulseZ !== 0) this.applyPoint(bodies, joint, impulseX, impulseY, impulseZ);
    }
  }

  /**
   * One pass: with `softness`, the biased one, straight after the warm start, before anything
   * has moved, so with its measurements; without, the relaxing one, after the bodies have moved.
   */
  solve(bodies: BodyTable, softness: Softness | undefined): void {
    const soft = softness ?? RIGID;
    for (let joint = 0; joint < this.count; joint++) {
      if (!softness) this.measure(bodies, joint);
      this.solvePoint(bodies, joint, soft);
    }
  }

  /** Joint `joint`'s impulse now, into `target`'s first three slots: what it holds its point with, kept for the next step and reported as its load. */
  impulseInto(joint: number, target: Float64Array): void {
    const three = 3 * joint;
    target[0] = this.impulses[three]!;
    target[1] = this.impulses[three + 1]!;
    target[2] = this.impulses[three + 2]!;
  }

  private measure(bodies: BodyTable, joint: number): void {
    const six = 6 * joint;
    const indexA = this.indexA[joint]!;
    const indexB = this.indexB[joint]!;
    const arms = this.arms;
    const points = this.points;
    const startArms = this.startArms;
    const centers = bodies.centers;
    if (indexA >= 0) {
      bodies.turnedSinceStart(indexA, startArms[six]!, startArms[six + 1]!, startArms[six + 2]!, turned);
      arms[six] = turned[0]!;
      arms[six + 1] = turned[1]!;
      arms[six + 2] = turned[2]!;
      points[six] = centers[3 * indexA]! + turned[0]!;
      points[six + 1] = centers[3 * indexA + 1]! + turned[1]!;
      points[six + 2] = centers[3 * indexA + 2]! + turned[2]!;
    } else {
      const three = 3 * joint;
      points[six] = this.worldAnchors[three]!;
      points[six + 1] = this.worldAnchors[three + 1]!;
      points[six + 2] = this.worldAnchors[three + 2]!;
    }
    bodies.turnedSinceStart(indexB, startArms[six + 3]!, startArms[six + 4]!, startArms[six + 5]!, turned);
    arms[six + 3] = turned[0]!;
    arms[six + 4] = turned[1]!;
    arms[six + 5] = turned[2]!;
    points[six + 3] = centers[3 * indexB]! + turned[0]!;
    points[six + 4] = centers[3 * indexB + 1]! + turned[1]!;
    points[six + 5] = centers[3 * indexB + 2]! + turned[2]!;
  }

  private preparePoint(bodies: BodyTable, joint: number): void {
    const six = 6 * joint;
    const arms = this.arms;
    inverseMass.fill(0);
    bodies.addPointInverseMass(this.indexB[joint]!, arms[six + 3]!, arms[six + 4]!, arms[six + 5]!, inverseMass);
    const indexA = this.indexA[joint]!;
    if (indexA >= 0) bodies.addPointInverseMass(indexA, arms[six]!, arms[six + 1]!, arms[six + 2]!, inverseMass);
    invertSymmetric(inverseMass, pointMass);
    this.masses.set(pointMass, six);
  }

  /** The impulse that, with the soft spring's pull back toward where the origins meet, stops them moving apart. */
  private solvePoint(bodies: BodyTable, joint: number, soft: Softness): void {
    const six = 6 * joint;
    const three = 3 * joint;
    const arms = this.arms;
    const points = this.points;
    const indexA = this.indexA[joint]!;
    bodies.pointVelocity(this.indexB[joint]!, arms[six + 3]!, arms[six + 4]!, arms[six + 5]!, velocity);
    let speedX = velocity[0]!;
    let speedY = velocity[1]!;
    let speedZ = velocity[2]!;
    if (indexA >= 0) {
      bodies.pointVelocity(indexA, arms[six]!, arms[six + 1]!, arms[six + 2]!, velocity);
      speedX -= velocity[0]!;
      speedY -= velocity[1]!;
      speedZ -= velocity[2]!;
    }
    const pullX = speedX + soft.biasRate * (points[six + 3]! - points[six]!);
    const pullY = speedY + soft.biasRate * (points[six + 4]! - points[six + 1]!);
    const pullZ = speedZ + soft.biasRate * (points[six + 5]! - points[six + 2]!);
    const mass = this.masses;
    const impulses = this.impulses;
    const changeX = -soft.massScale * (mass[six]! * pullX + mass[six + 1]! * pullY + mass[six + 2]! * pullZ) - soft.impulseScale * impulses[three]!;
    const changeY = -soft.massScale * (mass[six + 1]! * pullX + mass[six + 3]! * pullY + mass[six + 4]! * pullZ) - soft.impulseScale * impulses[three + 1]!;
    const changeZ = -soft.massScale * (mass[six + 2]! * pullX + mass[six + 4]! * pullY + mass[six + 5]! * pullZ) - soft.impulseScale * impulses[three + 2]!;
    impulses[three] = impulses[three]! + changeX;
    impulses[three + 1] = impulses[three + 1]! + changeY;
    impulses[three + 2] = impulses[three + 2]! + changeZ;
    this.applyPoint(bodies, joint, changeX, changeY, changeZ);
  }

  /** Pushes B's frame origin by the impulse, and A's by the opposite. */
  private applyPoint(bodies: BodyTable, joint: number, impulseX: number, impulseY: number, impulseZ: number): void {
    const six = 6 * joint;
    const arms = this.arms;
    bodies.applyImpulse(this.indexB[joint]!, impulseX, impulseY, impulseZ, arms[six + 3]!, arms[six + 4]!, arms[six + 5]!);
    const indexA = this.indexA[joint]!;
    if (indexA >= 0) bodies.applyImpulse(indexA, -impulseX, -impulseY, -impulseZ, arms[six]!, arms[six + 1]!, arms[six + 2]!);
  }
}

const turned = new Float64Array(3);
const velocity = new Float64Array(3);
const inverseMass = new Float64Array(6);
const pointMass = new Float64Array(6);
