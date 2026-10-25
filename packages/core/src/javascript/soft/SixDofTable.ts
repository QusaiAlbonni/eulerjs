import { Vector3 } from 'three';
import type { AxisMotion, JointFrame, SixDofJoint } from '../../joints/SixDofJoint.js';
import { coneLimitToward, driveGains, driveImpulse, driveLimit, hasSpring, invertSymmetric, splitTurn, swingCone, turnsFreely, turnToTargetInto } from '../../joints/sixDofMath.js';
import type { SolverBody } from '../SolverBody.js';
import { BallJointTable } from './BallJointTable.js';
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
 *
 * Each joint's settings are read into numbers when the step begins, and its impulses, masses and
 * loads are kept in flat arrays, a joint's after another's; the frames are measured into numbers
 * on each pass, with the products three.js's quaternions and vectors would work out.
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

/** What an axis lets the joint do (see `AxisMotion`), as a number: kept for each of the six, linear then angular. */
const FREE = 0;
const LOCKED = 1;
const LIMITED = 2;

/** Each joint's layout, as bits: the cases its rows are found by. */
/** All three linear axes locked: the point is held as one block. */
const HOLDS_POINT = 1;
/** All three angular axes locked: the whole turn is held at zero, as a rotation vector. */
const LOCKS_TURN = 2;
/** The swing axes limited alike either way, which makes a cone (see `swingCone`). */
const CONE = 4;
/** No angular axis locked: friction holds the whole turn alike every way. */
const TURNS_FREELY = 8;
/** A drive on some axis, or an orientation drive. */
const DRIVEN = 16;

/** Where each joint's loads are kept: the impulse along its linear and about its angular axes on the last substep, then the orientation drive's. */
const LAST_LINEAR = 0;
const LAST_ANGULAR = 3;
const ORIENTATION_IMPULSE = 6;
const LOAD_COUNT = 9;

/** Where each joint's frames are kept: the base frame's quaternion and position, then the moving frame's quaternion. */
const BASE_QUATERNION = 0;
const BASE_POSITION = 4;
const MOVING_QUATERNION = 7;
const FRAME_COUNT = 11;

const startArmA = new Vector3();
const startArmB = new Vector3();
const worldPoint = new Vector3();
const worldCenter = new Vector3();
/** A frame's axis, the linear offset in frame A, and a body's velocity at a point, from the helpers that work them out. */
const axis = new Float64Array(3);
const offset = new Float64Array(3);
const scratch = new Float64Array(3);
const otherScratch = new Float64Array(3);
const turnScratch = new Float64Array(3);
const pointInverseMass = new Float64Array(6);

export class SixDofTable {
  private count = 0;
  private joints: SixDofJoint[] = [];
  /** The body each joint's base frame is on, or -1 for a joint to the world; the body whose frame moves against it (see `SixDofJoint.roles`). */
  private indexA = new Int32Array(0);
  private indexB = new Int32Array(0);
  private layouts = new Uint8Array(0);
  /** Six per joint, linear then angular: FREE, LOCKED or LIMITED, and each limit's lower and upper. */
  private motions = new Uint8Array(0);
  private limits = new Float64Array(0);
  /** A cone's half widths about y and z. */
  private cones = new Float64Array(0);
  /** The friction about the angular axes, then along the linear ones. */
  private frictions = new Float64Array(0);
  private frames = new Float64Array(0);
  /** The frames' origins as offsets from the centres of mass when the step began, in world space, A's then B's. */
  private startArms = new Float64Array(0);
  private impulses = new Float64Array(0);
  /** Each row's inverse mass along its axis, worked out once a substep when it warm starts. */
  private masses = new Float64Array(0);
  /**
   * For a joint whose linear axes are all locked, the point is held as one block rather than three
   * rows: the inverse of its effective inverse mass K, a symmetric tensor (xx xy xz yy yz zz).
   */
  private pointMasses = new Float64Array(0);
  private loads = new Float64Array(0);
  /** Each joint's impulses from step to step, which its rows take up when the step begins. */
  private keptImpulses: Float64Array[] = [];
  private readonly kept = new Map<SixDofJoint, Float64Array>();
  /** The ball joints that are nothing more, solved apart, and where their impulses are kept, in the same order. */
  private readonly balls = new BallJointTable();
  private readonly ballJoints: SixDofJoint[] = [];
  private readonly ballImpulses: Float64Array[] = [];

  /** The joint being worked on, as `measure` found it: its two bodies, its frames' turns, arms and origins, and the turn of B in A, split. */
  private base = -1;
  private moving = -1;
  private orientationAX = 0;
  private orientationAY = 0;
  private orientationAZ = 0;
  private orientationAW = 1;
  private orientationBX = 0;
  private orientationBY = 0;
  private orientationBZ = 0;
  private orientationBW = 1;
  private relativeX = 0;
  private relativeY = 0;
  private relativeZ = 0;
  private relativeW = 1;
  private twist = 0;
  private swingY = 0;
  private swingZ = 0;
  private armAX = 0;
  private armAY = 0;
  private armAZ = 0;
  private armBX = 0;
  private armBY = 0;
  private armBZ = 0;
  private pointAX = 0;
  private pointAY = 0;
  private pointAZ = 0;
  private pointBX = 0;
  private pointBY = 0;
  private pointBZ = 0;

  prepare(joints: ReadonlyMap<SixDofJoint, readonly [SolverBody, SolverBody | undefined]>): void {
    this.count = 0;
    this.ballJoints.length = 0;
    this.ballImpulses.length = 0;
    this.balls.reset(joints.size);
    if (this.indexA.length < joints.size) this.grow(Math.max(joints.size, 2 * this.indexA.length, 16));
    for (const [joint, [solverA, solverB]] of joints) {
      // each joint's impulses kept from step to step: only where it is is new
      let kept = this.kept.get(joint);
      if (!kept) {
        kept = new Float64Array(SLOT_COUNT);
        this.kept.set(joint, kept);
      }
      const base = solverB ? solverA : undefined;
      const moving = solverB ?? solverA;
      const roles = joint.roles;
      const indexA = base ? base.tableRow : -1;
      const indexB = moving.tableRow;
      if (base) startArm(base, roles.base, startArmA);
      else startArmA.set(0, 0, 0);
      startArm(moving, roles.moving, startArmB);
      // a ball joint and nothing more, as its settings are when the step begins, is solved with the others like it
      if (isPlainBall(joint)) {
        this.balls.add(indexA, indexB, startArmA, startArmB, roles.base.position, kept);
        this.ballJoints.push(joint);
        this.ballImpulses.push(kept);
        continue;
      }
      const row = this.count++;
      this.joints[row] = joint;
      this.keptImpulses[row] = kept;
      this.indexA[row] = indexA;
      this.indexB[row] = indexB;
      this.readSettings(row, joint);
      const frame = FRAME_COUNT * row;
      writeQuaternion(this.frames, frame + BASE_QUATERNION, roles.base);
      this.frames[frame + BASE_POSITION] = roles.base.position.x;
      this.frames[frame + BASE_POSITION + 1] = roles.base.position.y;
      this.frames[frame + BASE_POSITION + 2] = roles.base.position.z;
      writeQuaternion(this.frames, frame + MOVING_QUATERNION, roles.moving);
      const six = 6 * row;
      this.startArms[six] = startArmA.x;
      this.startArms[six + 1] = startArmA.y;
      this.startArms[six + 2] = startArmA.z;
      this.startArms[six + 3] = startArmB.x;
      this.startArms[six + 4] = startArmB.y;
      this.startArms[six + 5] = startArmB.z;
      const slots = SLOT_COUNT * row;
      for (let slot = 0; slot < SLOT_COUNT; slot++) this.impulses[slots + slot] = kept[slot]!;
      clear(this.masses, slots, SLOT_COUNT);
      clear(this.loads, LOAD_COUNT * row, LOAD_COUNT);
    }
    this.joints.length = this.count;
    this.keptImpulses.length = this.count;
  }

  /** Works out every row's inverse mass for the substep, and applies the impulses the rows ended the last one with. */
  warmStart(bodies: BodyTable): void {
    this.balls.warmStart(bodies);
    const impulses = this.impulses;
    for (let row = 0; row < this.count; row++) {
      this.measure(bodies, row);
      const slots = SLOT_COUNT * row;
      clear(this.masses, slots, SLOT_COUNT);
      const layout = this.layouts[row]!;
      if (layout & HOLDS_POINT) {
        this.preparePoint(bodies, row);
        if (impulses[slots] !== 0 || impulses[slots + 1] !== 0 || impulses[slots + 2] !== 0) this.applyPoint(bodies, impulses[slots]!, impulses[slots + 1]!, impulses[slots + 2]!);
      }
      this.warmRows(bodies, row, layout);
      this.warmFriction(bodies, row, layout);
      if (this.frictions[2 * row]! > 0 && layout & TURNS_FREELY) {
        this.turnByVector(bodies, impulses[slots + FRICTION_SLOTS]!, impulses[slots + FRICTION_SLOTS + 1]!, impulses[slots + FRICTION_SLOTS + 2]!);
      }
    }
  }

  /** One pass over every joint's rows; with `softness`, the biased pass, which also runs the drives. */
  solve(bodies: BodyTable, substep: number, softness: Softness | undefined): void {
    this.balls.solve(bodies, softness);
    for (let row = 0; row < this.count; row++) {
      clear(this.loads, LOAD_COUNT * row + LAST_LINEAR, 6);
      this.measure(bodies, row);
      const layout = this.layouts[row]!;
      this.solveConstraints(bodies, row, layout, substep, softness);
      if (softness) {
        if (layout & DRIVEN) this.solveDrives(bodies, row, layout, substep);
      } else this.countDriveLoads(row);
      this.solveFriction(bodies, row, layout, substep);
    }
  }

  /** Writes each joint's loads over the last substep, and keeps its impulses for the next step. */
  finish(substep: number): void {
    const { loads, impulses } = this;
    for (let row = 0; row < this.count; row++) {
      const joint = this.joints[row]!;
      const at = LOAD_COUNT * row;
      joint.force.set(loads[at + LAST_LINEAR]!, loads[at + LAST_LINEAR + 1]!, loads[at + LAST_LINEAR + 2]!).divideScalar(substep);
      joint.torque.set(loads[at + LAST_ANGULAR]!, loads[at + LAST_ANGULAR + 1]!, loads[at + LAST_ANGULAR + 2]!).divideScalar(substep);
      const kept = this.keptImpulses[row]!;
      const slots = SLOT_COUNT * row;
      for (let slot = 0; slot < SLOT_COUNT; slot++) kept[slot] = impulses[slots + slot]!;
    }
    // the ball joints' impulses kept for the next step, and their loads: the point's, and no torque
    this.ballJoints.forEach((joint, ball) => {
      const kept = this.ballImpulses[ball]!;
      this.balls.impulseInto(ball, kept);
      joint.force.set(kept[0]!, kept[1]!, kept[2]!).divideScalar(substep);
      joint.torque.set(0, 0, 0);
    });
  }

  forget(joint: SixDofJoint): void {
    this.kept.delete(joint);
  }

  /** Reads what the joint lets each axis do, and the rest of its settings, into row `row`'s numbers. */
  private readSettings(row: number, joint: SixDofJoint): void {
    const { linear, angular, linearDrives, angularDrives } = joint;
    for (let index = 0; index < 6; index++) {
      const motion = index < 3 ? linear[index]! : angular[index - 3]!;
      const at = 6 * row + index;
      if (motion === 'free') this.motions[at] = FREE;
      else if (motion === 'locked') this.motions[at] = LOCKED;
      else {
        this.motions[at] = LIMITED;
        this.limits[2 * at] = motion.lower;
        this.limits[2 * at + 1] = motion.upper;
      }
    }
    const cone = swingCone(angular[1]!, angular[2]!);
    if (cone) {
      this.cones[2 * row] = cone.aboutY;
      this.cones[2 * row + 1] = cone.aboutZ;
    }
    const driven = joint.orientationDrive || linearDrives.some(Boolean) || angularDrives.some(Boolean);
    this.layouts[row] =
      (allLocked(linear) ? HOLDS_POINT : 0) | (allLocked(angular) ? LOCKS_TURN : 0) | (cone ? CONE : 0) | (turnsFreely(angular) ? TURNS_FREELY : 0) | (driven ? DRIVEN : 0);
    this.frictions[2 * row] = joint.friction;
    this.frictions[2 * row + 1] = joint.linearFriction;
  }

  private solveConstraints(bodies: BodyTable, row: number, layout: number, substep: number, softness: Softness | undefined): void {
    if (layout & HOLDS_POINT) this.solvePoint(bodies, row, softness);
    else {
      // linear axes, in frame A
      this.offsetInFrameA();
      for (let index = 0; index < 3; index++) {
        this.axisOfA(index);
        this.solveAxis(bodies, row, LINEAR_SLOTS + 2 * index, true, axis[0]!, axis[1]!, axis[2]!, offset[index]!, index, substep, softness);
      }
    }
    if (layout & LOCKS_TURN) {
      // the whole turn of frame B in frame A, as a rotation vector, held at zero
      const sign = this.relativeW < 0 ? -1 : 1;
      for (let index = 0; index < 3; index++) {
        this.axisOfA(index);
        const value = 2 * sign * (index === 0 ? this.relativeX : index === 1 ? this.relativeY : this.relativeZ);
        this.solveRow(bodies, row, TWIST_SLOTS + 2 * index, false, axis[0]!, axis[1]!, axis[2]!, value, false, substep, softness);
      }
      return;
    }
    this.axisOfB();
    this.solveAxis(bodies, row, TWIST_SLOTS, false, axis[0]!, axis[1]!, axis[2]!, this.twist, 3, substep, softness);
    if (layout & CONE) {
      // one row, along the way the axis leans, holding the lean within the cone
      const lean = Math.sqrt(this.swingY * this.swingY + this.swingZ * this.swingZ);
      if (lean < 1e-9) return;
      this.leanAxis(lean);
      const limit = coneLimitToward(this.cones[2 * row]!, this.cones[2 * row + 1]!, this.swingY, this.swingZ, lean);
      this.solveRow(bodies, row, SWING_SLOTS, false, axis[0]!, axis[1]!, axis[2]!, limit - lean, true, substep, softness);
      return;
    }
    for (let index = 1; index < 3; index++) {
      this.axisOfA(index);
      this.solveAxis(bodies, row, SWING_SLOTS + 2 * (index - 1), false, axis[0]!, axis[1]!, axis[2]!, index === 1 ? this.swingY : this.swingZ, 3 + index, substep, softness);
    }
  }

  /** The rows for axis `axisIndex` (0 to 5, linear then angular): one held at zero if it is locked, one for each limit if it has limits, none if it is free. */
  private solveAxis(
    bodies: BodyTable,
    row: number,
    slot: number,
    linear: boolean,
    axisX: number,
    axisY: number,
    axisZ: number,
    value: number,
    axisIndex: number,
    substep: number,
    softness: Softness | undefined,
  ): void {
    const at = 6 * row + axisIndex;
    const motion = this.motions[at]!;
    if (motion === FREE) return;
    if (motion === LOCKED) {
      this.solveRow(bodies, row, slot, linear, axisX, axisY, axisZ, value, false, substep, softness);
      return;
    }
    this.solveRow(bodies, row, slot, linear, axisX, axisY, axisZ, value - this.limits[2 * at]!, true, substep, softness);
    this.solveRow(bodies, row, slot + 1, linear, -axisX, -axisY, -axisZ, this.limits[2 * at + 1]! - value, true, substep, softness);
  }

  /**
   * One row: drives `value` to zero along the axis (frame B's motion relative to frame A), or,
   * if `oneSided`, keeps it from going below zero, pushing only once it would.
   */
  private solveRow(
    bodies: BodyTable,
    row: number,
    slot: number,
    linear: boolean,
    axisX: number,
    axisY: number,
    axisZ: number,
    value: number,
    oneSided: boolean,
    substep: number,
    softness: Softness | undefined,
  ): void {
    const at = SLOT_COUNT * row + slot;
    // a row that wasn't there at warm start, such as a cone's the moment the axis leans, works its mass out now
    let inverseMass = this.masses[at]!;
    if (inverseMass === 0) inverseMass = this.masses[at] = this.inverseMassAlong(bodies, linear, axisX, axisY, axisZ);
    if (inverseMass === 0) return;
    const speed = this.speedAlong(bodies, linear, axisX, axisY, axisZ);
    // one-sided rows the axis hasn't reached yet let it close the gap over the substep
    let biasRate = 1 / substep;
    let massScale = 1;
    let impulseScale = 0;
    if (!(oneSided && value > 0)) {
      const soft = softness ?? RIGID;
      biasRate = soft.biasRate;
      massScale = soft.massScale;
      impulseScale = soft.impulseScale;
    }
    const accumulated = this.impulses[at]!;
    const change = (-massScale * (speed + biasRate * value)) / inverseMass - impulseScale * accumulated;
    let impulse = accumulated + change;
    if (oneSided) impulse = Math.max(impulse, 0);
    this.impulses[at] = impulse;
    const applied = impulse - accumulated;
    if (applied !== 0) this.apply(bodies, linear, axisX, axisY, axisZ, applied);
    this.addLoad(row, linear ? LAST_LINEAR : LAST_ANGULAR, axisX, axisY, axisZ, impulse);
  }

  private solveDrives(bodies: BodyTable, row: number, layout: number, substep: number): void {
    const { linearDrives, angularDrives } = this.joints[row]!;
    this.offsetInFrameA();
    for (let index = 0; index < 6; index++) {
      const isLinear = index < 3;
      const axisIndex = index % 3;
      const drive = isLinear ? linearDrives[axisIndex] : angularDrives[axisIndex];
      if (!drive || this.motions[6 * row + index] === LOCKED) continue;
      if (!isLinear && axisIndex === 0) this.axisOfB();
      else this.axisOfA(axisIndex);
      const axisX = axis[0]!;
      const axisY = axis[1]!;
      const axisZ = axis[2]!;
      const position = isLinear ? offset[axisIndex]! : axisIndex === 0 ? this.twist : axisIndex === 1 ? this.swingY : this.swingZ;
      const inverseMass = this.inverseMassAlong(bodies, isLinear, axisX, axisY, axisZ);
      const gainInverseMass = isLinear ? inverseMass : this.gainInverseMass(bodies, layout, axisX, axisY, axisZ);
      const limit = driveLimit(drive, substep);
      const impulse = Math.min(Math.max(driveImpulse(drive, position, this.speedAlong(bodies, isLinear, axisX, axisY, axisZ), inverseMass, substep, gainInverseMass), -limit), limit);
      this.impulses[SLOT_COUNT * row + DRIVE_SLOTS + index] = impulse;
      if (impulse === 0) continue;
      this.apply(bodies, isLinear, axisX, axisY, axisZ, impulse);
      this.addLoad(row, isLinear ? LAST_LINEAR : LAST_ANGULAR, axisX, axisY, axisZ, impulse);
    }
    this.solveOrientationDrive(bodies, row, layout, substep);
  }

  /**
   * The orientation drive, as two rows: a spring and damper about the axis of the turn to the
   * target, then its damping against whatever spin is left across that axis, so that it damps
   * the same every way and still damps once the target is reached.
   */
  private solveOrientationDrive(bodies: BodyTable, row: number, layout: number, substep: number): void {
    clear(this.loads, LOAD_COUNT * row + ORIENTATION_IMPULSE, 3);
    const drive = this.joints[row]!.orientationDrive;
    if (!drive) return;
    const limit = (drive.maxTorque ?? Infinity) * substep;
    let turning = false;
    let axisX = 0;
    let axisY = 0;
    let axisZ = 0;
    if (hasSpring(drive)) {
      const target = drive.target;
      turnToTargetInto(
        this.orientationAX,
        this.orientationAY,
        this.orientationAZ,
        this.orientationAW,
        target.x,
        target.y,
        target.z,
        target.w,
        this.orientationBX,
        this.orientationBY,
        this.orientationBZ,
        this.orientationBW,
        scratch,
      );
      const rotationX = scratch[0]!;
      const rotationY = scratch[1]!;
      const rotationZ = scratch[2]!;
      const angle = Math.sqrt(rotationX * rotationX + rotationY * rotationY + rotationZ * rotationZ);
      turning = angle > 1e-12;
      if (turning) {
        // as three.js divides a vector: by multiplying by the inverse
        const inverseAngle = 1 / angle;
        axisX = rotationX * inverseAngle;
        axisY = rotationY * inverseAngle;
        axisZ = rotationZ * inverseAngle;
        const inverseMass = this.inverseMassAlong(bodies, false, axisX, axisY, axisZ);
        const speed = this.speedAlong(bodies, false, axisX, axisY, axisZ);
        const spring = { stiffness: drive.stiffness, damping: drive.damping, frequency: drive.frequency, dampingRatio: drive.dampingRatio, targetPosition: angle };
        const impulse = driveImpulse(spring, 0, speed, inverseMass, substep, this.gainInverseMass(bodies, layout, axisX, axisY, axisZ));
        this.turnOrientation(bodies, row, axisX, axisY, axisZ, Math.min(Math.max(impulse, -limit), limit));
      }
    }
    // the spin relative to the base left across the turn's axis, or all of it with no turn to make
    const spins = bodies.spins;
    const moving = 3 * this.moving;
    let spinX = spins[moving]!;
    let spinY = spins[moving + 1]!;
    let spinZ = spins[moving + 2]!;
    if (this.base >= 0) {
      const base = 3 * this.base;
      spinX = spinX - spins[base]!;
      spinY = spinY - spins[base + 1]!;
      spinZ = spinZ - spins[base + 2]!;
    }
    if (turning) {
      const across = -(spinX * axisX + spinY * axisY + spinZ * axisZ);
      spinX = spinX + axisX * across;
      spinY = spinY + axisY * across;
      spinZ = spinZ + axisZ * across;
    }
    const spin = Math.sqrt(spinX * spinX + spinY * spinY + spinZ * spinZ);
    if (spin < 1e-9) return;
    const inverseSpin = 1 / spin;
    axisX = spinX * inverseSpin;
    axisY = spinY * inverseSpin;
    axisZ = spinZ * inverseSpin;
    const inverseMass = this.inverseMassAlong(bodies, false, axisX, axisY, axisZ);
    const damping = hasSpring(drive) ? driveGains(drive, this.gainInverseMass(bodies, layout, axisX, axisY, axisZ)).damping : (drive.damping ?? Infinity);
    this.turnOrientation(bodies, row, axisX, axisY, axisZ, Math.min(Math.max(driveImpulse({ damping }, 0, spin, inverseMass, substep), -limit), limit));
  }

  /**
   * How hard the joint is to turn about the axis, for drives set by frequency: about the point
   * it holds, if it holds one, or else about the bodies' centres of mass.
   */
  private gainInverseMass(bodies: BodyTable, layout: number, axisX: number, axisY: number, axisZ: number): number {
    if (!(layout & HOLDS_POINT)) return this.inverseMassAlong(bodies, false, axisX, axisY, axisZ);
    const pinnedB = bodies.pinnedInverseInertiaAbout(this.moving, this.armBX, this.armBY, this.armBZ, axisX, axisY, axisZ);
    return pinnedB + (this.base >= 0 ? bodies.pinnedInverseInertiaAbout(this.base, this.armAX, this.armAY, this.armAZ, axisX, axisY, axisZ) : 0);
  }

  private turnOrientation(bodies: BodyTable, row: number, axisX: number, axisY: number, axisZ: number, impulse: number): void {
    if (impulse === 0) return;
    this.apply(bodies, false, axisX, axisY, axisZ, impulse);
    this.addLoad(row, ORIENTATION_IMPULSE, axisX, axisY, axisZ, impulse);
    this.addLoad(row, LAST_ANGULAR, axisX, axisY, axisZ, impulse);
  }

  /**
   * Friction: on each axis the joint doesn't lock, an impulse against the motion along it, kept
   * through the substep's passes and held within the friction force (or torque) times the substep.
   * A joint that locks no angular axis resists its whole spin at once instead, within a circle.
   */
  private solveFriction(bodies: BodyTable, row: number, layout: number, substep: number): void {
    const friction = this.frictions[2 * row]!;
    const linearFriction = this.frictions[2 * row + 1]!;
    if (friction <= 0 && linearFriction <= 0) return;
    if (friction > 0 && layout & TURNS_FREELY) this.solveBallFriction(bodies, row, friction * substep);
    // a ball joint's friction isn't a row per axis: see solveBallFriction
    const perAxis = !(layout & TURNS_FREELY);
    for (let index = 0; index < 3; index++) {
      if (perAxis && friction > 0 && this.motions[6 * row + 3 + index] !== LOCKED) {
        if (index === 0) this.axisOfB();
        else this.axisOfA(index);
        this.solveFrictionRow(bodies, row, FRICTION_SLOTS + index, false, axis[0]!, axis[1]!, axis[2]!, friction * substep);
      }
      if (linearFriction > 0 && this.motions[6 * row + index] !== LOCKED) {
        this.axisOfA(index);
        this.solveFrictionRow(bodies, row, LINEAR_FRICTION_SLOTS + index, true, axis[0]!, axis[1]!, axis[2]!, linearFriction * substep);
      }
    }
  }

  private solveFrictionRow(bodies: BodyTable, row: number, slot: number, linear: boolean, axisX: number, axisY: number, axisZ: number, limit: number): void {
    const at = SLOT_COUNT * row + slot;
    let inverseMass = this.masses[at]!;
    if (inverseMass === 0) inverseMass = this.masses[at] = this.inverseMassAlong(bodies, linear, axisX, axisY, axisZ);
    if (inverseMass === 0) return;
    const accumulated = this.impulses[at]!;
    const impulse = Math.min(Math.max(accumulated - this.speedAlong(bodies, linear, axisX, axisY, axisZ) / inverseMass, -limit), limit);
    this.impulses[at] = impulse;
    if (impulse !== accumulated) this.apply(bodies, linear, axisX, axisY, axisZ, impulse - accumulated);
    this.addLoad(row, linear ? LAST_LINEAR : LAST_ANGULAR, axisX, axisY, axisZ, impulse);
  }

  /**
   * A ball joint's friction: the angular impulse stopping its relative spin, kept as a vector in
   * the friction slots through the substep, and no longer than `limit`.
   */
  private solveBallFriction(bodies: BodyTable, row: number, limit: number): void {
    const spins = bodies.spins;
    const moving = 3 * this.moving;
    let spinX = spins[moving]!;
    let spinY = spins[moving + 1]!;
    let spinZ = spins[moving + 2]!;
    if (this.base >= 0) {
      const base = 3 * this.base;
      spinX = spinX - spins[base]!;
      spinY = spinY - spins[base + 1]!;
      spinZ = spinZ - spins[base + 2]!;
    }
    const spin = Math.sqrt(spinX * spinX + spinY * spinY + spinZ * spinZ);
    const impulses = this.impulses;
    const slots = SLOT_COUNT * row + FRICTION_SLOTS;
    let accumulatedX = impulses[slots]!;
    let accumulatedY = impulses[slots + 1]!;
    let accumulatedZ = impulses[slots + 2]!;
    if (spin > 1e-12) {
      const inverseSpin = 1 / spin;
      const axisX = spinX * inverseSpin;
      const axisY = spinY * inverseSpin;
      const axisZ = spinZ * inverseSpin;
      const inverseMass = this.inverseMassAlong(bodies, false, axisX, axisY, axisZ);
      if (inverseMass > 0) {
        const stopping = -spin / inverseMass;
        let heldX = accumulatedX + axisX * stopping;
        let heldY = accumulatedY + axisY * stopping;
        let heldZ = accumulatedZ + axisZ * stopping;
        const length = Math.sqrt(heldX * heldX + heldY * heldY + heldZ * heldZ);
        if (length > limit) {
          // as three.js sets a vector's length: normalized, by multiplying by the inverse, then scaled
          const inverseLength = 1 / (length || 1);
          heldX = heldX * inverseLength * limit;
          heldY = heldY * inverseLength * limit;
          heldZ = heldZ * inverseLength * limit;
        }
        this.turnByVector(bodies, heldX - accumulatedX, heldY - accumulatedY, heldZ - accumulatedZ);
        impulses[slots] = heldX;
        impulses[slots + 1] = heldY;
        impulses[slots + 2] = heldZ;
        accumulatedX = heldX;
        accumulatedY = heldY;
        accumulatedZ = heldZ;
      }
    }
    const loads = LOAD_COUNT * row + LAST_ANGULAR;
    this.loads[loads] = this.loads[loads]! + accumulatedX;
    this.loads[loads + 1] = this.loads[loads + 1]! + accumulatedY;
    this.loads[loads + 2] = this.loads[loads + 2]! + accumulatedZ;
  }

  /** Turns the moving body by the angular impulse (world space), and the base the other way. */
  private turnByVector(bodies: BodyTable, impulseX: number, impulseY: number, impulseZ: number): void {
    const size = Math.sqrt(impulseX * impulseX + impulseY * impulseY + impulseZ * impulseZ);
    if (!(size > 0)) return;
    const inverseSize = 1 / size;
    this.apply(bodies, false, impulseX * inverseSize, impulseY * inverseSize, impulseZ * inverseSize, size);
  }

  /** Works out the inverse of the point's effective inverse mass for the substep. */
  private preparePoint(bodies: BodyTable, row: number): void {
    clear(pointInverseMass, 0, 6);
    bodies.addPointInverseMass(this.moving, this.armBX, this.armBY, this.armBZ, pointInverseMass);
    if (this.base >= 0) bodies.addPointInverseMass(this.base, this.armAX, this.armAY, this.armAZ, pointInverseMass);
    invertSymmetric(pointInverseMass, this.pointMasses, 6 * row);
  }

  /**
   * The point as one block: the impulse vector that, with the soft spring's pull back toward
   * where the frames' origins meet, stops them moving apart, kept in the first three slots.
   */
  private solvePoint(bodies: BodyTable, row: number, softness: Softness | undefined): void {
    const soft = softness ?? RIGID;
    bodies.pointVelocity(this.moving, this.armBX, this.armBY, this.armBZ, scratch);
    let speedX = scratch[0]!;
    let speedY = scratch[1]!;
    let speedZ = scratch[2]!;
    if (this.base >= 0) {
      bodies.pointVelocity(this.base, this.armAX, this.armAY, this.armAZ, otherScratch);
      speedX -= otherScratch[0]!;
      speedY -= otherScratch[1]!;
      speedZ -= otherScratch[2]!;
    }
    const pullX = speedX + soft.biasRate * (this.pointBX - this.pointAX);
    const pullY = speedY + soft.biasRate * (this.pointBY - this.pointAY);
    const pullZ = speedZ + soft.biasRate * (this.pointBZ - this.pointAZ);
    const mass = this.pointMasses;
    const tensor = 6 * row;
    const impulses = this.impulses;
    const slots = SLOT_COUNT * row;
    const changeX = -soft.massScale * (mass[tensor]! * pullX + mass[tensor + 1]! * pullY + mass[tensor + 2]! * pullZ) - soft.impulseScale * impulses[slots]!;
    const changeY = -soft.massScale * (mass[tensor + 1]! * pullX + mass[tensor + 3]! * pullY + mass[tensor + 4]! * pullZ) - soft.impulseScale * impulses[slots + 1]!;
    const changeZ = -soft.massScale * (mass[tensor + 2]! * pullX + mass[tensor + 4]! * pullY + mass[tensor + 5]! * pullZ) - soft.impulseScale * impulses[slots + 2]!;
    impulses[slots] = impulses[slots]! + changeX;
    impulses[slots + 1] = impulses[slots + 1]! + changeY;
    impulses[slots + 2] = impulses[slots + 2]! + changeZ;
    this.applyPoint(bodies, changeX, changeY, changeZ);
    const loads = LOAD_COUNT * row + LAST_LINEAR;
    this.loads[loads] = this.loads[loads]! + impulses[slots]!;
    this.loads[loads + 1] = this.loads[loads + 1]! + impulses[slots + 1]!;
    this.loads[loads + 2] = this.loads[loads + 2]! + impulses[slots + 2]!;
  }

  /** Pushes the moving frame's origin by the impulse, and the base's by the opposite. */
  private applyPoint(bodies: BodyTable, impulseX: number, impulseY: number, impulseZ: number): void {
    bodies.applyImpulse(this.moving, impulseX, impulseY, impulseZ, this.armBX, this.armBY, this.armBZ);
    if (this.base >= 0) bodies.applyImpulse(this.base, -impulseX, -impulseY, -impulseZ, this.armAX, this.armAY, this.armAZ);
  }

  /** Adds the impulses the drives gave on this substep to the loads the joint reports. */
  private countDriveLoads(row: number): void {
    const slots = SLOT_COUNT * row + DRIVE_SLOTS;
    for (let index = 0; index < 6; index++) {
      const impulse = this.impulses[slots + index]!;
      if (impulse === 0) continue;
      if (index === 3) this.axisOfB();
      else this.axisOfA(index % 3);
      this.addLoad(row, index < 3 ? LAST_LINEAR : LAST_ANGULAR, axis[0]!, axis[1]!, axis[2]!, impulse);
    }
    const loads = LOAD_COUNT * row;
    for (let component = 0; component < 3; component++) {
      this.loads[loads + LAST_ANGULAR + component] = this.loads[loads + LAST_ANGULAR + component]! + this.loads[loads + ORIENTATION_IMPULSE + component]!;
    }
  }

  /** Works out each row's mass for the substep and applies its impulse, in the order the rows are solved in. */
  private warmRows(bodies: BodyTable, row: number, layout: number): void {
    const motions = 6 * row;
    for (let index = 0; index < 3; index++) {
      const motion = this.motions[motions + index]!;
      if (motion === FREE || layout & HOLDS_POINT) continue;
      this.axisOfA(index);
      this.warmRow(bodies, row, LINEAR_SLOTS + 2 * index, true, axis[0]!, axis[1]!, axis[2]!);
      if (motion !== LOCKED) this.warmRow(bodies, row, LINEAR_SLOTS + 2 * index + 1, true, -axis[0]!, -axis[1]!, -axis[2]!);
    }
    if (layout & LOCKS_TURN) {
      for (let index = 0; index < 3; index++) {
        this.axisOfA(index);
        this.warmRow(bodies, row, TWIST_SLOTS + 2 * index, false, axis[0]!, axis[1]!, axis[2]!);
      }
      return;
    }
    const twist = this.motions[motions + 3]!;
    if (twist !== FREE) {
      this.axisOfB();
      this.warmRow(bodies, row, TWIST_SLOTS, false, axis[0]!, axis[1]!, axis[2]!);
      if (twist !== LOCKED) this.warmRow(bodies, row, TWIST_SLOTS + 1, false, -axis[0]!, -axis[1]!, -axis[2]!);
    }
    if (layout & CONE) {
      const lean = Math.sqrt(this.swingY * this.swingY + this.swingZ * this.swingZ);
      if (lean >= 1e-9) {
        this.leanAxis(lean);
        this.warmRow(bodies, row, SWING_SLOTS, false, axis[0]!, axis[1]!, axis[2]!);
      }
      return;
    }
    for (let index = 1; index < 3; index++) {
      const motion = this.motions[motions + 3 + index]!;
      if (motion === FREE) continue;
      this.axisOfA(index);
      this.warmRow(bodies, row, SWING_SLOTS + 2 * (index - 1), false, axis[0]!, axis[1]!, axis[2]!);
      if (motion !== LOCKED) this.warmRow(bodies, row, SWING_SLOTS + 2 * (index - 1) + 1, false, -axis[0]!, -axis[1]!, -axis[2]!);
    }
  }

  /** The same for each friction row the joint has. */
  private warmFriction(bodies: BodyTable, row: number, layout: number): void {
    const friction = this.frictions[2 * row]!;
    const linearFriction = this.frictions[2 * row + 1]!;
    const perAxis = !(layout & TURNS_FREELY);
    for (let index = 0; index < 3; index++) {
      if (perAxis && friction > 0 && this.motions[6 * row + 3 + index] !== LOCKED) {
        if (index === 0) this.axisOfB();
        else this.axisOfA(index);
        this.warmRow(bodies, row, FRICTION_SLOTS + index, false, axis[0]!, axis[1]!, axis[2]!);
      }
      if (linearFriction > 0 && this.motions[6 * row + index] !== LOCKED) {
        this.axisOfA(index);
        this.warmRow(bodies, row, LINEAR_FRICTION_SLOTS + index, true, axis[0]!, axis[1]!, axis[2]!);
      }
    }
  }

  private warmRow(bodies: BodyTable, row: number, slot: number, linear: boolean, axisX: number, axisY: number, axisZ: number): void {
    const at = SLOT_COUNT * row + slot;
    this.masses[at] = this.inverseMassAlong(bodies, linear, axisX, axisY, axisZ);
    const impulse = this.impulses[at]!;
    if (impulse !== 0) this.apply(bodies, linear, axisX, axisY, axisZ, impulse);
  }

  /** The frames as the bodies are now, base as A and moving as B, with the moving frame's turn in the base's. */
  private measure(bodies: BodyTable, row: number): void {
    const { orientations, centers } = bodies;
    const frames = this.frames;
    const frame = FRAME_COUNT * row;
    const six = 6 * row;
    const base = (this.base = this.indexA[row]!);
    const moving = (this.moving = this.indexB[row]!);
    const baseX = frames[frame + BASE_QUATERNION]!;
    const baseY = frames[frame + BASE_QUATERNION + 1]!;
    const baseZ = frames[frame + BASE_QUATERNION + 2]!;
    const baseW = frames[frame + BASE_QUATERNION + 3]!;
    if (base >= 0) {
      // the body's orientation times the frame's, as `multiplyQuaternions`
      const at = 4 * base;
      const bodyX = orientations[at]!;
      const bodyY = orientations[at + 1]!;
      const bodyZ = orientations[at + 2]!;
      const bodyW = orientations[at + 3]!;
      this.orientationAX = bodyX * baseW + bodyW * baseX + bodyY * baseZ - bodyZ * baseY;
      this.orientationAY = bodyY * baseW + bodyW * baseY + bodyZ * baseX - bodyX * baseZ;
      this.orientationAZ = bodyZ * baseW + bodyW * baseZ + bodyX * baseY - bodyY * baseX;
      this.orientationAW = bodyW * baseW - bodyX * baseX - bodyY * baseY - bodyZ * baseZ;
      bodies.turnedSinceStart(base, this.startArms[six]!, this.startArms[six + 1]!, this.startArms[six + 2]!, scratch);
      this.armAX = scratch[0]!;
      this.armAY = scratch[1]!;
      this.armAZ = scratch[2]!;
      this.pointAX = centers[3 * base]! + this.armAX;
      this.pointAY = centers[3 * base + 1]! + this.armAY;
      this.pointAZ = centers[3 * base + 2]! + this.armAZ;
    } else {
      this.orientationAX = baseX;
      this.orientationAY = baseY;
      this.orientationAZ = baseZ;
      this.orientationAW = baseW;
      this.pointAX = frames[frame + BASE_POSITION]!;
      this.pointAY = frames[frame + BASE_POSITION + 1]!;
      this.pointAZ = frames[frame + BASE_POSITION + 2]!;
    }
    const movingX = frames[frame + MOVING_QUATERNION]!;
    const movingY = frames[frame + MOVING_QUATERNION + 1]!;
    const movingZ = frames[frame + MOVING_QUATERNION + 2]!;
    const movingW = frames[frame + MOVING_QUATERNION + 3]!;
    const at = 4 * moving;
    const bodyX = orientations[at]!;
    const bodyY = orientations[at + 1]!;
    const bodyZ = orientations[at + 2]!;
    const bodyW = orientations[at + 3]!;
    const orientationBX = (this.orientationBX = bodyX * movingW + bodyW * movingX + bodyY * movingZ - bodyZ * movingY);
    const orientationBY = (this.orientationBY = bodyY * movingW + bodyW * movingY + bodyZ * movingX - bodyX * movingZ);
    const orientationBZ = (this.orientationBZ = bodyZ * movingW + bodyW * movingZ + bodyX * movingY - bodyY * movingX);
    const orientationBW = (this.orientationBW = bodyW * movingW - bodyX * movingX - bodyY * movingY - bodyZ * movingZ);
    bodies.turnedSinceStart(moving, this.startArms[six + 3]!, this.startArms[six + 4]!, this.startArms[six + 5]!, scratch);
    this.armBX = scratch[0]!;
    this.armBY = scratch[1]!;
    this.armBZ = scratch[2]!;
    this.pointBX = centers[3 * moving]! + this.armBX;
    this.pointBY = centers[3 * moving + 1]! + this.armBY;
    this.pointBZ = centers[3 * moving + 2]! + this.armBZ;
    // B's turn in A: A's inverse (its conjugate) times B
    const inverseX = -this.orientationAX;
    const inverseY = -this.orientationAY;
    const inverseZ = -this.orientationAZ;
    const inverseW = this.orientationAW;
    const relativeX = (this.relativeX = inverseX * orientationBW + inverseW * orientationBX + inverseY * orientationBZ - inverseZ * orientationBY);
    const relativeY = (this.relativeY = inverseY * orientationBW + inverseW * orientationBY + inverseZ * orientationBX - inverseX * orientationBZ);
    const relativeZ = (this.relativeZ = inverseZ * orientationBW + inverseW * orientationBZ + inverseX * orientationBY - inverseY * orientationBX);
    const relativeW = (this.relativeW = inverseW * orientationBW - inverseX * orientationBX - inverseY * orientationBY - inverseZ * orientationBZ);
    splitTurn(relativeX, relativeY, relativeZ, relativeW, turnScratch);
    this.twist = turnScratch[0]!;
    this.swingY = turnScratch[1]!;
    this.swingZ = turnScratch[2]!;
  }

  /** Frame A's axis `index` (0, 1 or 2) as it is turned now, into `axis`. */
  private axisOfA(index: number): void {
    rotate(this.orientationAX, this.orientationAY, this.orientationAZ, this.orientationAW, index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0, axis);
  }

  /** Frame B's x axis, its twist axis, as it is turned now, into `axis`. */
  private axisOfB(): void {
    rotate(this.orientationBX, this.orientationBY, this.orientationBZ, this.orientationBW, 1, 0, 0, axis);
  }

  /** The way a cone's axis leans, `lean` being the swing's length, in frame A turned into the world, and against it: into `axis`. */
  private leanAxis(lean: number): void {
    rotate(this.orientationAX, this.orientationAY, this.orientationAZ, this.orientationAW, 0, this.swingY / lean, this.swingZ / lean, axis);
    axis[0] = -axis[0]!;
    axis[1] = -axis[1]!;
    axis[2] = -axis[2]!;
  }

  /** Where frame B's origin is from frame A's, in frame A's axes, into `offset`. */
  private offsetInFrameA(): void {
    rotate(-this.orientationAX, -this.orientationAY, -this.orientationAZ, this.orientationAW, this.pointBX - this.pointAX, this.pointBY - this.pointAY, this.pointBZ - this.pointAZ, offset);
  }

  /** How fast frame B moves relative to frame A along a linear axis, or turns about an angular one. */
  private speedAlong(bodies: BodyTable, linear: boolean, axisX: number, axisY: number, axisZ: number): number {
    if (!linear) {
      const spins = bodies.spins;
      const moving = 3 * this.moving;
      const spinB = spins[moving]! * axisX + spins[moving + 1]! * axisY + spins[moving + 2]! * axisZ;
      if (this.base < 0) return spinB - 0;
      const base = 3 * this.base;
      return spinB - (spins[base]! * axisX + spins[base + 1]! * axisY + spins[base + 2]! * axisZ);
    }
    bodies.pointVelocity(this.moving, this.armBX, this.armBY, this.armBZ, scratch);
    let speed = scratch[0]! * axisX + scratch[1]! * axisY + scratch[2]! * axisZ;
    if (this.base >= 0) {
      bodies.pointVelocity(this.base, this.armAX, this.armAY, this.armAZ, otherScratch);
      speed -= otherScratch[0]! * axisX + otherScratch[1]! * axisY + otherScratch[2]! * axisZ;
    }
    return speed;
  }

  private inverseMassAlong(bodies: BodyTable, linear: boolean, axisX: number, axisY: number, axisZ: number): number {
    if (!linear) {
      return bodies.angularInverseMassAbout(this.moving, axisX, axisY, axisZ) + (this.base >= 0 ? bodies.angularInverseMassAbout(this.base, axisX, axisY, axisZ) : 0);
    }
    return (
      bodies.inverseMassAlong(this.moving, this.armBX, this.armBY, this.armBZ, axisX, axisY, axisZ) +
      (this.base >= 0 ? bodies.inverseMassAlong(this.base, this.armAX, this.armAY, this.armAZ, axisX, axisY, axisZ) : 0)
    );
  }

  /** Pushes the moving frame along (or turns it about) the axis by `impulse`, and the base the opposite way. */
  private apply(bodies: BodyTable, linear: boolean, axisX: number, axisY: number, axisZ: number, impulse: number): void {
    const impulseX = axisX * impulse;
    const impulseY = axisY * impulse;
    const impulseZ = axisZ * impulse;
    if (!linear) {
      bodies.applyAngularImpulse(this.moving, impulseX, impulseY, impulseZ);
      if (this.base >= 0) bodies.applyAngularImpulse(this.base, -impulseX, -impulseY, -impulseZ);
      return;
    }
    bodies.applyImpulse(this.moving, impulseX, impulseY, impulseZ, this.armBX, this.armBY, this.armBZ);
    if (this.base >= 0) bodies.applyImpulse(this.base, -impulseX, -impulseY, -impulseZ, this.armAX, this.armAY, this.armAZ);
  }

  /** Adds the axis times `impulse` to row `row`'s load from `slot` (LAST_LINEAR, LAST_ANGULAR or ORIENTATION_IMPULSE). */
  private addLoad(row: number, slot: number, axisX: number, axisY: number, axisZ: number, impulse: number): void {
    const at = LOAD_COUNT * row + slot;
    const loads = this.loads;
    loads[at] = loads[at]! + axisX * impulse;
    loads[at + 1] = loads[at + 1]! + axisY * impulse;
    loads[at + 2] = loads[at + 2]! + axisZ * impulse;
  }

  private grow(capacity: number): void {
    this.indexA = new Int32Array(capacity);
    this.indexB = new Int32Array(capacity);
    this.layouts = new Uint8Array(capacity);
    this.motions = new Uint8Array(6 * capacity);
    this.limits = new Float64Array(12 * capacity);
    this.cones = new Float64Array(2 * capacity);
    this.frictions = new Float64Array(2 * capacity);
    this.frames = new Float64Array(FRAME_COUNT * capacity);
    this.startArms = new Float64Array(6 * capacity);
    this.impulses = new Float64Array(SLOT_COUNT * capacity);
    this.masses = new Float64Array(SLOT_COUNT * capacity);
    this.pointMasses = new Float64Array(6 * capacity);
    this.loads = new Float64Array(LOAD_COUNT * capacity);
  }
}

/** Writes v turned by the quaternion (x, y, z, w) into `target`, as three.js's `applyQuaternion` does, product for product. */
function rotate(quaternionX: number, quaternionY: number, quaternionZ: number, quaternionW: number, vectorX: number, vectorY: number, vectorZ: number, target: Float64Array): void {
  // t = 2 q × v; v' = v + w t + q × t
  const twiceCrossX = 2 * (quaternionY * vectorZ - quaternionZ * vectorY);
  const twiceCrossY = 2 * (quaternionZ * vectorX - quaternionX * vectorZ);
  const twiceCrossZ = 2 * (quaternionX * vectorY - quaternionY * vectorX);
  target[0] = vectorX + quaternionW * twiceCrossX + quaternionY * twiceCrossZ - quaternionZ * twiceCrossY;
  target[1] = vectorY + quaternionW * twiceCrossY + quaternionZ * twiceCrossX - quaternionX * twiceCrossZ;
  target[2] = vectorZ + quaternionW * twiceCrossZ + quaternionX * twiceCrossY - quaternionY * twiceCrossX;
}

/**
 * Zeroes `count` numbers of `array` from `at`: a loop the engine compiles in place, where
 * `fill` is a call into the runtime, which costs more than a few numbers are worth.
 */
function clear(array: Float64Array, at: number, count: number): void {
  for (let index = at; index < at + count; index++) array[index] = 0;
}

function writeQuaternion(target: Float64Array, at: number, frame: JointFrame): void {
  target[at] = frame.quaternion.x;
  target[at + 1] = frame.quaternion.y;
  target[at + 2] = frame.quaternion.z;
  target[at + 3] = frame.quaternion.w;
}

/** Into `target`, the frame's origin as an offset from the body's centre of mass, in world space. */
function startArm(body: SolverBody, frame: JointFrame, target: Vector3): Vector3 {
  return target.copy(body.pointToWorld(frame.position, worldPoint)).sub(worldCenter.copy(body.worldCenterOfMass));
}

function allLocked(motions: readonly AxisMotion[]): boolean {
  return motions[0] === 'locked' && motions[1] === 'locked' && motions[2] === 'locked';
}

/** Whether a joint only holds its point, every angle free, with nothing driving it or holding it back: a ball joint. */
function isPlainBall(joint: SixDofJoint): boolean {
  const { linear, angular, linearDrives, angularDrives } = joint;
  return (
    allLocked(linear) &&
    angular[0] === 'free' &&
    angular[1] === 'free' &&
    angular[2] === 'free' &&
    joint.friction <= 0 &&
    joint.linearFriction <= 0 &&
    !joint.orientationDrive &&
    !linearDrives[0] &&
    !linearDrives[1] &&
    !linearDrives[2] &&
    !angularDrives[0] &&
    !angularDrives[1] &&
    !angularDrives[2]
  );
}
