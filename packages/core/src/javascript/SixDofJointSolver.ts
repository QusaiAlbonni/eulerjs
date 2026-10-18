import { Matrix3, Quaternion, Vector3 } from 'three';
import type { JointDrive, JointFrame, SixDofJoint } from '../joints/SixDofJoint.js';
import { driveGains, driveImpulse, driveLimit, excess, frameAxis, hasSpring, pinnedInverseInertia, swingAndTwist, swingCone, swingExcess, turnsFreely, turnToTarget } from '../joints/sixDofMath.js';
import type { FrameTurn } from '../joints/sixDofMath.js';
import type { Constraint } from './Constraint.js';
import {
  angularInverseMass,
  applyAngularPositionalImpulse,
  applyPositionalImpulse,
  applyAngularVelocityImpulse,
  applyVelocityImpulse,
  correctPosition,
  generalizedInverseMass,
  pointAtSubstepStart,
  rotationSinceSubstepStart,
  turnAboutPoint,
} from './positional.js';
import type { SolverBody } from './SolverBody.js';

const pointA = new Vector3();
const pointB = new Vector3();
const orientationA = new Quaternion();
const orientationB = new Quaternion();
const inverseA = new Quaternion();
const inverseB = new Quaternion();
const relative = new Quaternion();
const turn: FrameTurn = { twist: 0, swing: new Vector3() };
const rotationError = new Vector3();
const offset = new Vector3();
const axis = new Vector3();
const correctionDirection = new Vector3();
const angularImpulse = new Vector3();
const velocityA = new Vector3();
const velocityB = new Vector3();
const impulse = new Vector3();
const rotation = new Vector3();
const relativeSpin = new Vector3();
const turnedBase = new Vector3();
const startA = new Vector3();
const startB = new Vector3();

/**
 * Solves a SixDofJoint (and so hinges, sliders, fixed and cone-twist joints) by XPBD, after
 * Müller et al. 2020: each substep turns the bodies to take back whatever turn their frames have
 * beyond what the angular axes allow, then moves them to take back the offset beyond what the
 * linear axes allow. Drives act on velocities afterwards.
 */
export class SixDofJointSolver implements Constraint {
  readonly bodies: readonly SolverBody[];
  /** Positional impulses on the moving body summed over the step, for the force and torque it carried. */
  private readonly linearImpulse = new Vector3();
  private readonly angularImpulse = new Vector3();
  /** Drive impulses on the moving body summed over the step. */
  private readonly driveLinearImpulse = new Vector3();
  private readonly driveAngularImpulse = new Vector3();
  private substepsThisStep = 0;
  /**
   * The angular rows the position pass held on this substep, and for each, the way it pushed (+1
   * or -1 along the axis), or 0 for a locked row, which holds both ways.
   */
  private readonly heldAxes = [new Vector3(), new Vector3(), new Vector3()];
  private readonly heldDirections = new Float64Array(3);
  private heldCount = 0;
  /** The angular rows to take back on the current substep: up to three axes, and how far about each. */
  private readonly rowAxes = [new Vector3(), new Vector3(), new Vector3()];
  private readonly rowAmounts = new Float64Array(3);
  private rowCount = 0;
  private substepLength = 0;
  /**
   * What the drives' springs pulled with on this substep, in N or N·m along each axis (linear
   * then angular), and what they would have without their limits: a drive's spring and damping
   * together give no more than its limit, the damping only what the spring leaves.
   */
  private readonly servoLoads = new Float64Array(6);
  private readonly servoPulls = new Float64Array(6);
  /** The same for the orientation drive, along the axis it turned about. */
  private readonly orientationServoAxis = new Vector3();
  private orientationServoLoad = 0;
  private orientationServoPull = 0;
  /** The angular impulse the last `turnB` would have given without its limit. */
  private unlimitedTurn = 0;

  /** The body the joint's base frame is on (none, for a joint to the world), and the one whose frame moves against it. */
  private readonly base: SolverBody | undefined;
  private readonly moving: SolverBody;
  private readonly baseFrame: JointFrame;
  private readonly movingFrame: JointFrame;

  constructor(
    private readonly joint: SixDofJoint,
    bodyA: SolverBody,
    bodyB: SolverBody | undefined,
  ) {
    this.bodies = bodyB ? [bodyA, bodyB] : [bodyA];
    this.base = bodyB ? bodyA : undefined;
    this.moving = bodyB ?? bodyA;
    const roles = joint.roles;
    this.baseFrame = roles.base;
    this.movingFrame = roles.moving;
  }

  solvePositions(substep: number): void {
    this.substepsThisStep++;
    this.substepLength = substep;
    const angular = this.joint.angular;
    this.measure();
    this.rowCount = 0;
    this.heldCount = 0;
    if (angular[0] === 'locked' && angular[1] === 'locked' && angular[2] === 'locked') {
      // the whole turn that takes frame B onto frame A, taken back about all three axes at once
      relative.multiplyQuaternions(orientationA, inverseB.copy(orientationB).invert());
      const sign = relative.w < 0 ? -2 : 2;
      this.addRow(worldX, sign * relative.x, 0, true);
      this.addRow(worldY, sign * relative.y, 0, true);
      this.addRow(worldZ, sign * relative.z, 0, true);
    } else {
      // every angular limit that is passed, from one measurement, taken back together; a locked
      // axis is held even when it needs no taking back, for the velocity pass
      swingExcess(turn.swing, angular[1], angular[2], rotationError);
      if (swingCone(angular[1], angular[2])) {
        // a cone limit is one constraint, along the way the axis leans
        const excessAngle = rotationError.length();
        if (excessAngle > 0) this.addRow(rotationError.applyQuaternion(orientationA).divideScalar(excessAngle), -excessAngle, -1, true);
      } else {
        for (const index of [1, 2] as const) {
          const amount = -rotationError.getComponent(index);
          const locked = angular[index] === 'locked';
          if (amount !== 0 || locked) this.addRow(frameAxis(orientationA, index, axis), amount, locked ? 0 : Math.sign(amount), locked || amount !== 0);
        }
      }
      const twistExcess = excess(turn.twist, angular[0]);
      const twistLocked = angular[0] === 'locked';
      if (twistExcess !== 0 || twistLocked) this.addRow(frameAxis(orientationB, 0, axis), -twistExcess, twistLocked ? 0 : -Math.sign(twistExcess), true);
    }
    if (this.rowCount > 0) this.turnAbout();
    this.measure(false);
    // frame B's offset beyond what the linear axes allow, back in world space
    offset.subVectors(pointB, pointA).applyQuaternion(inverseA);
    const linear = this.joint.linear;
    offset.set(excess(offset.x, linear[0]), excess(offset.y, linear[1]), excess(offset.z, linear[2])).applyQuaternion(orientationA);
    const error = offset.length();
    if (error > 0 && linear.every((motion) => motion === 'locked')) {
      // a locked point: moved back exactly, every direction at once (see `holdPoint`)
      this.holdPoint(offset);
    } else if (error > 0) {
      // move the moving frame's origin back by the excess: along the excess, from the base's toward it
      correctionDirection.copy(offset).divideScalar(error);
      const impulseMagnitude = correctPosition({ bodyA: this.moving, pointA: pointB, bodyB: this.base, pointB: pointA, direction: correctionDirection, error }, substep);
      this.linearImpulse.addScaledVector(correctionDirection, impulseMagnitude);
    }
    this.pullServos(substep);
    this.holdFriction(substep);
  }

  /**
   * Static friction: puts back how far each axis the joint doesn't lock moved on this substep,
   * when that takes no more than the friction allows, as contacts hold a resting body. Friction
   * acting only on velocities would let gravity creep the joint round a little every substep.
   * When it can't hold, the velocity pass slows the axis instead. Not for ball joints: see below.
   */
  private holdFriction(substep: number): void {
    const { friction, linearFriction, angular, linear } = this.joint;
    const reachSquared = substep * substep;
    // A ball joint's friction acts on velocities only: held on positions as well, the limbs of a
    // fallen ragdoll, each turned back about its own joint and every joint sharing the body it
    // hangs from, never came to rest. It lets a ball joint creep a little under a steady load.
    if (friction > 0 && !turnsFreely(angular)) {
      for (let index = 0; index < 3; index++) {
        if (angular[index] === 'locked') continue;
        this.measure();
        this.angularAxis(index, axis);
        this.holdTurn(axis, this.turnSinceSubstepStart(relativeSpin).dot(axis), friction * reachSquared);
      }
    }
    if (linearFriction > 0) {
      this.measure(false);
      // how far the moving frame's origin moved from the base's this substep
      pointAtSubstepStart(this.moving, this.movingFrame.position, startB);
      if (this.base) pointAtSubstepStart(this.base, this.baseFrame.position, startA);
      else startA.copy(pointA);
      offset.subVectors(pointB, startB).sub(startA.sub(pointA).negate());
      for (let index = 0; index < 3; index++) {
        if (linear[index] === 'locked') continue;
        frameAxis(orientationA, index, axis);
        const moved = offset.dot(axis);
        const inverseMass = generalizedInverseMass(this.moving, pointB, axis) + (this.base ? generalizedInverseMass(this.base, pointA, axis) : 0);
        if (moved === 0 || inverseMass === 0 || Math.abs(moved) / inverseMass > linearFriction * reachSquared) continue;
        this.linearImpulse.addScaledVector(axis, correctPosition({ bodyA: this.moving, pointA: pointB, bodyB: this.base, pointB: pointA, direction: axis, error: moved, inverseMass }, substep));
      }
    }
  }

  /**
   * The position part of the drives: each pulls its axis toward its target as an XPBD spring of
   * compliance 1 / stiffness, at most its force, which at rest holds the axis exactly where the
   * spring's pull balances the load. Their damping, and motors, act on velocities.
   */
  private pullServos(substep: number): void {
    const { linearDrives, angularDrives, linear, angular, orientationDrive } = this.joint;
    const reachSquared = substep * substep;
    this.servoLoads.fill(0);
    this.servoPulls.fill(0);
    this.orientationServoLoad = 0;
    this.orientationServoPull = 0;
    for (let index = 0; index < 3; index++) {
      const drive = linearDrives[index];
      if (!drive || !hasSpring(drive) || drive.targetPosition === undefined || linear[index] === 'locked') continue;
      this.measure();
      offset.subVectors(pointB, pointA).applyQuaternion(inverseA);
      frameAxis(orientationA, index, axis);
      const inverseMass = generalizedInverseMass(this.moving, pointB, axis) + (this.base ? generalizedInverseMass(this.base, pointA, axis) : 0);
      const compliance = 1 / driveGains(drive, inverseMass).stiffness;
      const resistance = inverseMass + compliance / reachSquared;
      const error = offset.getComponent(index) - drive.targetPosition;
      // as far as the force limit allows: the impulse is error / resistance, at most maxForce h²
      const limited = Math.sign(error) * Math.min(Math.abs(error), driveLimit(drive, substep) * substep * resistance);
      const impulseMagnitude = correctPosition({ bodyA: this.moving, pointA: pointB, bodyB: this.base, pointB: pointA, direction: axis, error: limited, compliance }, substep);
      this.linearImpulse.addScaledVector(axis, impulseMagnitude);
      this.servoLoads[index] = impulseMagnitude / reachSquared;
      // correctPosition pushes against the error: without the limit it would have pushed -error / resistance
      this.servoPulls[index] = -error / resistance / reachSquared;
    }
    for (let index = 0; index < 3; index++) {
      const drive = angularDrives[index];
      if (!drive || !hasSpring(drive) || drive.targetPosition === undefined || angular[index] === 'locked') continue;
      this.measure();
      this.angularAxis(index, axis);
      const position = index === 0 ? turn.twist : turn.swing.getComponent(index);
      const compliance = 1 / driveGains(drive, this.gainInverseMass(axis)).stiffness;
      const amount = this.turnB(rotation.copy(axis).multiplyScalar(drive.targetPosition - position), compliance, driveLimit(drive, substep) * substep, substep);
      const along = rotation.dot(axis);
      this.servoLoads[3 + index] = (amount * along) / reachSquared;
      this.servoPulls[3 + index] = (this.unlimitedTurn * along) / reachSquared;
    }
    if (orientationDrive && hasSpring(orientationDrive)) {
      // the whole turn to the target orientation at once, about the one axis it is a turn about
      this.measure(false);
      turnToTarget(orientationA, orientationDrive.target, orientationB, rotation);
      const angle = rotation.length();
      if (angle > 1e-12) {
        const compliance = 1 / driveGains(orientationDrive, this.gainInverseMass(axis.copy(rotation).divideScalar(angle))).stiffness;
        const amount = this.turnB(rotation, compliance, (orientationDrive.maxTorque ?? Infinity) * reachSquared, substep);
        this.orientationServoAxis.copy(rotation);
        this.orientationServoLoad = amount / reachSquared;
        this.orientationServoPull = this.unlimitedTurn / reachSquared;
      }
    }
  }

  solveVelocities(substep: number): void {
    this.settleHeldRows();
    const { linearDrives, angularDrives, linear, angular, orientationDrive, friction, linearFriction } = this.joint;
    if (!linearDrives.some(Boolean) && !angularDrives.some(Boolean) && !orientationDrive && friction <= 0 && linearFriction <= 0) return;
    this.measure();
    offset.subVectors(pointB, pointA).applyQuaternion(inverseA);
    for (let index = 0; index < 3; index++) {
      const drive = linearDrives[index];
      if (!drive || linear[index] === 'locked') continue;
      frameAxis(orientationA, index, axis);
      const speed = this.pointSpeedAlong(axis);
      const inverseMass = generalizedInverseMass(this.moving, pointB, axis) + (this.base ? generalizedInverseMass(this.base, pointA, axis) : 0);
      const driven = driveImpulse(velocityPart(drive, inverseMass), offset.getComponent(index), speed, inverseMass, substep);
      this.pushAlong(axis, withinWhatIsLeft(driven, driveLimit(drive, substep), this.servoLoads[index]! * substep, this.servoPulls[index]! * substep));
    }
    for (let index = 0; index < 3; index++) {
      const drive = angularDrives[index];
      if (!drive || angular[index] === 'locked') continue;
      this.angularAxis(index, axis);
      const inverseMass = this.angularInverseMassAbout(axis);
      const position = index === 0 ? turn.twist : turn.swing.getComponent(index);
      const driven = driveImpulse(velocityPart(drive, this.gainInverseMass(axis)), position, this.spinAbout(axis), inverseMass, substep);
      this.turnAlong(axis, withinWhatIsLeft(driven, driveLimit(drive, substep), this.servoLoads[3 + index]! * substep, this.servoPulls[3 + index]! * substep));
    }
    if (orientationDrive) this.dampSpin(orientationDrive, substep);
    // friction last, against whatever motion the drives have left
    if (friction > 0 && turnsFreely(angular)) {
      relativeSpin.copy(this.moving.angularVelocity);
      if (this.base) relativeSpin.sub(this.base.angularVelocity);
      const spin = relativeSpin.length();
      if (spin > 0) {
        axis.copy(relativeSpin).divideScalar(spin);
        this.turnAlong(axis, stopping(spin, this.angularInverseMassAbout(axis), friction * substep));
      }
    } else if (friction > 0) {
      for (let index = 0; index < 3; index++) {
        if (angular[index] === 'locked') continue;
        this.angularAxis(index, axis);
        this.turnAlong(axis, stopping(this.spinAbout(axis), this.angularInverseMassAbout(axis), friction * substep));
      }
    }
    if (linearFriction > 0) {
      for (let index = 0; index < 3; index++) {
        if (linear[index] === 'locked') continue;
        frameAxis(orientationA, index, axis);
        const inverseMass = generalizedInverseMass(this.moving, pointB, axis) + (this.base ? generalizedInverseMass(this.base, pointA, axis) : 0);
        this.pushAlong(axis, stopping(this.pointSpeedAlong(axis), inverseMass, linearFriction * substep));
      }
    }
  }

  /** How far the moving body has turned relative to the base this substep, as a rotation vector, into `target`. */
  private turnSinceSubstepStart(target: Vector3): Vector3 {
    rotationSinceSubstepStart(this.moving, target);
    if (this.base) target.sub(rotationSinceSubstepStart(this.base, turnedBase));
    return target;
  }

  /**
   * Turns the bodies back by `turned` about the unit `direction`, if an angular impulse no bigger
   * than `limit` can: about the joint's point if it holds one, as the bodies turn about it.
   */
  private holdTurn(direction: Vector3, turned: number, limit: number): void {
    if (turned === 0) return;
    const linear = this.joint.linear;
    if (linear[0] !== 'locked' || linear[1] !== 'locked' || linear[2] !== 'locked') {
      const inverseMass = this.angularInverseMassAbout(direction);
      if (inverseMass > 0 && Math.abs(turned) / inverseMass <= limit) this.turnB(rotation.copy(direction).multiplyScalar(-turned));
      return;
    }
    const movingShare = pinnedAbout(this.moving, pointB, direction);
    const baseShare = this.base ? pinnedAbout(this.base, pointA, direction) : 0;
    const inverseMass = movingShare + baseShare;
    if (inverseMass === 0 || Math.abs(turned) / inverseMass > limit) return;
    // each turned back by its share, as an angular impulse about the point would share it
    turnAboutPoint(this.moving, rotation.copy(direction).multiplyScalar((-turned * movingShare) / inverseMass), pointB);
    if (this.base) turnAboutPoint(this.base, rotation.copy(direction).multiplyScalar((turned * baseShare) / inverseMass), pointA);
    this.angularImpulse.addScaledVector(direction, -turned / inverseMass);
  }

  /**
   * The velocity part of an orientation drive: its damping against the moving frame's whole spin
   * relative to the base, or for one without a spring, holding the spin at zero as far as its
   * torque allows.
   */
  private dampSpin(drive: NonNullable<SixDofJoint['orientationDrive']>, substep: number): void {
    relativeSpin.copy(this.moving.angularVelocity);
    if (this.base) relativeSpin.sub(this.base.angularVelocity);
    const spin = relativeSpin.length();
    if (spin < 1e-9) return;
    axis.copy(relativeSpin).divideScalar(spin);
    const inverseMass = this.angularInverseMassAbout(axis);
    const damping = hasSpring(drive) ? driveGains(drive, this.gainInverseMass(axis)).damping : (drive.damping ?? Infinity);
    const driven = driveImpulse({ damping }, 0, spin, inverseMass, substep);
    const along = this.orientationServoAxis.dot(axis) * substep;
    this.turnAlong(axis, withinWhatIsLeft(driven, (drive.maxTorque ?? Infinity) * substep, this.orientationServoLoad * along, this.orientationServoPull * along));
  }

  /** An angular axis of the joint in world space: the twist about the moving frame's x, the swings about the base's y and z. */
  private angularAxis(index: number, target: Vector3): Vector3 {
    return index === 0 ? frameAxis(orientationB, 0, target) : frameAxis(orientationA, index, target);
  }

  /**
   * How hard the joint is to turn about `direction`, for drives set by frequency: about the point
   * it holds, if it holds one, or else about the bodies' centres of mass.
   */
  private gainInverseMass(direction: Vector3): number {
    const linear = this.joint.linear;
    if (linear[0] !== 'locked' || linear[1] !== 'locked' || linear[2] !== 'locked') return this.angularInverseMassAbout(direction);
    return pinnedAbout(this.moving, pointB, direction) + (this.base ? pinnedAbout(this.base, pointA, direction) : 0);
  }

  private angularInverseMassAbout(direction: Vector3): number {
    return angularInverseMass(this.moving, direction) + (this.base ? angularInverseMass(this.base, direction) : 0);
  }

  /** How fast the moving body turns about `direction` relative to the base. */
  private spinAbout(direction: Vector3): number {
    return this.moving.angularVelocity.dot(direction) - (this.base?.angularVelocity.dot(direction) ?? 0);
  }

  /** Pushes the moving frame's origin along the unit `direction` by `amount` (N·s), and the base's back; counted in the loads. */
  private pushAlong(direction: Vector3, amount: number): void {
    if (amount === 0) return;
    impulse.copy(direction).multiplyScalar(amount);
    applyVelocityImpulse(this.moving, impulse, pointB);
    if (this.base) applyVelocityImpulse(this.base, impulse.negate(), pointA);
    this.driveLinearImpulse.addScaledVector(direction, amount);
  }

  /** Turns the moving body about the unit `direction` by the angular impulse `amount` (N·m·s), and the base back; counted in the loads. */
  private turnAlong(direction: Vector3, amount: number): void {
    if (amount === 0) return;
    angularImpulse.copy(direction).multiplyScalar(amount);
    applyAngularVelocityImpulse(this.moving, angularImpulse);
    if (this.base) applyAngularVelocityImpulse(this.base, angularImpulse.negate());
    this.driveAngularImpulse.addScaledVector(direction, amount);
  }

  /** Writes the force and torque the joint carried over the step, then starts the next. */
  finishStep(timestep: number): void {
    const substeps = Math.max(this.substepsThisStep, 1);
    const positional = 1 / (this.substepLength * this.substepLength * substeps) || 0;
    this.joint.force.copy(this.linearImpulse).multiplyScalar(positional).addScaledVector(this.driveLinearImpulse, 1 / timestep);
    this.joint.torque.copy(this.angularImpulse).multiplyScalar(positional).addScaledVector(this.driveAngularImpulse, 1 / timestep);
    this.linearImpulse.set(0, 0, 0);
    this.angularImpulse.set(0, 0, 0);
    this.driveLinearImpulse.set(0, 0, 0);
    this.driveAngularImpulse.set(0, 0, 0);
    this.substepsThisStep = 0;
  }

  /** The joint's frames in world space now, base into the A scratch pose and moving into the B one, with the moving frame's turn in the base's. */
  private measure(withTurn = true): void {
    worldFrame(this.base, this.baseFrame, pointA, orientationA);
    worldFrame(this.moving, this.movingFrame, pointB, orientationB);
    inverseA.copy(orientationA).invert();
    if (withTurn) swingAndTwist(relative.multiplyQuaternions(inverseA, orientationB), turn);
  }

  /**
   * Moves the frames' origins together by `gap` (the moving one's offset from the base's, world
   * space) with the positional impulse P = K⁻¹ gap, K being the two bodies' effective inverse mass
   * at their anchors, m⁻¹ E - [r]× I⁻¹ [r]× summed: exact in every direction at once. Along the
   * gap alone, a body that turns easily one way and not another would be turned off to the side,
   * and the next correction would have to turn it back.
   */
  private holdPoint(gap: Vector3): void {
    pairInverseInertia.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    addPointInverseMass(this.moving, pointB, pairInverseInertia);
    if (this.base) addPointInverseMass(this.base, pointA, pairInverseInertia);
    if (!(Math.abs(pairInverseInertia.determinant()) > 1e-30)) return;
    impulse.copy(gap).applyMatrix3(pairInverseInertia.invert()).negate();
    applyPositionalImpulse(this.moving, impulse, pointB);
    this.linearImpulse.add(impulse);
    if (this.base) applyPositionalImpulse(this.base, impulse.negate(), pointA);
  }

  /**
   * Adds a row to take back on this substep: turn the moving frame by `amount` about the unit
   * `rowAxis` (copied). If `held`, the velocity pass then stops spin against it: both ways for a
   * locked axis (`direction` 0), only against `direction` (+1 or -1) for a limit.
   */
  private addRow(rowAxis: Vector3, amount: number, direction: number, held: boolean): void {
    if (amount !== 0) {
      this.rowAxes[this.rowCount]!.copy(rowAxis);
      this.rowAmounts[this.rowCount] = amount;
      this.rowCount++;
    }
    if (held) {
      this.heldAxes[this.heldCount]!.copy(rowAxis);
      this.heldDirections[this.heldCount] = direction;
      this.heldCount++;
    }
  }

  /**
   * After the positions: takes out the spin that would carry the frames further against the rows
   * held, as contacts take out the speed into them, so that a limb resting against a limit stays
   * still instead of trembling against it.
   */
  private settleHeldRows(): void {
    let count = 0;
    for (let held = 0; held < this.heldCount; held++) {
      const rowAxis = this.heldAxes[held]!;
      const spin = this.moving.angularVelocity.dot(rowAxis) - (this.base?.angularVelocity.dot(rowAxis) ?? 0);
      const direction = this.heldDirections[held]!;
      // a limit pushing one way only stops spin the other way
      if (direction !== 0 && spin * direction >= 0) continue;
      this.rowAxes[count]!.copy(rowAxis);
      this.rowAmounts[count] = -spin;
      count++;
    }
    this.heldCount = 0;
    if (count === 0) return;
    this.rowCount = count;
    if (!this.solveRows()) return;
    applyAngularVelocityImpulse(this.moving, angularImpulse);
    if (this.base) applyAngularVelocityImpulse(this.base, angularImpulse.negate());
  }

  /**
   * Turns the moving body relative to the base by each row's amount about its axis, all at once:
   * the angular positional impulse P = Σ λₖ aₖ for which the turn it makes, (I_A⁻¹ + I_B⁻¹) P,
   * has exactly those amounts along the axes. Taking each axis back on its own would not do:
   * about a long, thin body's axis it turns far more easily than across it, so a turn about one
   * axis spills over onto the others and the corrections ring.
   */
  private turnAbout(): void {
    if (!this.solveRows()) return;
    applyAngularPositionalImpulse(this.moving, angularImpulse);
    this.angularImpulse.add(angularImpulse);
    if (this.base) applyAngularPositionalImpulse(this.base, angularImpulse.negate());
  }

  /** The impulse P = Σ λₖ aₖ, into `angularImpulse`, whose turn has the rows' amounts along their axes; false if there is none. */
  private solveRows(): boolean {
    pairInverseInertia.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    if (this.moving.isMovable) addInto(pairInverseInertia, this.moving.worldInverseInertia);
    if (this.base?.isMovable) addInto(pairInverseInertia, this.base.worldInverseInertia);
    // the effective mass of the rows: Mᵢⱼ = aᵢ · K aⱼ
    const rows = this.rowCount;
    for (let column = 0; column < rows; column++) {
      spill.copy(this.rowAxes[column]!).applyMatrix3(pairInverseInertia);
      for (let row = 0; row < rows; row++) effective[3 * row + column] = this.rowAxes[row]!.dot(spill);
    }
    if (!solveSmall(effective, this.rowAmounts, rows, multipliers)) return false;
    angularImpulse.set(0, 0, 0);
    for (let row = 0; row < rows; row++) angularImpulse.addScaledVector(this.rowAxes[row]!, multipliers[row]!);
    return true;
  }

  /**
   * Turns the moving body by the rotation vector `rotation` (world space) relative to the base,
   * sharing it by how easily each turns; with a compliance, only as far as a spring that soft
   * would, and with a limit, by an angular positional impulse no bigger than it. Returns that
   * impulse, along `rotation`, which it leaves a unit vector.
   */
  private turnB(rotation: Vector3, compliance = 0, limit = Infinity, substep = 1): number {
    const angle = rotation.length();
    if (angle < 1e-12) return 0;
    rotation.divideScalar(angle);
    const inverseMass = angularInverseMass(this.moving, rotation) + (this.base ? angularInverseMass(this.base, rotation) : 0);
    if (inverseMass === 0) return 0;
    this.unlimitedTurn = angle / (inverseMass + compliance / (substep * substep));
    const amount = Math.min(this.unlimitedTurn, limit);
    angularImpulse.copy(rotation).multiplyScalar(amount);
    applyAngularPositionalImpulse(this.moving, angularImpulse);
    this.angularImpulse.add(angularImpulse);
    if (this.base) applyAngularPositionalImpulse(this.base, angularImpulse.negate());
    return amount;
  }

  /** How fast the moving frame's origin moves away from the base's along `direction`. */
  private pointSpeedAlong(direction: Vector3): number {
    this.moving.pointVelocity(pointB, velocityB);
    if (this.base) this.base.pointVelocity(pointA, velocityA);
    else velocityA.set(0, 0, 0);
    return velocityB.sub(velocityA).dot(direction);
  }
}

const worldX = new Vector3(1, 0, 0);
const worldY = new Vector3(0, 1, 0);
const worldZ = new Vector3(0, 0, 1);
const pairInverseInertia = new Matrix3();
const spill = new Vector3();

const leverArm = new Vector3();
const skew = new Matrix3();
const turned = new Matrix3();

/** Adds the body's effective inverse mass at `point`, m⁻¹ E - [r]× I⁻¹ [r]×, into `target`; nothing for a body the solver can't move. */
function addPointInverseMass(body: SolverBody, point: Vector3, target: Matrix3): void {
  if (!body.isMovable) return;
  leverArm.subVectors(point, body.worldCenterOfMass);
  skew.set(0, -leverArm.z, leverArm.y, leverArm.z, 0, -leverArm.x, -leverArm.y, leverArm.x, 0);
  turned.multiplyMatrices(skew, body.worldInverseInertia).multiply(skew);
  for (let element = 0; element < 9; element++) target.elements[element] = target.elements[element]! - turned.elements[element]!;
  for (const diagonal of [0, 4, 8]) target.elements[diagonal] = target.elements[diagonal]! + body.inverseMass;
}

function addInto(target: Matrix3, addend: Matrix3): void {
  for (let element = 0; element < 9; element++) target.elements[element] = target.elements[element]! + addend.elements[element]!;
}

const effective = new Float64Array(9);
const multipliers = new Float64Array(3);

/** Solves M λ = b for one to three unknowns (M row by row, three to a row), into `target`; false if M is singular. */
function solveSmall(matrix: Float64Array, right: Float64Array, size: number, target: Float64Array): boolean {
  if (size === 1) {
    if (!(matrix[0]! > 1e-30)) return false;
    target[0] = right[0]! / matrix[0]!;
    return true;
  }
  if (size === 2) {
    const determinant = matrix[0]! * matrix[4]! - matrix[1]! * matrix[3]!;
    if (!(Math.abs(determinant) > 1e-30)) return false;
    target[0] = (right[0]! * matrix[4]! - matrix[1]! * right[1]!) / determinant;
    target[1] = (matrix[0]! * right[1]! - matrix[3]! * right[0]!) / determinant;
    return true;
  }
  const cofactor00 = matrix[4]! * matrix[8]! - matrix[5]! * matrix[7]!;
  const cofactor01 = matrix[5]! * matrix[6]! - matrix[3]! * matrix[8]!;
  const cofactor02 = matrix[3]! * matrix[7]! - matrix[4]! * matrix[6]!;
  const determinant = matrix[0]! * cofactor00 + matrix[1]! * cofactor01 + matrix[2]! * cofactor02;
  if (!(Math.abs(determinant) > 1e-30)) return false;
  // Cramer's rule, column by column
  const first = right[0]!;
  const second = right[1]!;
  const third = right[2]!;
  target[0] = (first * cofactor00 + second * (matrix[2]! * matrix[7]! - matrix[1]! * matrix[8]!) + third * (matrix[1]! * matrix[5]! - matrix[2]! * matrix[4]!)) / determinant;
  target[1] = (first * cofactor01 + second * (matrix[0]! * matrix[8]! - matrix[2]! * matrix[6]!) + third * (matrix[2]! * matrix[3]! - matrix[0]! * matrix[5]!)) / determinant;
  target[2] = (first * cofactor02 + second * (matrix[1]! * matrix[6]! - matrix[0]! * matrix[7]!) + third * (matrix[0]! * matrix[4]! - matrix[1]! * matrix[3]!)) / determinant;
  return true;
}

/**
 * What of a drive acts on velocities in XPBD: a motor's pull to its speed, or a servo's damping,
 * its spring having acted on positions.
 */
function velocityPart(drive: JointDrive, inverseMass: number): JointDrive {
  if (!hasSpring(drive)) return drive;
  return { targetVelocity: drive.targetVelocity, damping: driveGains(drive, inverseMass).damping, maxForce: drive.maxForce };
}

const tensorScratch = new Float64Array(6);

/** How hard `body` is to turn about `direction` through `point`, were it pinned there. */
function pinnedAbout(body: SolverBody, point: Vector3, direction: Vector3): number {
  if (!body.isMovable) return 0;
  const elements = body.worldInverseInertia.elements;
  tensorScratch.set([elements[0]!, elements[3]!, elements[6]!, elements[4]!, elements[7]!, elements[8]!]);
  leverArm.subVectors(point, body.worldCenterOfMass);
  return pinnedInverseInertia(tensorScratch, body.inverseMass, leverArm.x, leverArm.y, leverArm.z, direction.x, direction.y, direction.z);
}

/**
 * A drive's damping impulse, held as one limit on spring and damping together would hold it: the
 * spring would have pulled with `pull` (as an impulse over the substep) and pulled with `used`,
 * so the damping gives what takes their sum to the limit, at most.
 */
function withinWhatIsLeft(impulse: number, limit: number, used: number, pull: number): number {
  return Math.min(Math.max(pull + impulse, -limit), limit) - used;
}

/** The impulse that stops a motion at `speed` against an inverse mass, no bigger than `limit`: friction's. */
function stopping(speed: number, inverseMass: number, limit: number): number {
  if (inverseMass <= 0) return 0;
  return Math.min(Math.max(-speed / inverseMass, -limit), limit);
}

/** A frame in world space: fixed in `body`, or already in the world without one. */
function worldFrame(body: SolverBody | undefined, frame: JointFrame, position: Vector3, orientation: Quaternion): void {
  if (!body) {
    position.copy(frame.position);
    orientation.copy(frame.quaternion);
    return;
  }
  body.pointToWorld(frame.position, position);
  orientation.multiplyQuaternions(body.quaternion, frame.quaternion);
}
