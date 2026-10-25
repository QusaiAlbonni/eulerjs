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

  /**
   * Measures every joint, works out its point's mass for the substep, and applies the impulse it
   * ended the last one with. Written out over the arrays, as each pass is: the bodies' helpers
   * hand their results back through scratch arrays, which are more reads and writes than the
   * arithmetic they save.
   */
  warmStart(bodies: BodyTable): void {
    const { centers, turns, velocities, spins, inverseMasses, inverseInertias, moving } = bodies;
    const { arms, points, startArms, worldAnchors, impulses, masses } = this;
    for (let joint = 0; joint < this.count; joint++) {
      const six = 6 * joint;
      const indexA = this.indexA[joint]!;
      const indexB = this.indexB[joint]!;
        let armAX = 0;
        let armAY = 0;
        let armAZ = 0;
        let armBX: number;
        let armBY: number;
        let armBZ: number;
        let pointAX: number;
        let pointAY: number;
        let pointAZ: number;
        let pointBX: number;
        let pointBY: number;
        let pointBZ: number;
      {
        // where the frames' origins are now, as `measure`
        if (indexA >= 0) {
        const turnA = 4 * indexA;
        const quaternionAX = turns[turnA]!;
        const quaternionAY = turns[turnA + 1]!;
        const quaternionAZ = turns[turnA + 2]!;
        const quaternionAW = turns[turnA + 3]!;
        const startAX = startArms[six + 0]!;
        const startAY = startArms[six + 1]!;
        const startAZ = startArms[six + 2]!;
        const twiceAX = 2 * (quaternionAY * startAZ - quaternionAZ * startAY);
        const twiceAY = 2 * (quaternionAZ * startAX - quaternionAX * startAZ);
        const twiceAZ = 2 * (quaternionAX * startAY - quaternionAY * startAX);
        armAX = startAX + quaternionAW * twiceAX + quaternionAY * twiceAZ - quaternionAZ * twiceAY;
        armAY = startAY + quaternionAW * twiceAY + quaternionAZ * twiceAX - quaternionAX * twiceAZ;
        armAZ = startAZ + quaternionAW * twiceAZ + quaternionAX * twiceAY - quaternionAY * twiceAX;
        const centerA = 3 * indexA;
        pointAX = centers[centerA]! + armAX;
        pointAY = centers[centerA + 1]! + armAY;
        pointAZ = centers[centerA + 2]! + armAZ;
        } else {
          const three = 3 * joint;
          pointAX = worldAnchors[three]!;
          pointAY = worldAnchors[three + 1]!;
          pointAZ = worldAnchors[three + 2]!;
        }
        const turnB = 4 * indexB;
        const quaternionBX = turns[turnB]!;
        const quaternionBY = turns[turnB + 1]!;
        const quaternionBZ = turns[turnB + 2]!;
        const quaternionBW = turns[turnB + 3]!;
        const startBX = startArms[six + 3]!;
        const startBY = startArms[six + 4]!;
        const startBZ = startArms[six + 5]!;
        const twiceBX = 2 * (quaternionBY * startBZ - quaternionBZ * startBY);
        const twiceBY = 2 * (quaternionBZ * startBX - quaternionBX * startBZ);
        const twiceBZ = 2 * (quaternionBX * startBY - quaternionBY * startBX);
        armBX = startBX + quaternionBW * twiceBX + quaternionBY * twiceBZ - quaternionBZ * twiceBY;
        armBY = startBY + quaternionBW * twiceBY + quaternionBZ * twiceBX - quaternionBX * twiceBZ;
        armBZ = startBZ + quaternionBW * twiceBZ + quaternionBX * twiceBY - quaternionBY * twiceBX;
        const centerB = 3 * indexB;
        pointBX = centers[centerB]! + armBX;
        pointBY = centers[centerB + 1]! + armBY;
        pointBZ = centers[centerB + 2]! + armBZ;
        arms[six] = armAX;
        arms[six + 1] = armAY;
        arms[six + 2] = armAZ;
        arms[six + 3] = armBX;
        arms[six + 4] = armBY;
        arms[six + 5] = armBZ;
        points[six] = pointAX;
        points[six + 1] = pointAY;
        points[six + 2] = pointAZ;
        points[six + 3] = pointBX;
        points[six + 4] = pointBY;
        points[six + 5] = pointBZ;
      }
      // the point's mass, as `preparePoint`: B's share of its inverse, then A's, inverted
      let massXX = 0;
      let massXY = 0;
      let massXZ = 0;
      let massYY = 0;
      let massYZ = 0;
      let massZZ = 0;
      {
        if (moving[indexB]) {
          const tensor = 6 * indexB;
          const xx = inverseInertias[tensor]!;
          const xy = inverseInertias[tensor + 1]!;
          const xz = inverseInertias[tensor + 2]!;
          const yy = inverseInertias[tensor + 3]!;
          const yz = inverseInertias[tensor + 4]!;
          const zz = inverseInertias[tensor + 5]!;
          const xTurnY = yy * armBZ - yz * armBY;
          const xTurnZ = yz * armBZ - zz * armBY;
          const yTurnX = xz * armBX - xx * armBZ;
          const yTurnY = yz * armBX - xy * armBZ;
          const yTurnZ = zz * armBX - xz * armBZ;
          const zTurnX = xx * armBY - xy * armBX;
          const zTurnY = xy * armBY - yy * armBX;
          const zTurnZ = xz * armBY - yz * armBX;
          const inverseMass = inverseMasses[indexB]!;
          massXX = massXX + inverseMass - (armBY * xTurnZ - armBZ * xTurnY);
          massXY = massXY - (armBY * yTurnZ - armBZ * yTurnY);
          massXZ = massXZ - (armBY * zTurnZ - armBZ * zTurnY);
          massYY = massYY + inverseMass - (armBZ * yTurnX - armBX * yTurnZ);
          massYZ = massYZ - (armBZ * zTurnX - armBX * zTurnZ);
          massZZ = massZZ + inverseMass - (armBX * zTurnY - armBY * zTurnX);
        }
        if (indexA >= 0) {
        if (moving[indexA]) {
          const tensor = 6 * indexA;
          const xx = inverseInertias[tensor]!;
          const xy = inverseInertias[tensor + 1]!;
          const xz = inverseInertias[tensor + 2]!;
          const yy = inverseInertias[tensor + 3]!;
          const yz = inverseInertias[tensor + 4]!;
          const zz = inverseInertias[tensor + 5]!;
          const xTurnY = yy * armAZ - yz * armAY;
          const xTurnZ = yz * armAZ - zz * armAY;
          const yTurnX = xz * armAX - xx * armAZ;
          const yTurnY = yz * armAX - xy * armAZ;
          const yTurnZ = zz * armAX - xz * armAZ;
          const zTurnX = xx * armAY - xy * armAX;
          const zTurnY = xy * armAY - yy * armAX;
          const zTurnZ = xz * armAY - yz * armAX;
          const inverseMass = inverseMasses[indexA]!;
          massXX = massXX + inverseMass - (armAY * xTurnZ - armAZ * xTurnY);
          massXY = massXY - (armAY * yTurnZ - armAZ * yTurnY);
          massXZ = massXZ - (armAY * zTurnZ - armAZ * zTurnY);
          massYY = massYY + inverseMass - (armAZ * yTurnX - armAX * yTurnZ);
          massYZ = massYZ - (armAZ * zTurnX - armAX * zTurnZ);
          massZZ = massZZ + inverseMass - (armAX * zTurnY - armAY * zTurnX);
        }
        }
      }
      // as `invertSymmetric`
      const cofactorXX = massYY * massZZ - massYZ * massYZ;
      const cofactorXY = massXZ * massYZ - massXY * massZZ;
      const cofactorXZ = massXY * massYZ - massXZ * massYY;
      const determinant = massXX * cofactorXX + massXY * cofactorXY + massXZ * cofactorXZ;
      if (!(Math.abs(determinant) > 1e-30)) masses.fill(0, six, six + 6);
      else {
        masses[six] = cofactorXX / determinant;
        masses[six + 1] = cofactorXY / determinant;
        masses[six + 2] = cofactorXZ / determinant;
        masses[six + 3] = (massXX * massZZ - massXZ * massXZ) / determinant;
        masses[six + 4] = (massXY * massXZ - massXX * massYZ) / determinant;
        masses[six + 5] = (massXX * massYY - massXY * massXY) / determinant;
      }
      const three = 3 * joint;
      const impulseX = impulses[three]!;
      const impulseY = impulses[three + 1]!;
      const impulseZ = impulses[three + 2]!;
      if (impulseX === 0 && impulseY === 0 && impulseZ === 0) continue;
      // as `applyPoint`: B's frame origin by the impulse, A's by the opposite
      if (moving[indexB]) {
        const at = 3 * indexB;
        const inverseMass = inverseMasses[indexB]!;
        velocities[at] = velocities[at]! + impulseX * inverseMass;
        velocities[at + 1] = velocities[at + 1]! + impulseY * inverseMass;
        velocities[at + 2] = velocities[at + 2]! + impulseZ * inverseMass;
        const angularX = armBY * impulseZ - armBZ * impulseY;
        const angularY = armBZ * impulseX - armBX * impulseZ;
        const angularZ = armBX * impulseY - armBY * impulseX;
        const tensor = 6 * indexB;
        const xx = inverseInertias[tensor]!;
        const xy = inverseInertias[tensor + 1]!;
        const xz = inverseInertias[tensor + 2]!;
        const yy = inverseInertias[tensor + 3]!;
        const yz = inverseInertias[tensor + 4]!;
        const zz = inverseInertias[tensor + 5]!;
        spins[at] = spins[at]! + (xx * angularX + xy * angularY + xz * angularZ);
        spins[at + 1] = spins[at + 1]! + (xy * angularX + yy * angularY + yz * angularZ);
        spins[at + 2] = spins[at + 2]! + (xz * angularX + yz * angularY + zz * angularZ);
      }
      if (indexA >= 0) {
        if (moving[indexA]) {
          const at = 3 * indexA;
          const inverseMass = inverseMasses[indexA]!;
          velocities[at] = velocities[at]! + -impulseX * inverseMass;
          velocities[at + 1] = velocities[at + 1]! + -impulseY * inverseMass;
          velocities[at + 2] = velocities[at + 2]! + -impulseZ * inverseMass;
          const angularX = armAY * -impulseZ - armAZ * -impulseY;
          const angularY = armAZ * -impulseX - armAX * -impulseZ;
          const angularZ = armAX * -impulseY - armAY * -impulseX;
          const tensor = 6 * indexA;
          const xx = inverseInertias[tensor]!;
          const xy = inverseInertias[tensor + 1]!;
          const xz = inverseInertias[tensor + 2]!;
          const yy = inverseInertias[tensor + 3]!;
          const yz = inverseInertias[tensor + 4]!;
          const zz = inverseInertias[tensor + 5]!;
          spins[at] = spins[at]! + (xx * angularX + xy * angularY + xz * angularZ);
          spins[at + 1] = spins[at + 1]! + (xy * angularX + yy * angularY + yz * angularZ);
          spins[at + 2] = spins[at + 2]! + (xz * angularX + yz * angularY + zz * angularZ);
        }
      }
    }
  }

  /**
   * One pass: with `softness`, the biased one, straight after the warm start, before anything
   * has moved, so with its measurements; without, the relaxing one, after the bodies have moved.
   */
  solve(bodies: BodyTable, softness: Softness | undefined): void {
    const soft = softness ?? RIGID;
    const { centers, turns, velocities, spins, inverseMasses, inverseInertias, moving } = bodies;
    const { arms, points, startArms, worldAnchors, impulses, masses } = this;
    for (let joint = 0; joint < this.count; joint++) {
      const six = 6 * joint;
      const three = 3 * joint;
      const indexA = this.indexA[joint]!;
      const indexB = this.indexB[joint]!;
        let armAX = 0;
        let armAY = 0;
        let armAZ = 0;
        let armBX: number;
        let armBY: number;
        let armBZ: number;
        let pointAX: number;
        let pointAY: number;
        let pointAZ: number;
        let pointBX: number;
        let pointBY: number;
        let pointBZ: number;
      if (!softness) {
        // where the frames' origins are now, as `measure`
        if (indexA >= 0) {
        const turnA = 4 * indexA;
        const quaternionAX = turns[turnA]!;
        const quaternionAY = turns[turnA + 1]!;
        const quaternionAZ = turns[turnA + 2]!;
        const quaternionAW = turns[turnA + 3]!;
        const startAX = startArms[six + 0]!;
        const startAY = startArms[six + 1]!;
        const startAZ = startArms[six + 2]!;
        const twiceAX = 2 * (quaternionAY * startAZ - quaternionAZ * startAY);
        const twiceAY = 2 * (quaternionAZ * startAX - quaternionAX * startAZ);
        const twiceAZ = 2 * (quaternionAX * startAY - quaternionAY * startAX);
        armAX = startAX + quaternionAW * twiceAX + quaternionAY * twiceAZ - quaternionAZ * twiceAY;
        armAY = startAY + quaternionAW * twiceAY + quaternionAZ * twiceAX - quaternionAX * twiceAZ;
        armAZ = startAZ + quaternionAW * twiceAZ + quaternionAX * twiceAY - quaternionAY * twiceAX;
        const centerA = 3 * indexA;
        pointAX = centers[centerA]! + armAX;
        pointAY = centers[centerA + 1]! + armAY;
        pointAZ = centers[centerA + 2]! + armAZ;
        } else {
          const three = 3 * joint;
          pointAX = worldAnchors[three]!;
          pointAY = worldAnchors[three + 1]!;
          pointAZ = worldAnchors[three + 2]!;
        }
        const turnB = 4 * indexB;
        const quaternionBX = turns[turnB]!;
        const quaternionBY = turns[turnB + 1]!;
        const quaternionBZ = turns[turnB + 2]!;
        const quaternionBW = turns[turnB + 3]!;
        const startBX = startArms[six + 3]!;
        const startBY = startArms[six + 4]!;
        const startBZ = startArms[six + 5]!;
        const twiceBX = 2 * (quaternionBY * startBZ - quaternionBZ * startBY);
        const twiceBY = 2 * (quaternionBZ * startBX - quaternionBX * startBZ);
        const twiceBZ = 2 * (quaternionBX * startBY - quaternionBY * startBX);
        armBX = startBX + quaternionBW * twiceBX + quaternionBY * twiceBZ - quaternionBZ * twiceBY;
        armBY = startBY + quaternionBW * twiceBY + quaternionBZ * twiceBX - quaternionBX * twiceBZ;
        armBZ = startBZ + quaternionBW * twiceBZ + quaternionBX * twiceBY - quaternionBY * twiceBX;
        const centerB = 3 * indexB;
        pointBX = centers[centerB]! + armBX;
        pointBY = centers[centerB + 1]! + armBY;
        pointBZ = centers[centerB + 2]! + armBZ;
        arms[six] = armAX;
        arms[six + 1] = armAY;
        arms[six + 2] = armAZ;
        arms[six + 3] = armBX;
        arms[six + 4] = armBY;
        arms[six + 5] = armBZ;
        points[six] = pointAX;
        points[six + 1] = pointAY;
        points[six + 2] = pointAZ;
        points[six + 3] = pointBX;
        points[six + 4] = pointBY;
        points[six + 5] = pointBZ;
      } else {
        armAX = arms[six]!;
        armAY = arms[six + 1]!;
        armAZ = arms[six + 2]!;
        armBX = arms[six + 3]!;
        armBY = arms[six + 4]!;
        armBZ = arms[six + 5]!;
        pointAX = points[six]!;
        pointAY = points[six + 1]!;
        pointAZ = points[six + 2]!;
        pointBX = points[six + 3]!;
        pointBY = points[six + 4]!;
        pointBZ = points[six + 5]!;
      }
      // how fast B's frame origin moves from A's, as `pointVelocity`
      const atB = 3 * indexB;
      let speedX = velocities[atB]! + spins[atB + 1]! * armBZ - spins[atB + 2]! * armBY;
      let speedY = velocities[atB + 1]! + spins[atB + 2]! * armBX - spins[atB]! * armBZ;
      let speedZ = velocities[atB + 2]! + spins[atB]! * armBY - spins[atB + 1]! * armBX;
      if (indexA >= 0) {
        const atA = 3 * indexA;
        speedX -= velocities[atA]! + spins[atA + 1]! * armAZ - spins[atA + 2]! * armAY;
        speedY -= velocities[atA + 1]! + spins[atA + 2]! * armAX - spins[atA]! * armAZ;
        speedZ -= velocities[atA + 2]! + spins[atA]! * armAY - spins[atA + 1]! * armAX;
      }
      // the impulse that, with the soft spring's pull back toward where the origins meet, stops them moving apart
      const pullX = speedX + soft.biasRate * (pointBX - pointAX);
      const pullY = speedY + soft.biasRate * (pointBY - pointAY);
      const pullZ = speedZ + soft.biasRate * (pointBZ - pointAZ);
      const impulseX = -soft.massScale * (masses[six]! * pullX + masses[six + 1]! * pullY + masses[six + 2]! * pullZ) - soft.impulseScale * impulses[three]!;
      const impulseY = -soft.massScale * (masses[six + 1]! * pullX + masses[six + 3]! * pullY + masses[six + 4]! * pullZ) - soft.impulseScale * impulses[three + 1]!;
      const impulseZ = -soft.massScale * (masses[six + 2]! * pullX + masses[six + 4]! * pullY + masses[six + 5]! * pullZ) - soft.impulseScale * impulses[three + 2]!;
      impulses[three] = impulses[three]! + impulseX;
      impulses[three + 1] = impulses[three + 1]! + impulseY;
      impulses[three + 2] = impulses[three + 2]! + impulseZ;
      // as `applyPoint`: B's frame origin by the change, A's by the opposite
      if (moving[indexB]) {
        const at = 3 * indexB;
        const inverseMass = inverseMasses[indexB]!;
        velocities[at] = velocities[at]! + impulseX * inverseMass;
        velocities[at + 1] = velocities[at + 1]! + impulseY * inverseMass;
        velocities[at + 2] = velocities[at + 2]! + impulseZ * inverseMass;
        const angularX = armBY * impulseZ - armBZ * impulseY;
        const angularY = armBZ * impulseX - armBX * impulseZ;
        const angularZ = armBX * impulseY - armBY * impulseX;
        const tensor = 6 * indexB;
        const xx = inverseInertias[tensor]!;
        const xy = inverseInertias[tensor + 1]!;
        const xz = inverseInertias[tensor + 2]!;
        const yy = inverseInertias[tensor + 3]!;
        const yz = inverseInertias[tensor + 4]!;
        const zz = inverseInertias[tensor + 5]!;
        spins[at] = spins[at]! + (xx * angularX + xy * angularY + xz * angularZ);
        spins[at + 1] = spins[at + 1]! + (xy * angularX + yy * angularY + yz * angularZ);
        spins[at + 2] = spins[at + 2]! + (xz * angularX + yz * angularY + zz * angularZ);
      }
      if (indexA >= 0) {
        if (moving[indexA]) {
          const at = 3 * indexA;
          const inverseMass = inverseMasses[indexA]!;
          velocities[at] = velocities[at]! + -impulseX * inverseMass;
          velocities[at + 1] = velocities[at + 1]! + -impulseY * inverseMass;
          velocities[at + 2] = velocities[at + 2]! + -impulseZ * inverseMass;
          const angularX = armAY * -impulseZ - armAZ * -impulseY;
          const angularY = armAZ * -impulseX - armAX * -impulseZ;
          const angularZ = armAX * -impulseY - armAY * -impulseX;
          const tensor = 6 * indexA;
          const xx = inverseInertias[tensor]!;
          const xy = inverseInertias[tensor + 1]!;
          const xz = inverseInertias[tensor + 2]!;
          const yy = inverseInertias[tensor + 3]!;
          const yz = inverseInertias[tensor + 4]!;
          const zz = inverseInertias[tensor + 5]!;
          spins[at] = spins[at]! + (xx * angularX + xy * angularY + xz * angularZ);
          spins[at + 1] = spins[at + 1]! + (xy * angularX + yy * angularY + yz * angularZ);
          spins[at + 2] = spins[at + 2]! + (xz * angularX + yz * angularY + zz * angularZ);
        }
      }
    }
  }

  /** Joint `joint`'s impulse now, into `target`'s first three slots: what it holds its point with, kept for the next step and reported as its load. */
  impulseInto(joint: number, target: Float64Array): void {
    const three = 3 * joint;
    target[0] = this.impulses[three]!;
    target[1] = this.impulses[three + 1]!;
    target[2] = this.impulses[three + 2]!;
  }
}
