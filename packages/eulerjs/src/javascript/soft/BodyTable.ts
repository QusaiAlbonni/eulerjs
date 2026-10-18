import type { Vector3 } from 'three';
import { pinnedInverseInertia } from '../../joints/sixDofMath.js';
import type { SolverBody } from '../SolverBody.js';

const tensorScratch = new Float64Array(6);

/**
 * The bodies of a step as the soft-step solver works on them: one row per body, each quantity in
 * a flat typed array, so the inner loops run on plain numbers rather than on vector objects.
 * Vectors take three slots (x, y, z), quaternions four (x, y, z, w) and symmetric tensors six
 * (xx, xy, xz, yy, yz, zz).
 *
 * Dynamics happen about the centre of mass, so that is what is stored and moved; the body frame's
 * origin is put back from it when the step's results are written out.
 */

/** Newton steps for the gyroscopic term, and the relative size of a correction small enough to stop at. */
const GYROSCOPIC_ITERATIONS = 8;
const GYROSCOPIC_TOLERANCE_SQUARED = 1e-24;

export class BodyTable {
  count = 0;
  bodies: readonly SolverBody[] = [];
  readonly indexOf = new Map<SolverBody, number>();

  centers = new Float64Array(0);
  orientations = new Float64Array(0);
  velocities = new Float64Array(0);
  spins = new Float64Array(0);
  /** Where each body's centre of mass was, and how it was turned, when the step began. */
  startCenters = new Float64Array(0);
  startOrientations = new Float64Array(0);
  /** How far each body has turned since the step began, as a quaternion: its orientation times the start's inverse. */
  turns = new Float64Array(0);
  forces = new Float64Array(0);
  torques = new Float64Array(0);
  inverseMasses = new Float64Array(0);
  /** World-space inverse inertia, kept up to date as bodies turn. */
  inverseInertias = new Float64Array(0);
  localInverseInertias = new Float64Array(0);
  localInertias = new Float64Array(0);
  /** Centre of mass in the body frame, to put the frame's origin back from. */
  localCenters = new Float64Array(0);
  gravityScales = new Float64Array(0);
  linearDampings = new Float64Array(0);
  angularDampings = new Float64Array(0);
  /** 1 for awake dynamic bodies: the ones forces and constraints move, and the only ones whose masses and inertias count. */
  moving = new Uint8Array(0);
  /** 1 for bodies whose pose changes: moving ones and awake kinematic ones. */
  travelling = new Uint8Array(0);
  /** 1 for bodies whose inertia is the same about every axis, which need no gyroscopic term. */
  evenInertia = new Uint8Array(0);
  /** Which body, at which mass version, each row's mass properties were copied from. */
  private loadedBodies: (SolverBody | undefined)[] = [];
  private loadedMassVersions = new Int32Array(0);

  /**
   * Copies the bodies' state in, growing the arrays if there are more bodies than before. Mass
   * properties stay from the last step unless the body in that row, or its mass, has changed.
   */
  load(bodies: readonly SolverBody[]): void {
    this.bodies = bodies;
    this.count = bodies.length;
    if (this.inverseMasses.length < bodies.length) this.grow(Math.max(bodies.length, 2 * this.inverseMasses.length, 16));
    this.indexOf.clear();
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index]!;
      this.indexOf.set(body, index);
      if (this.loadedBodies[index] !== body || this.loadedMassVersions[index] !== body.massVersion) this.loadMass(index, body);
      const moving = body.isMovable;
      this.moving[index] = moving ? 1 : 0;
      this.travelling[index] = moving || (body.type === 'kinematic' && !body.isSleeping) ? 1 : 0;
      const vector = 3 * index;
      const center = body.worldCenterOfMass;
      this.centers[vector] = this.startCenters[vector] = center.x;
      this.centers[vector + 1] = this.startCenters[vector + 1] = center.y;
      this.centers[vector + 2] = this.startCenters[vector + 2] = center.z;
      const quaternion = body.quaternion;
      const orientation = 4 * index;
      this.orientations[orientation] = this.startOrientations[orientation] = quaternion.x;
      this.orientations[orientation + 1] = this.startOrientations[orientation + 1] = quaternion.y;
      this.orientations[orientation + 2] = this.startOrientations[orientation + 2] = quaternion.z;
      this.orientations[orientation + 3] = this.startOrientations[orientation + 3] = quaternion.w;
      this.turns[orientation] = this.turns[orientation + 1] = this.turns[orientation + 2] = 0;
      this.turns[orientation + 3] = 1;
      if (!this.travelling[index]) {
        this.velocities.fill(0, vector, vector + 3);
        this.spins.fill(0, vector, vector + 3);
        continue;
      }
      writeVector(this.velocities, index, body.velocity);
      writeVector(this.spins, index, body.angularVelocity);
      if (!moving) continue;
      writeVector(this.forces, index, body.force);
      writeVector(this.torques, index, body.torque);
      this.gravityScales[index] = body.gravityScale;
      this.linearDampings[index] = body.linearDamping;
      this.angularDampings[index] = body.angularDamping;
      this.updateInverseInertia(index);
    }
  }

  /** Writes the poses and velocities the step ended with back into the bodies that moved. */
  store(): void {
    for (let index = 0; index < this.count; index++) {
      if (!this.travelling[index]) continue;
      const body = this.bodies[index]!;
      const orientation = 4 * index;
      body.quaternion.set(this.orientations[orientation]!, this.orientations[orientation + 1]!, this.orientations[orientation + 2]!, this.orientations[orientation + 3]!);
      // the frame's origin is the centre of mass less the turned local centre of mass
      rotateInto(this.orientations, index, this.localCenters[3 * index]!, this.localCenters[3 * index + 1]!, this.localCenters[3 * index + 2]!);
      body.position.set(this.centers[3 * index]! - rotated[0]!, this.centers[3 * index + 1]! - rotated[1]!, this.centers[3 * index + 2]! - rotated[2]!);
      body.worldCenterOfMass.set(this.centers[3 * index]!, this.centers[3 * index + 1]!, this.centers[3 * index + 2]!);
      body.velocity.set(this.velocities[3 * index]!, this.velocities[3 * index + 1]!, this.velocities[3 * index + 2]!);
      body.angularVelocity.set(this.spins[3 * index]!, this.spins[3 * index + 1]!, this.spins[3 * index + 2]!);
      // the world inverse inertia is left for the next step to refresh, which it does for every body
    }
  }

  /** The mass properties of the body now in row `index`, which only the bodies the solver moves use. */
  private loadMass(index: number, body: SolverBody): void {
    this.loadedBodies[index] = body;
    this.loadedMassVersions[index] = body.massVersion;
    this.evenInertia[index] = body.hasEvenInertia ? 1 : 0;
    this.inverseMasses[index] = body.inverseMass;
    writeTensor(this.localInverseInertias, index, body.localInverseInertiaTensor.elements);
    writeTensor(this.localInertias, index, body.massProperties?.inertia.elements);
    writeVector(this.localCenters, index, body.massProperties?.centerOfMass);
  }

  /** Velocities on by `substep`: gravity, the step's forces and torques, damping and the gyroscopic term. */
  integrateVelocities(substep: number, gravity: Vector3): void {
    for (let index = 0; index < this.count; index++) {
      if (!this.moving[index]) continue;
      const vector = 3 * index;
      const inverseMass = this.inverseMasses[index]!;
      const gravityScale = this.gravityScales[index]!;
      const linearKept = this.linearDampings[index]! > 0 ? Math.exp(-this.linearDampings[index]! * substep) : 1;
      for (let axis = 0; axis < 3; axis++) {
        const acceleration = this.forces[vector + axis]! * inverseMass + gravity.getComponent(axis) * gravityScale;
        this.velocities[vector + axis] = (this.velocities[vector + axis]! + acceleration * substep) * linearKept;
      }
      multiplySymmetric(this.inverseInertias, index, this.torques[vector]!, this.torques[vector + 1]!, this.torques[vector + 2]!);
      for (let axis = 0; axis < 3; axis++) this.spins[vector + axis] = this.spins[vector + axis]! + product[axis]! * substep;
      if (!this.evenInertia[index]) this.applyGyroscopicTerm(index, substep);
      if (this.angularDampings[index]! > 0) {
        const angularKept = Math.exp(-this.angularDampings[index]! * substep);
        for (let axis = 0; axis < 3; axis++) this.spins[vector + axis] = this.spins[vector + axis]! * angularKept;
      }
    }
  }

  /** Moves and turns the travelling bodies by their velocities over `substep`, and turns their inertia with them. */
  integratePositions(substep: number): void {
    for (let index = 0; index < this.count; index++) {
      if (!this.travelling[index]) continue;
      const vector = 3 * index;
      for (let axis = 0; axis < 3; axis++) this.centers[vector + axis] = this.centers[vector + axis]! + this.velocities[vector + axis]! * substep;
      const spinX = this.spins[vector]!;
      const spinY = this.spins[vector + 1]!;
      const spinZ = this.spins[vector + 2]!;
      const speed = Math.sqrt(spinX * spinX + spinY * spinY + spinZ * spinZ);
      if (speed === 0) continue;
      // turn by the rotation of angle |ω| h about ω, exactly
      const halfAngle = 0.5 * speed * substep;
      const sine = Math.sin(halfAngle) / speed;
      premultiplyQuaternion(this.orientations, index, spinX * sine, spinY * sine, spinZ * sine, Math.cos(halfAngle));
      premultiplyQuaternion(this.turns, index, spinX * sine, spinY * sine, spinZ * sine, Math.cos(halfAngle));
      if (this.moving[index]) this.updateInverseInertia(index);
    }
  }

  /** Adds `impulse` at the offset `arm` from the centre of mass of body `index`: v += m⁻¹ P, ω += I⁻¹ (r × P). */
  applyImpulse(index: number, impulseX: number, impulseY: number, impulseZ: number, armX: number, armY: number, armZ: number): void {
    if (!this.moving[index]) return;
    const vector = 3 * index;
    const inverseMass = this.inverseMasses[index]!;
    this.velocities[vector] = this.velocities[vector]! + impulseX * inverseMass;
    this.velocities[vector + 1] = this.velocities[vector + 1]! + impulseY * inverseMass;
    this.velocities[vector + 2] = this.velocities[vector + 2]! + impulseZ * inverseMass;
    this.applyAngularImpulse(index, armY * impulseZ - armZ * impulseY, armZ * impulseX - armX * impulseZ, armX * impulseY - armY * impulseX);
  }

  /** Adds an angular impulse to body `index`: ω += I⁻¹ L. */
  applyAngularImpulse(index: number, angularX: number, angularY: number, angularZ: number): void {
    if (!this.moving[index]) return;
    multiplySymmetric(this.inverseInertias, index, angularX, angularY, angularZ);
    const vector = 3 * index;
    this.spins[vector] = this.spins[vector]! + product[0]!;
    this.spins[vector + 1] = this.spins[vector + 1]! + product[1]!;
    this.spins[vector + 2] = this.spins[vector + 2]! + product[2]!;
  }

  /** How hard body `index` is to move along `direction` at the offset `arm`: m⁻¹ + (r × n)ᵀ I⁻¹ (r × n). */
  inverseMassAlong(index: number, armX: number, armY: number, armZ: number, directionX: number, directionY: number, directionZ: number): number {
    if (!this.moving[index]) return 0;
    const crossX = armY * directionZ - armZ * directionY;
    const crossY = armZ * directionX - armX * directionZ;
    const crossZ = armX * directionY - armY * directionX;
    multiplySymmetric(this.inverseInertias, index, crossX, crossY, crossZ);
    return this.inverseMasses[index]! + crossX * product[0]! + crossY * product[1]! + crossZ * product[2]!;
  }

  /**
   * Adds into `target` (a symmetric 3 × 3 tensor, xx xy xz yy yz zz) how hard body `index` is to
   * move at the offset `arm` in each direction: m⁻¹ E - [r]× I⁻¹ [r]×, the body's share of a point
   * constraint's effective inverse mass.
   */
  addPointInverseMass(index: number, armX: number, armY: number, armZ: number, target: Float64Array): void {
    if (!this.moving[index]) return;
    const tensor = 6 * index;
    const xx = this.inverseInertias[tensor]!;
    const xy = this.inverseInertias[tensor + 1]!;
    const xz = this.inverseInertias[tensor + 2]!;
    const yy = this.inverseInertias[tensor + 3]!;
    const yz = this.inverseInertias[tensor + 4]!;
    const zz = this.inverseInertias[tensor + 5]!;
    // I⁻¹ [r]×, column by column: the turn I⁻¹ (r × e) a unit impulse along each axis e gives
    const xTurnY = yy * armZ - yz * armY;
    const xTurnZ = yz * armZ - zz * armY;
    const yTurnX = xz * armX - xx * armZ;
    const yTurnY = yz * armX - xy * armZ;
    const yTurnZ = zz * armX - xz * armZ;
    const zTurnX = xx * armY - xy * armX;
    const zTurnY = xy * armY - yy * armX;
    const zTurnZ = xz * armY - yz * armX;
    // minus [r]× times those, (turn × r), for the entries on and above the diagonal
    const inverseMass = this.inverseMasses[index]!;
    target[0] = target[0]! + inverseMass - (armY * xTurnZ - armZ * xTurnY);
    target[1] = target[1]! - (armY * yTurnZ - armZ * yTurnY);
    target[2] = target[2]! - (armY * zTurnZ - armZ * zTurnY);
    target[3] = target[3]! + inverseMass - (armZ * yTurnX - armX * yTurnZ);
    target[4] = target[4]! - (armZ * zTurnX - armX * zTurnZ);
    target[5] = target[5]! + inverseMass - (armX * zTurnY - armY * zTurnX);
  }

  /**
   * How fast body `index` moves at the offset `arm` along `direction` for a unit impulse at the
   * offset `otherArm` along `otherDirection`: the coupling between two contact points of one body,
   * m⁻¹ (d · d') + (r × d) · I⁻¹ (r' × d').
   */
  crossInverseMass(index: number, armX: number, armY: number, armZ: number, directionX: number, directionY: number, directionZ: number, otherArmX: number, otherArmY: number, otherArmZ: number, otherDirectionX: number, otherDirectionY: number, otherDirectionZ: number): number {
    if (!this.moving[index]) return 0;
    multiplySymmetric(this.inverseInertias, index, otherArmY * otherDirectionZ - otherArmZ * otherDirectionY, otherArmZ * otherDirectionX - otherArmX * otherDirectionZ, otherArmX * otherDirectionY - otherArmY * otherDirectionX);
    const crossX = armY * directionZ - armZ * directionY;
    const crossY = armZ * directionX - armX * directionZ;
    const crossZ = armX * directionY - armY * directionX;
    const along = directionX * otherDirectionX + directionY * otherDirectionY + directionZ * otherDirectionZ;
    return this.inverseMasses[index]! * along + crossX * product[0]! + crossY * product[1]! + crossZ * product[2]!;
  }

  /** How hard body `index` is to turn about the unit `axis` through the point at the offset `arm`, were it pinned there (see `pinnedInverseInertia`). */
  pinnedInverseInertiaAbout(index: number, armX: number, armY: number, armZ: number, axisX: number, axisY: number, axisZ: number): number {
    if (!this.moving[index]) return 0;
    for (let element = 0; element < 6; element++) tensorScratch[element] = this.inverseInertias[6 * index + element]!;
    return pinnedInverseInertia(tensorScratch, this.inverseMasses[index]!, armX, armY, armZ, axisX, axisY, axisZ);
  }

  /** How hard body `index` is to turn about the unit `axis`: aᵀ I⁻¹ a. */
  angularInverseMassAbout(index: number, axisX: number, axisY: number, axisZ: number): number {
    if (!this.moving[index]) return 0;
    multiplySymmetric(this.inverseInertias, index, axisX, axisY, axisZ);
    return axisX * product[0]! + axisY * product[1]! + axisZ * product[2]!;
  }

  /** Writes into `target` the velocity of the point of body `index` at the offset `arm` from its centre of mass. */
  pointVelocity(index: number, armX: number, armY: number, armZ: number, target: Float64Array): void {
    const vector = 3 * index;
    const spinX = this.spins[vector]!;
    const spinY = this.spins[vector + 1]!;
    const spinZ = this.spins[vector + 2]!;
    target[0] = this.velocities[vector]! + spinY * armZ - spinZ * armY;
    target[1] = this.velocities[vector + 1]! + spinZ * armX - spinX * armZ;
    target[2] = this.velocities[vector + 2]! + spinX * armY - spinY * armX;
  }

  /**
   * Writes into `target` where the offset `arm`, fixed in body `index` when the step began, has
   * turned to since: the offset turned by the body's rotation over the step so far.
   */
  turnedSinceStart(index: number, armX: number, armY: number, armZ: number, target: Float64Array): void {
    const turn = 4 * index;
    rotateByQuaternion(this.turns[turn]!, this.turns[turn + 1]!, this.turns[turn + 2]!, this.turns[turn + 3]!, armX, armY, armZ, target);
  }

  /** Writes into `target` a world-space vector turned into the frame body `index` had when the step began. */
  intoStartFrame(index: number, vectorX: number, vectorY: number, vectorZ: number, target: Float64Array): void {
    const offset = 4 * index;
    const start = this.startOrientations;
    rotateByQuaternion(-start[offset]!, -start[offset + 1]!, -start[offset + 2]!, start[offset + 3]!, vectorX, vectorY, vectorZ, target);
  }

  /** Writes into `target` a vector in the frame body `index` had when the step began, turned out into world space. */
  outOfStartFrame(index: number, vectorX: number, vectorY: number, vectorZ: number, target: Float64Array): void {
    const offset = 4 * index;
    const start = this.startOrientations;
    rotateByQuaternion(start[offset]!, start[offset + 1]!, start[offset + 2]!, start[offset + 3]!, vectorX, vectorY, vectorZ, target);
  }

  private grow(capacity: number): void {
    const vectors = (old: Float64Array, width: number) => resized(old, capacity * width);
    this.centers = vectors(this.centers, 3);
    this.orientations = vectors(this.orientations, 4);
    this.velocities = vectors(this.velocities, 3);
    this.spins = vectors(this.spins, 3);
    this.startCenters = vectors(this.startCenters, 3);
    this.startOrientations = vectors(this.startOrientations, 4);
    this.turns = vectors(this.turns, 4);
    this.forces = vectors(this.forces, 3);
    this.torques = vectors(this.torques, 3);
    this.inverseMasses = vectors(this.inverseMasses, 1);
    this.inverseInertias = vectors(this.inverseInertias, 6);
    this.localInverseInertias = vectors(this.localInverseInertias, 6);
    this.localInertias = vectors(this.localInertias, 6);
    this.localCenters = vectors(this.localCenters, 3);
    this.gravityScales = vectors(this.gravityScales, 1);
    this.linearDampings = vectors(this.linearDampings, 1);
    this.angularDampings = vectors(this.angularDampings, 1);
    this.moving = new Uint8Array(capacity);
    this.travelling = new Uint8Array(capacity);
    this.evenInertia = new Uint8Array(capacity);
    this.loadedBodies = [];
    this.loadedMassVersions = new Int32Array(capacity);
  }

  /** World inverse inertia of body `index` from its orientation: R I⁻¹ Rᵀ. */
  private updateInverseInertia(index: number): void {
    turnSymmetric(this.orientations, index, this.localInverseInertias, this.inverseInertias);
  }

  /**
   * The -ω × Iω term of Euler's equations, solved in the body frame with the implicit midpoint
   * rule, I (ω₁ - ω₀) = -h ωₘ × I ωₘ, by Newton's method: it keeps rotational energy and the
   * size of the angular momentum of a freely spinning body exactly. See integration.ts.
   */
  private applyGyroscopicTerm(index: number, substep: number): void {
    const vector = 3 * index;
    // ω₀ in the body frame
    rotateInverse(this.orientations, index, this.spins[vector]!, this.spins[vector + 1]!, this.spins[vector + 2]!);
    const startX = rotated[0]!;
    const startY = rotated[1]!;
    const startZ = rotated[2]!;
    const inertia = this.localInertias;
    const tensor = 6 * index;
    const inertiaXX = inertia[tensor]!;
    const inertiaXY = inertia[tensor + 1]!;
    const inertiaXZ = inertia[tensor + 2]!;
    const inertiaYY = inertia[tensor + 3]!;
    const inertiaYZ = inertia[tensor + 4]!;
    const inertiaZZ = inertia[tensor + 5]!;
    let endX = startX;
    let endY = startY;
    let endZ = startZ;
    for (let iteration = 0; iteration < GYROSCOPIC_ITERATIONS; iteration++) {
      const middleX = 0.5 * (startX + endX);
      const middleY = 0.5 * (startY + endY);
      const middleZ = 0.5 * (startZ + endZ);
      const momentumX = inertiaXX * middleX + inertiaXY * middleY + inertiaXZ * middleZ;
      const momentumY = inertiaXY * middleX + inertiaYY * middleY + inertiaYZ * middleZ;
      const momentumZ = inertiaXZ * middleX + inertiaYZ * middleY + inertiaZZ * middleZ;
      // residual = I (ω₁ - ω₀) + h ωₘ × I ωₘ
      const changeX = endX - startX;
      const changeY = endY - startY;
      const changeZ = endZ - startZ;
      const residualX = inertiaXX * changeX + inertiaXY * changeY + inertiaXZ * changeZ + substep * (middleY * momentumZ - middleZ * momentumY);
      const residualY = inertiaXY * changeX + inertiaYY * changeY + inertiaYZ * changeZ + substep * (middleZ * momentumX - middleX * momentumZ);
      const residualZ = inertiaXZ * changeX + inertiaYZ * changeY + inertiaZZ * changeZ + substep * (middleX * momentumY - middleY * momentumX);
      // Jacobian I + h/2 (skew(ωₘ) I - skew(I ωₘ)), as rows
      const half = 0.5 * substep;
      const j00 = inertiaXX + half * (-middleZ * inertiaXY + middleY * inertiaXZ);
      const j01 = inertiaXY + half * (-middleZ * inertiaYY + middleY * inertiaYZ + momentumZ);
      const j02 = inertiaXZ + half * (-middleZ * inertiaYZ + middleY * inertiaZZ - momentumY);
      const j10 = inertiaXY + half * (middleZ * inertiaXX - middleX * inertiaXZ - momentumZ);
      const j11 = inertiaYY + half * (middleZ * inertiaXY - middleX * inertiaYZ);
      const j12 = inertiaYZ + half * (middleZ * inertiaXZ - middleX * inertiaZZ + momentumX);
      const j20 = inertiaXZ + half * (-middleY * inertiaXX + middleX * inertiaXY + momentumY);
      const j21 = inertiaYZ + half * (-middleY * inertiaXY + middleX * inertiaYY - momentumX);
      const j22 = inertiaZZ + half * (-middleY * inertiaXZ + middleX * inertiaYZ);
      // solve J c = residual by Cramer's rule
      const cofactor00 = j11 * j22 - j12 * j21;
      const cofactor01 = j12 * j20 - j10 * j22;
      const cofactor02 = j10 * j21 - j11 * j20;
      const determinant = j00 * cofactor00 + j01 * cofactor01 + j02 * cofactor02;
      if (determinant === 0) break;
      const correctionX = (residualX * cofactor00 + residualY * (j02 * j21 - j01 * j22) + residualZ * (j01 * j12 - j02 * j11)) / determinant;
      const correctionY = (residualX * cofactor01 + residualY * (j00 * j22 - j02 * j20) + residualZ * (j02 * j10 - j00 * j12)) / determinant;
      const correctionZ = (residualX * cofactor02 + residualY * (j01 * j20 - j00 * j21) + residualZ * (j00 * j11 - j01 * j10)) / determinant;
      endX -= correctionX;
      endY -= correctionY;
      endZ -= correctionZ;
      const correctionSquared = correctionX * correctionX + correctionY * correctionY + correctionZ * correctionZ;
      if (correctionSquared <= GYROSCOPIC_TOLERANCE_SQUARED * Math.max(endX * endX + endY * endY + endZ * endZ, 1e-30)) break;
    }
    rotateInto(this.orientations, index, endX, endY, endZ);
    this.spins[vector] = rotated[0]!;
    this.spins[vector + 1] = rotated[1]!;
    this.spins[vector + 2] = rotated[2]!;
  }
}

/** Results of the helpers below, to save allocating. */
const product = new Float64Array(3);
const rotated = new Float64Array(3);

function writeVector(target: Float64Array, index: number, vector: Vector3 | undefined): void {
  target[3 * index] = vector?.x ?? 0;
  target[3 * index + 1] = vector?.y ?? 0;
  target[3 * index + 2] = vector?.z ?? 0;
}

/** Stores a symmetric 3 × 3 tensor from three.js's column-major elements, or zero. */
function writeTensor(target: Float64Array, index: number, elements: readonly number[] | undefined): void {
  const offset = 6 * index;
  target[offset] = elements?.[0] ?? 0;
  target[offset + 1] = elements?.[3] ?? 0;
  target[offset + 2] = elements?.[6] ?? 0;
  target[offset + 3] = elements?.[4] ?? 0;
  target[offset + 4] = elements?.[7] ?? 0;
  target[offset + 5] = elements?.[8] ?? 0;
}

function resized(old: Float64Array, length: number): Float64Array<ArrayBuffer> {
  const grown = new Float64Array(length);
  grown.set(old.subarray(0, Math.min(old.length, length)));
  return grown;
}

/** Writes T v into `product`, for the symmetric tensor of row `index` in `tensors`. */
function multiplySymmetric(tensors: Float64Array, index: number, vectorX: number, vectorY: number, vectorZ: number): void {
  const offset = 6 * index;
  const xx = tensors[offset]!;
  const xy = tensors[offset + 1]!;
  const xz = tensors[offset + 2]!;
  const yy = tensors[offset + 3]!;
  const yz = tensors[offset + 4]!;
  const zz = tensors[offset + 5]!;
  product[0] = xx * vectorX + xy * vectorY + xz * vectorZ;
  product[1] = xy * vectorX + yy * vectorY + yz * vectorZ;
  product[2] = xz * vectorX + yz * vectorY + zz * vectorZ;
}

/** Writes q v q⁻¹ into `target` for the quaternion (x, y, z, w). */
function rotateByQuaternion(quaternionX: number, quaternionY: number, quaternionZ: number, quaternionW: number, vectorX: number, vectorY: number, vectorZ: number, target: Float64Array): void {
  // t = 2 q × v; v' = v + w t + q × t
  const twiceCrossX = 2 * (quaternionY * vectorZ - quaternionZ * vectorY);
  const twiceCrossY = 2 * (quaternionZ * vectorX - quaternionX * vectorZ);
  const twiceCrossZ = 2 * (quaternionX * vectorY - quaternionY * vectorX);
  target[0] = vectorX + quaternionW * twiceCrossX + quaternionY * twiceCrossZ - quaternionZ * twiceCrossY;
  target[1] = vectorY + quaternionW * twiceCrossY + quaternionZ * twiceCrossX - quaternionX * twiceCrossZ;
  target[2] = vectorZ + quaternionW * twiceCrossZ + quaternionX * twiceCrossY - quaternionY * twiceCrossX;
}

/** Writes into `rotated` the vector turned by the orientation of row `index`. */
function rotateInto(orientations: Float64Array, index: number, vectorX: number, vectorY: number, vectorZ: number): void {
  const offset = 4 * index;
  rotateByQuaternion(orientations[offset]!, orientations[offset + 1]!, orientations[offset + 2]!, orientations[offset + 3]!, vectorX, vectorY, vectorZ, rotated);
}

/** Writes into `rotated` the vector turned back by the orientation of row `index`. */
function rotateInverse(orientations: Float64Array, index: number, vectorX: number, vectorY: number, vectorZ: number): void {
  const offset = 4 * index;
  rotateByQuaternion(-orientations[offset]!, -orientations[offset + 1]!, -orientations[offset + 2]!, orientations[offset + 3]!, vectorX, vectorY, vectorZ, rotated);
}

/** Sets the orientation of row `index` to r q, for the rotation r = (x, y, z, w), and renormalises it. */
function premultiplyQuaternion(orientations: Float64Array, index: number, turnX: number, turnY: number, turnZ: number, turnW: number): void {
  const offset = 4 * index;
  const currentX = orientations[offset]!;
  const currentY = orientations[offset + 1]!;
  const currentZ = orientations[offset + 2]!;
  const currentW = orientations[offset + 3]!;
  const resultX = turnW * currentX + turnX * currentW + turnY * currentZ - turnZ * currentY;
  const resultY = turnW * currentY + turnY * currentW + turnZ * currentX - turnX * currentZ;
  const resultZ = turnW * currentZ + turnZ * currentW + turnX * currentY - turnY * currentX;
  const resultW = turnW * currentW - turnX * currentX - turnY * currentY - turnZ * currentZ;
  const length = Math.sqrt(resultX * resultX + resultY * resultY + resultZ * resultZ + resultW * resultW);
  orientations[offset] = resultX / length;
  orientations[offset + 1] = resultY / length;
  orientations[offset + 2] = resultZ / length;
  orientations[offset + 3] = resultW / length;
}

/** R T Rᵀ for the orientation of row `index` and the symmetric tensor of that row in `local`, into `world`. */
function turnSymmetric(orientations: Float64Array, index: number, local: Float64Array, world: Float64Array): void {
  const offset = 4 * index;
  const quaternionX = orientations[offset]!;
  const quaternionY = orientations[offset + 1]!;
  const quaternionZ = orientations[offset + 2]!;
  const quaternionW = orientations[offset + 3]!;
  const twiceX = quaternionX + quaternionX;
  const twiceY = quaternionY + quaternionY;
  const twiceZ = quaternionZ + quaternionZ;
  const xx = quaternionX * twiceX;
  const xy = quaternionX * twiceY;
  const xz = quaternionX * twiceZ;
  const yy = quaternionY * twiceY;
  const yz = quaternionY * twiceZ;
  const zz = quaternionZ * twiceZ;
  const wx = quaternionW * twiceX;
  const wy = quaternionW * twiceY;
  const wz = quaternionW * twiceZ;
  const r00 = 1 - (yy + zz);
  const r01 = xy - wz;
  const r02 = xz + wy;
  const r10 = xy + wz;
  const r11 = 1 - (xx + zz);
  const r12 = yz - wx;
  const r20 = xz - wy;
  const r21 = yz + wx;
  const r22 = 1 - (xx + yy);
  const tensor = 6 * index;
  const t00 = local[tensor]!;
  const t01 = local[tensor + 1]!;
  const t02 = local[tensor + 2]!;
  const t11 = local[tensor + 3]!;
  const t12 = local[tensor + 4]!;
  const t22 = local[tensor + 5]!;
  const m00 = r00 * t00 + r01 * t01 + r02 * t02;
  const m01 = r00 * t01 + r01 * t11 + r02 * t12;
  const m02 = r00 * t02 + r01 * t12 + r02 * t22;
  const m10 = r10 * t00 + r11 * t01 + r12 * t02;
  const m11 = r10 * t01 + r11 * t11 + r12 * t12;
  const m12 = r10 * t02 + r11 * t12 + r12 * t22;
  const m20 = r20 * t00 + r21 * t01 + r22 * t02;
  const m21 = r20 * t01 + r21 * t11 + r22 * t12;
  const m22 = r20 * t02 + r21 * t12 + r22 * t22;
  world[tensor] = m00 * r00 + m01 * r01 + m02 * r02;
  world[tensor + 1] = m00 * r10 + m01 * r11 + m02 * r12;
  world[tensor + 2] = m00 * r20 + m01 * r21 + m02 * r22;
  world[tensor + 3] = m10 * r10 + m11 * r11 + m12 * r12;
  world[tensor + 4] = m10 * r20 + m11 * r21 + m12 * r22;
  world[tensor + 5] = m20 * r20 + m21 * r21 + m22 * r22;
}
