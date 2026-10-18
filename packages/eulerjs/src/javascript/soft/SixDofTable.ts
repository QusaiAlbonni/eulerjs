import { Quaternion, Vector3 } from 'three';
import type { JointFrame, SixDofJoint } from '../../joints/SixDofJoint.js';
import { coneLimit, driveGains, invertSymmetric, driveImpulse, driveLimit, frameAxis, hasSpring, swingAndTwist, swingCone, turnsFreely, turnToTarget } from '../../joints/sixDofMath.js';
import type { FrameTurn } from '../../joints/sixDofMath.js';
import type { SolverBody } from '../SolverBody.js';
import type { BodyTable } from './BodyTable.js';
import { RIGID } from './softness.js';
import type { Softness } from './softness.js';

/**
 * Six-degree-of-freedom joints for the soft-step solver. Each axis the joint holds is a row: a
 * scalar constraint on the bodies' velocities along a linear axis or about an angular one, two
 * sided for a locked axis and one sided for each limit, which only pushes once the limit is
 * reached (and lets the axis close the gap to it over a substep before). Every row's impulse
 * carries over to the next substep and step. Drives push their axes on the biased pass; friction
 * is a row on every axis the joint doesn't lock, whose impulse is held within the friction.
 */

/**
 * Where each row keeps its impulse: two per axis (a locked axis or lower limit, then an upper
 * limit), then one per drive, then friction about each angular axis and along each linear one.
 */
const LINEAR_SLOTS = 0;
const TWIST_SLOTS = 6;
const SWING_SLOTS = 8;
const DRIVE_SLOTS = 12;
const FRICTION_SLOTS = 18;
const LINEAR_FRICTION_SLOTS = 21;
const SLOT_COUNT = 24;

interface JointRow {
  joint: SixDofJoint;
  /** The body the base frame is on, or -1 for a joint to the world; the body whose frame moves against it (see `SixDofJoint.roles`). */
  indexA: number;
  indexB: number;
  baseFrame: JointFrame;
  movingFrame: JointFrame;
  /** The frames' origins as offsets from the centres of mass when the step began, in world space. */
  startArmA: Vector3;
  startArmB: Vector3;
  impulses: Float64Array;
  /** Each row's inverse mass along its axis, worked out once a substep when it warm starts. */
  masses: Float64Array;
  /**
   * For a joint whose linear axes are all locked, the point is held as one block rather than three
   * rows: the inverse of its effective inverse mass K, a symmetric tensor (xx xy xz yy yz zz).
   */
  pointMass: Float64Array;
  /** The impulse each row gave on the last substep along its axis, for the loads the joint reports. */
  readonly lastLinear: Vector3;
  readonly lastAngular: Vector3;
  /** The angular impulse the orientation drive gave on the last biased pass. */
  readonly orientationImpulse: Vector3;
}

const armA = new Vector3();
const armB = new Vector3();
const pointA = new Vector3();
const pointB = new Vector3();
const orientationA = new Quaternion();
const orientationB = new Quaternion();
const inverseA = new Quaternion();
const relative = new Quaternion();
const turn: FrameTurn = { twist: 0, swing: new Vector3() };
const offset = new Vector3();
const axis = new Vector3();
const negatedAxis = new Vector3();
const rotation = new Vector3();
const relativeSpin = new Vector3();
const baseSpin = new Vector3();
const accumulated = new Vector3();
const held = new Vector3();
const change = new Vector3();
const scratch = new Float64Array(3);
const otherScratch = new Float64Array(3);
const worldPoint = new Vector3();
const worldCenter = new Vector3();

export class SixDofTable {
  private rows: JointRow[] = [];
  private readonly kept = new Map<SixDofJoint, Float64Array>();

  prepare(joints: ReadonlyMap<SixDofJoint, readonly [SolverBody, SolverBody | undefined]>, bodies: BodyTable): void {
    this.rows = [];
    for (const [joint, [solverA, solverB]] of joints) {
      let impulses = this.kept.get(joint);
      if (!impulses) this.kept.set(joint, (impulses = new Float64Array(SLOT_COUNT)));
      const base = solverB ? solverA : undefined;
      const moving = solverB ?? solverA;
      const roles = joint.roles;
      this.rows.push({
        joint,
        indexA: base ? bodies.indexOf.get(base)! : -1,
        indexB: bodies.indexOf.get(moving)!,
        baseFrame: roles.base,
        movingFrame: roles.moving,
        startArmA: base ? startArm(base, roles.base) : new Vector3(),
        startArmB: startArm(moving, roles.moving),
        impulses,
        masses: new Float64Array(SLOT_COUNT),
        pointMass: new Float64Array(6),
        lastLinear: new Vector3(),
        lastAngular: new Vector3(),
        orientationImpulse: new Vector3(),
      });
    }
  }

  /** Works out every row's inverse mass for the substep, and applies the impulses the rows ended the last one with. */
  warmStart(bodies: BodyTable): void {
    for (const row of this.rows) {
      this.measure(bodies, row);
      row.masses.fill(0);
      if (holdsPoint(row)) {
        this.preparePoint(bodies, row);
        const impulses = row.impulses;
        if (impulses[0] !== 0 || impulses[1] !== 0 || impulses[2] !== 0) this.applyPoint(bodies, row, impulses[0]!, impulses[1]!, impulses[2]!);
      }
      const warm = (slot: number, kind: 'linear' | 'angular', rowAxis: Vector3): void => {
        row.masses[slot] = this.inverseMassAlong(bodies, row, kind, rowAxis);
        const impulse = row.impulses[slot]!;
        if (impulse !== 0) this.apply(bodies, row, kind, rowAxis, impulse);
      };
      this.forEachRowAxis(row, warm);
      this.forEachFrictionAxis(row, warm);
      if (row.joint.friction > 0 && turnsFreely(row.joint.angular)) {
        this.turnByVector(bodies, row, accumulated.set(row.impulses[FRICTION_SLOTS]!, row.impulses[FRICTION_SLOTS + 1]!, row.impulses[FRICTION_SLOTS + 2]!));
      }
    }
  }

  /** One pass over every joint's rows; with `softness`, the biased pass, which also runs the drives. */
  solve(bodies: BodyTable, substep: number, softness: Softness | undefined): void {
    for (const row of this.rows) {
      this.measure(bodies, row);
      row.lastLinear.set(0, 0, 0);
      row.lastAngular.set(0, 0, 0);
      this.solveConstraints(bodies, row, substep, softness);
      if (softness) this.solveDrives(bodies, row, substep);
      else this.countDriveLoads(row);
      this.solveFriction(bodies, row, substep);
    }
  }

  /** Writes each joint's loads over the last substep, and keeps its impulses for the next step. */
  finish(substep: number): void {
    for (const row of this.rows) {
      row.joint.force.copy(row.lastLinear).divideScalar(substep);
      row.joint.torque.copy(row.lastAngular).divideScalar(substep);
    }
  }

  forget(joint: SixDofJoint): void {
    this.kept.delete(joint);
  }

  private solveConstraints(bodies: BodyTable, row: JointRow, substep: number, softness: Softness | undefined): void {
    const { linear, angular } = row.joint;
    if (holdsPoint(row)) this.solvePoint(bodies, row, substep, softness);
    else {
      // linear axes, in frame A
      offset.subVectors(pointB, pointA).applyQuaternion(inverseA);
      for (let index = 0; index < 3; index++) {
        frameAxis(orientationA, index, axis);
        this.solveAxis(bodies, row, LINEAR_SLOTS + 2 * index, 'linear', axis, offset.getComponent(index), linear[index]!, substep, softness);
      }
    }
    if (angular.every((motion) => motion === 'locked')) {
      // the whole turn of frame B in frame A, as a rotation vector, held at zero
      const sign = relative.w < 0 ? -1 : 1;
      for (let index = 0; index < 3; index++) {
        frameAxis(orientationA, index, axis);
        const value = 2 * sign * (index === 0 ? relative.x : index === 1 ? relative.y : relative.z);
        this.solveRow(bodies, row, TWIST_SLOTS + 2 * index, 'angular', axis, value, false, substep, softness);
      }
      return;
    }
    frameAxis(orientationB, 0, axis);
    this.solveAxis(bodies, row, TWIST_SLOTS, 'angular', axis, turn.twist, angular[0]!, substep, softness);
    const cone = swingCone(angular[1]!, angular[2]!);
    if (cone) {
      // one row, along the way the axis leans, holding the lean within the cone
      const lean = Math.hypot(turn.swing.y, turn.swing.z);
      if (lean < 1e-9) return;
      axis.set(0, turn.swing.y / lean, turn.swing.z / lean).applyQuaternion(orientationA).negate();
      this.solveRow(bodies, row, SWING_SLOTS, 'angular', axis, coneLimit(cone, turn.swing) - lean, true, substep, softness);
      return;
    }
    for (const index of [1, 2]) {
      frameAxis(orientationA, index, axis);
      this.solveAxis(bodies, row, SWING_SLOTS + 2 * (index - 1), 'angular', axis, turn.swing.getComponent(index), angular[index]!, substep, softness);
    }
  }

  /** The rows for one axis: one held at zero if it is locked, one for each limit if it has limits, none if it is free. */
  private solveAxis(
    bodies: BodyTable,
    row: JointRow,
    slot: number,
    kind: 'linear' | 'angular',
    rowAxis: Vector3,
    value: number,
    motion: SixDofJoint['linear'][number],
    substep: number,
    softness: Softness | undefined,
  ): void {
    if (motion === 'free') return;
    if (motion === 'locked') {
      this.solveRow(bodies, row, slot, kind, rowAxis, value, false, substep, softness);
      return;
    }
    this.solveRow(bodies, row, slot, kind, rowAxis, value - motion.lower, true, substep, softness);
    this.solveRow(bodies, row, slot + 1, kind, negatedAxis.copy(rowAxis).negate(), motion.upper - value, true, substep, softness);
  }

  /**
   * One row: drives `value` to zero along `rowAxis` (frame B's motion relative to frame A), or,
   * if `oneSided`, keeps it from going below zero, pushing only once it would.
   */
  private solveRow(
    bodies: BodyTable,
    row: JointRow,
    slot: number,
    kind: 'linear' | 'angular',
    rowAxis: Vector3,
    value: number,
    oneSided: boolean,
    substep: number,
    softness: Softness | undefined,
  ): void {
    // a row that wasn't there at warm start, such as a cone's the moment the axis leans, works its mass out now
    let inverseMass = row.masses[slot]!;
    if (inverseMass === 0) inverseMass = row.masses[slot] = this.inverseMassAlong(bodies, row, kind, rowAxis);
    if (inverseMass === 0) return;
    const speed = this.speedAlong(bodies, row, kind, rowAxis);
    // one-sided rows the axis hasn't reached yet let it close the gap over the substep
    const soft = oneSided && value > 0 ? { biasRate: 1 / substep, massScale: 1, impulseScale: 0 } : (softness ?? RIGID);
    const accumulated = row.impulses[slot]!;
    const change = (-soft.massScale * (speed + soft.biasRate * value)) / inverseMass - soft.impulseScale * accumulated;
    let impulse = accumulated + change;
    if (oneSided) impulse = Math.max(impulse, 0);
    row.impulses[slot] = impulse;
    const applied = impulse - accumulated;
    if (applied !== 0) this.apply(bodies, row, kind, rowAxis, applied);
    (kind === 'linear' ? row.lastLinear : row.lastAngular).addScaledVector(rowAxis, impulse);
  }

  private solveDrives(bodies: BodyTable, row: JointRow, substep: number): void {
    const { linearDrives, angularDrives, linear, angular } = row.joint;
    offset.subVectors(pointB, pointA).applyQuaternion(inverseA);
    for (let index = 0; index < 6; index++) {
      const isLinear = index < 3;
      const axisIndex = index % 3;
      const drive = isLinear ? linearDrives[axisIndex] : angularDrives[axisIndex];
      if (!drive || (isLinear ? linear : angular)[axisIndex] === 'locked') continue;
      const kind = isLinear ? 'linear' : 'angular';
      if (!isLinear && axisIndex === 0) frameAxis(orientationB, 0, axis);
      else frameAxis(orientationA, axisIndex, axis);
      const position = isLinear ? offset.getComponent(axisIndex) : axisIndex === 0 ? turn.twist : turn.swing.getComponent(axisIndex);
      const inverseMass = this.inverseMassAlong(bodies, row, kind, axis);
      const gainInverseMass = isLinear ? inverseMass : this.gainInverseMass(bodies, row, axis);
      const limit = driveLimit(drive, substep);
      const impulse = Math.min(Math.max(driveImpulse(drive, position, this.speedAlong(bodies, row, kind, axis), inverseMass, substep, gainInverseMass), -limit), limit);
      row.impulses[DRIVE_SLOTS + index] = impulse;
      if (impulse === 0) continue;
      this.apply(bodies, row, kind, axis, impulse);
      (isLinear ? row.lastLinear : row.lastAngular).addScaledVector(axis, impulse);
    }
    this.solveOrientationDrive(bodies, row, substep);
  }

  /**
   * The orientation drive, as two rows: a spring and damper about the axis of the turn to the
   * target, then its damping against whatever spin is left across that axis, so that it damps
   * the same every way and still damps once the target is reached.
   */
  private solveOrientationDrive(bodies: BodyTable, row: JointRow, substep: number): void {
    row.orientationImpulse.set(0, 0, 0);
    const drive = row.joint.orientationDrive;
    if (!drive) return;
    const limit = (drive.maxTorque ?? Infinity) * substep;
    let turning = false;
    if (hasSpring(drive)) {
      turnToTarget(orientationA, drive.target, orientationB, rotation);
      const angle = rotation.length();
      turning = angle > 1e-12;
      if (turning) {
        axis.copy(rotation).divideScalar(angle);
        const inverseMass = this.inverseMassAlong(bodies, row, 'angular', axis);
        const speed = this.speedAlong(bodies, row, 'angular', axis);
        const spring = { stiffness: drive.stiffness, damping: drive.damping, frequency: drive.frequency, dampingRatio: drive.dampingRatio, targetPosition: angle };
        const impulse = driveImpulse(spring, 0, speed, inverseMass, substep, this.gainInverseMass(bodies, row, axis));
        this.turnOrientation(bodies, row, axis, Math.min(Math.max(impulse, -limit), limit));
      }
    }
    // the spin relative to the base left across the turn's axis, or all of it with no turn to make
    spinOf(bodies, row.indexB, relativeSpin);
    if (row.indexA >= 0) relativeSpin.sub(spinOf(bodies, row.indexA, baseSpin));
    if (turning) relativeSpin.addScaledVector(axis, -relativeSpin.dot(axis));
    const spin = relativeSpin.length();
    if (spin < 1e-9) return;
    axis.copy(relativeSpin).divideScalar(spin);
    const inverseMass = this.inverseMassAlong(bodies, row, 'angular', axis);
    const damping = hasSpring(drive) ? driveGains(drive, this.gainInverseMass(bodies, row, axis)).damping : (drive.damping ?? Infinity);
    this.turnOrientation(bodies, row, axis, Math.min(Math.max(driveImpulse({ damping }, 0, spin, inverseMass, substep), -limit), limit));
  }

  /**
   * How hard the joint is to turn about `rowAxis`, for drives set by frequency: about the point
   * it holds, if it holds one, or else about the bodies' centres of mass.
   */
  private gainInverseMass(bodies: BodyTable, row: JointRow, rowAxis: Vector3): number {
    if (!holdsPoint(row)) return this.inverseMassAlong(bodies, row, 'angular', rowAxis);
    const pinnedB = bodies.pinnedInverseInertiaAbout(row.indexB, armB.x, armB.y, armB.z, rowAxis.x, rowAxis.y, rowAxis.z);
    return pinnedB + (row.indexA >= 0 ? bodies.pinnedInverseInertiaAbout(row.indexA, armA.x, armA.y, armA.z, rowAxis.x, rowAxis.y, rowAxis.z) : 0);
  }

  private turnOrientation(bodies: BodyTable, row: JointRow, rowAxis: Vector3, impulse: number): void {
    if (impulse === 0) return;
    this.apply(bodies, row, 'angular', rowAxis, impulse);
    row.orientationImpulse.addScaledVector(rowAxis, impulse);
    row.lastAngular.addScaledVector(rowAxis, impulse);
  }

  /**
   * Friction: on each axis the joint doesn't lock, an impulse against the motion along it, kept
   * through the substep's passes and held within the friction force (or torque) times the substep.
   * A joint that locks no angular axis resists its whole spin at once instead, within a circle.
   */
  private solveFriction(bodies: BodyTable, row: JointRow, substep: number): void {
    const { friction, linearFriction, angular } = row.joint;
    if (friction <= 0 && linearFriction <= 0) return;
    if (friction > 0 && turnsFreely(angular)) this.solveBallFriction(bodies, row, friction * substep);
    this.forEachFrictionAxis(row, (slot, kind, rowAxis) => {
      let inverseMass = row.masses[slot]!;
      if (inverseMass === 0) inverseMass = row.masses[slot] = this.inverseMassAlong(bodies, row, kind, rowAxis);
      if (inverseMass === 0) return;
      const limit = (kind === 'angular' ? friction : linearFriction) * substep;
      const accumulated = row.impulses[slot]!;
      const impulse = Math.min(Math.max(accumulated - this.speedAlong(bodies, row, kind, rowAxis) / inverseMass, -limit), limit);
      row.impulses[slot] = impulse;
      if (impulse !== accumulated) this.apply(bodies, row, kind, rowAxis, impulse - accumulated);
      (kind === 'linear' ? row.lastLinear : row.lastAngular).addScaledVector(rowAxis, impulse);
    });
  }

  /**
   * A ball joint's friction: the angular impulse stopping its relative spin, kept as a vector in
   * the friction slots through the substep, and no longer than `limit`.
   */
  private solveBallFriction(bodies: BodyTable, row: JointRow, limit: number): void {
    spinOf(bodies, row.indexB, relativeSpin);
    if (row.indexA >= 0) relativeSpin.sub(spinOf(bodies, row.indexA, baseSpin));
    const spin = relativeSpin.length();
    const impulses = row.impulses;
    accumulated.set(impulses[FRICTION_SLOTS]!, impulses[FRICTION_SLOTS + 1]!, impulses[FRICTION_SLOTS + 2]!);
    if (spin > 1e-12) {
      axis.copy(relativeSpin).divideScalar(spin);
      const inverseMass = this.inverseMassAlong(bodies, row, 'angular', axis);
      if (inverseMass > 0) {
        held.copy(accumulated).addScaledVector(axis, -spin / inverseMass);
        if (held.length() > limit) held.setLength(limit);
        this.turnByVector(bodies, row, change.subVectors(held, accumulated));
        impulses[FRICTION_SLOTS] = held.x;
        impulses[FRICTION_SLOTS + 1] = held.y;
        impulses[FRICTION_SLOTS + 2] = held.z;
        accumulated.copy(held);
      }
    }
    row.lastAngular.add(accumulated);
  }

  /** Turns the moving body by the angular impulse `impulse` (world space), and the base the other way. */
  private turnByVector(bodies: BodyTable, row: JointRow, impulse: Vector3): void {
    const size = impulse.length();
    if (size > 0) this.apply(bodies, row, 'angular', impulse.divideScalar(size), size);
  }

  /** Calls `visit` with each friction row the joint has: its slot, its kind and its axis now. */
  private forEachFrictionAxis(row: JointRow, visit: (slot: number, kind: 'linear' | 'angular', rowAxis: Vector3) => void): void {
    const { linear, angular, friction, linearFriction } = row.joint;
    // a ball joint's friction isn't a row per axis: see solveBallFriction
    const perAxis = !turnsFreely(angular);
    for (let index = 0; index < 3; index++) {
      if (perAxis && friction > 0 && angular[index] !== 'locked') visit(FRICTION_SLOTS + index, 'angular', index === 0 ? frameAxis(orientationB, 0, axis) : frameAxis(orientationA, index, axis));
      if (linearFriction > 0 && linear[index] !== 'locked') visit(LINEAR_FRICTION_SLOTS + index, 'linear', frameAxis(orientationA, index, axis));
    }
  }

  /** Works out the inverse of the point's effective inverse mass for the substep. */
  private preparePoint(bodies: BodyTable, row: JointRow): void {
    pointInverseMass.fill(0);
    bodies.addPointInverseMass(row.indexB, armB.x, armB.y, armB.z, pointInverseMass);
    if (row.indexA >= 0) bodies.addPointInverseMass(row.indexA, armA.x, armA.y, armA.z, pointInverseMass);
    invertSymmetric(pointInverseMass, row.pointMass);
  }

  /**
   * The point as one block: the impulse vector that, with the soft spring's pull back toward
   * where the frames' origins meet, stops them moving apart, kept in the first three slots.
   */
  private solvePoint(bodies: BodyTable, row: JointRow, substep: number, softness: Softness | undefined): void {
    const soft = softness ?? RIGID;
    bodies.pointVelocity(row.indexB, armB.x, armB.y, armB.z, scratch);
    let speedX = scratch[0]!;
    let speedY = scratch[1]!;
    let speedZ = scratch[2]!;
    if (row.indexA >= 0) {
      bodies.pointVelocity(row.indexA, armA.x, armA.y, armA.z, otherScratch);
      speedX -= otherScratch[0]!;
      speedY -= otherScratch[1]!;
      speedZ -= otherScratch[2]!;
    }
    const pullX = speedX + soft.biasRate * (pointB.x - pointA.x);
    const pullY = speedY + soft.biasRate * (pointB.y - pointA.y);
    const pullZ = speedZ + soft.biasRate * (pointB.z - pointA.z);
    const mass = row.pointMass;
    const impulses = row.impulses;
    const changeX = -soft.massScale * (mass[0]! * pullX + mass[1]! * pullY + mass[2]! * pullZ) - soft.impulseScale * impulses[0]!;
    const changeY = -soft.massScale * (mass[1]! * pullX + mass[3]! * pullY + mass[4]! * pullZ) - soft.impulseScale * impulses[1]!;
    const changeZ = -soft.massScale * (mass[2]! * pullX + mass[4]! * pullY + mass[5]! * pullZ) - soft.impulseScale * impulses[2]!;
    impulses[0] = impulses[0]! + changeX;
    impulses[1] = impulses[1]! + changeY;
    impulses[2] = impulses[2]! + changeZ;
    this.applyPoint(bodies, row, changeX, changeY, changeZ);
    row.lastLinear.x += impulses[0]!;
    row.lastLinear.y += impulses[1]!;
    row.lastLinear.z += impulses[2]!;
  }

  /** Pushes the moving frame's origin by the impulse, and the base's by the opposite. */
  private applyPoint(bodies: BodyTable, row: JointRow, impulseX: number, impulseY: number, impulseZ: number): void {
    bodies.applyImpulse(row.indexB, impulseX, impulseY, impulseZ, armB.x, armB.y, armB.z);
    if (row.indexA >= 0) bodies.applyImpulse(row.indexA, -impulseX, -impulseY, -impulseZ, armA.x, armA.y, armA.z);
  }

  /** Adds the impulses the drives gave on this substep to the loads the joint reports. */
  private countDriveLoads(row: JointRow): void {
    for (let index = 0; index < 6; index++) {
      const impulse = row.impulses[DRIVE_SLOTS + index]!;
      if (impulse === 0) continue;
      const axisIndex = index % 3;
      if (index === 3) frameAxis(orientationB, 0, axis);
      else frameAxis(orientationA, axisIndex, axis);
      (index < 3 ? row.lastLinear : row.lastAngular).addScaledVector(axis, impulse);
    }
    row.lastAngular.add(row.orientationImpulse);
  }

  /** Calls `visit` with each row the joint has, for warm starting: its slot, its kind and its axis now. */
  private forEachRowAxis(row: JointRow, visit: (slot: number, kind: 'linear' | 'angular', rowAxis: Vector3) => void): void {
    const { linear, angular } = row.joint;
    for (let index = 0; index < 3; index++) {
      const motion = linear[index]!;
      if (motion === 'free' || holdsPoint(row)) continue;
      frameAxis(orientationA, index, axis);
      visit(LINEAR_SLOTS + 2 * index, 'linear', axis);
      if (motion !== 'locked') visit(LINEAR_SLOTS + 2 * index + 1, 'linear', negatedAxis.copy(axis).negate());
    }
    if (angular.every((motion) => motion === 'locked')) {
      for (let index = 0; index < 3; index++) visit(TWIST_SLOTS + 2 * index, 'angular', frameAxis(orientationA, index, axis));
      return;
    }
    if (angular[0] !== 'free') {
      frameAxis(orientationB, 0, axis);
      visit(TWIST_SLOTS, 'angular', axis);
      if (angular[0] !== 'locked') visit(TWIST_SLOTS + 1, 'angular', negatedAxis.copy(axis).negate());
    }
    const cone = swingCone(angular[1]!, angular[2]!);
    if (cone) {
      const lean = Math.hypot(turn.swing.y, turn.swing.z);
      if (lean >= 1e-9) visit(SWING_SLOTS, 'angular', axis.set(0, turn.swing.y / lean, turn.swing.z / lean).applyQuaternion(orientationA).negate());
      return;
    }
    for (const index of [1, 2]) {
      const motion = angular[index]!;
      if (motion === 'free') continue;
      frameAxis(orientationA, index, axis);
      visit(SWING_SLOTS + 2 * (index - 1), 'angular', axis);
      if (motion !== 'locked') visit(SWING_SLOTS + 2 * (index - 1) + 1, 'angular', negatedAxis.copy(axis).negate());
    }
  }

  /** The frames as the bodies are now, base into the A scratch pose and moving into the B one, with the moving frame's turn in the base's. */
  private measure(bodies: BodyTable, row: JointRow): void {
    if (row.indexA >= 0) {
      bodyOrientation(bodies, row.indexA, orientationA).multiply(row.baseFrame.quaternion);
      turnArm(bodies, row.indexA, row.startArmA, armA);
      centerOf(bodies, row.indexA, pointA).add(armA);
    } else {
      orientationA.copy(row.baseFrame.quaternion);
      pointA.copy(row.baseFrame.position);
    }
    bodyOrientation(bodies, row.indexB, orientationB).multiply(row.movingFrame.quaternion);
    turnArm(bodies, row.indexB, row.startArmB, armB);
    centerOf(bodies, row.indexB, pointB).add(armB);
    inverseA.copy(orientationA).invert();
    relative.multiplyQuaternions(inverseA, orientationB);
    swingAndTwist(relative, turn);
  }

  /** How fast frame B moves relative to frame A along a linear axis, or turns about an angular one. */
  private speedAlong(bodies: BodyTable, row: JointRow, kind: 'linear' | 'angular', rowAxis: Vector3): number {
    if (kind === 'angular') return spinAlong(bodies, row.indexB, rowAxis) - (row.indexA >= 0 ? spinAlong(bodies, row.indexA, rowAxis) : 0);
    bodies.pointVelocity(row.indexB, armB.x, armB.y, armB.z, scratch);
    let speed = scratch[0]! * rowAxis.x + scratch[1]! * rowAxis.y + scratch[2]! * rowAxis.z;
    if (row.indexA >= 0) {
      bodies.pointVelocity(row.indexA, armA.x, armA.y, armA.z, otherScratch);
      speed -= otherScratch[0]! * rowAxis.x + otherScratch[1]! * rowAxis.y + otherScratch[2]! * rowAxis.z;
    }
    return speed;
  }

  private inverseMassAlong(bodies: BodyTable, row: JointRow, kind: 'linear' | 'angular', rowAxis: Vector3): number {
    if (kind === 'angular') {
      return bodies.angularInverseMassAbout(row.indexB, rowAxis.x, rowAxis.y, rowAxis.z) + (row.indexA >= 0 ? bodies.angularInverseMassAbout(row.indexA, rowAxis.x, rowAxis.y, rowAxis.z) : 0);
    }
    return (
      bodies.inverseMassAlong(row.indexB, armB.x, armB.y, armB.z, rowAxis.x, rowAxis.y, rowAxis.z) +
      (row.indexA >= 0 ? bodies.inverseMassAlong(row.indexA, armA.x, armA.y, armA.z, rowAxis.x, rowAxis.y, rowAxis.z) : 0)
    );
  }

  /** Pushes the moving frame along (or turns it about) `rowAxis` by `impulse`, and the base the opposite way. */
  private apply(bodies: BodyTable, row: JointRow, kind: 'linear' | 'angular', rowAxis: Vector3, impulse: number): void {
    const impulseX = rowAxis.x * impulse;
    const impulseY = rowAxis.y * impulse;
    const impulseZ = rowAxis.z * impulse;
    if (kind === 'angular') {
      bodies.applyAngularImpulse(row.indexB, impulseX, impulseY, impulseZ);
      if (row.indexA >= 0) bodies.applyAngularImpulse(row.indexA, -impulseX, -impulseY, -impulseZ);
      return;
    }
    bodies.applyImpulse(row.indexB, impulseX, impulseY, impulseZ, armB.x, armB.y, armB.z);
    if (row.indexA >= 0) bodies.applyImpulse(row.indexA, -impulseX, -impulseY, -impulseZ, armA.x, armA.y, armA.z);
  }
}

/** A frame's origin as an offset from the body's centre of mass, in world space, as the body is now. */
function startArm(body: SolverBody, frame: JointFrame): Vector3 {
  return body.pointToWorld(frame.position, worldPoint).clone().sub(worldCenter.copy(body.worldCenterOfMass));
}

function bodyOrientation(bodies: BodyTable, index: number, target: Quaternion): Quaternion {
  const offsetInArray = 4 * index;
  return target.set(bodies.orientations[offsetInArray]!, bodies.orientations[offsetInArray + 1]!, bodies.orientations[offsetInArray + 2]!, bodies.orientations[offsetInArray + 3]!);
}

function centerOf(bodies: BodyTable, index: number, target: Vector3): Vector3 {
  return target.set(bodies.centers[3 * index]!, bodies.centers[3 * index + 1]!, bodies.centers[3 * index + 2]!);
}

function turnArm(bodies: BodyTable, index: number, startArmValue: Vector3, target: Vector3): Vector3 {
  bodies.turnedSinceStart(index, startArmValue.x, startArmValue.y, startArmValue.z, scratch);
  return target.set(scratch[0]!, scratch[1]!, scratch[2]!);
}

function spinOf(bodies: BodyTable, index: number, target: Vector3): Vector3 {
  return target.set(bodies.spins[3 * index]!, bodies.spins[3 * index + 1]!, bodies.spins[3 * index + 2]!);
}

function spinAlong(bodies: BodyTable, index: number, direction: Vector3): number {
  return bodies.spins[3 * index]! * direction.x + bodies.spins[3 * index + 1]! * direction.y + bodies.spins[3 * index + 2]! * direction.z;
}

/** Whether a joint holds its frames' origins together, all three linear axes locked. */
function holdsPoint(row: JointRow): boolean {
  const linear = row.joint.linear;
  return linear[0] === 'locked' && linear[1] === 'locked' && linear[2] === 'locked';
}

const pointInverseMass = new Float64Array(6);
