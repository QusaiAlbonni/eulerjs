import { Matrix3, Quaternion, Vector3 } from 'three';
import { InvalidMassError } from './errors.js';
import type { MassProperties } from './MassProperties.js';

/**
 * - `dynamic` bodies are moved by forces and gravity.
 * - `kinematic` bodies move with the velocity you give them and ignore forces.
 * - `static` bodies never move.
 */
export type BodyType = 'dynamic' | 'kinematic' | 'static';

/** Where a body is and how it moves: what the world and a backend exchange every step. */
export interface BodyMotion {
  /** Origin of the body frame in world space. */
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  /** Velocity of the centre of mass, in m/s. */
  readonly velocity: Vector3;
  /** Angular velocity in world space, in rad/s. */
  readonly angularVelocity: Vector3;
}

const zeroMatrix = new Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
const leverArm = new Vector3();
const inverseQuaternion = new Quaternion();

/**
 * A rigid body's pose, velocities and mass, and the frame maths on them. Both the body you hold
 * and the JavaScript backend's copy of it are built on this, so they agree to the last digit.
 */
export abstract class RigidBodyState implements BodyMotion {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly velocity = new Vector3();
  readonly angularVelocity = new Vector3();
  /** Centre of mass in world space, kept in sync with the pose by the world. */
  readonly worldCenterOfMass = new Vector3();
  /**
   * Inverse inertia tensor in world space, kept in sync with the pose by the world: how fast an
   * angular impulse turns the body, for working out how hard it is to push at a point. Read it;
   * don't change it.
   */
  readonly worldInverseInertia = new Matrix3();

  /**
   * @internal Whether the inertia is the same about every axis, as a sphere's is. Such a body has
   * no gyroscopic effect: spinning freely, its angular velocity never changes.
   */
  hasEvenInertia = false;

  private currentMassProperties: MassProperties | undefined;
  private currentInverseMass = 0;
  private readonly localInverseInertia = new Matrix3();

  constructor(readonly type: BodyType) {}

  get isDynamic(): boolean {
    return this.type === 'dynamic';
  }

  get massProperties(): MassProperties | undefined {
    return this.currentMassProperties;
  }

  /** Total mass in kg, or Infinity for bodies that forces can't move. */
  get mass(): number {
    return this.isDynamic && this.currentMassProperties ? this.currentMassProperties.mass : Infinity;
  }

  /** 1 / mass, or 0 for bodies that forces can't move. */
  get inverseMass(): number {
    return this.currentInverseMass;
  }

  /** @internal The inverse inertia tensor in the body frame, about the centre of mass; zero for bodies forces can't move. */
  get localInverseInertiaTensor(): Matrix3 {
    return this.localInverseInertia;
  }

  /** Velocity of the material point of the body currently at `worldPoint`. */
  pointVelocity(worldPoint: Vector3, target = new Vector3()): Vector3 {
    leverArm.subVectors(worldPoint, this.worldCenterOfMass);
    return target.crossVectors(this.angularVelocity, leverArm).add(this.velocity);
  }

  /** Where a point given in the body frame is in world space, written into `target`. */
  pointToWorld(localPoint: Vector3, target = new Vector3()): Vector3 {
    return target.copy(localPoint).applyQuaternion(this.quaternion).add(this.position);
  }

  /** Transforms `vector` from the body frame to world space in place, like Object3D.localToWorld. */
  localToWorld(vector: Vector3): Vector3 {
    return vector.applyQuaternion(this.quaternion).add(this.position);
  }

  /** Transforms `vector` from world space to the body frame in place, like Object3D.worldToLocal. */
  worldToLocal(vector: Vector3): Vector3 {
    return vector.sub(this.position).applyQuaternion(inverseQuaternion.copy(this.quaternion).invert());
  }

  /** Rotates a direction from the body frame to world space in place. */
  directionToWorld(vector: Vector3): Vector3 {
    return vector.applyQuaternion(this.quaternion);
  }

  /** @internal Recomputes the world centre of mass and world inverse inertia from the pose as it is. */
  refreshDerivedState(): void {
    this.refreshCenterOfMass();
    turnTensor(this.quaternion, this.localInverseInertia, this.worldInverseInertia);
  }

  /** @internal Recomputes only the world centre of mass. */
  refreshCenterOfMass(): void {
    const localCenterOfMass = this.currentMassProperties?.centerOfMass;
    if (localCenterOfMass) {
      this.pointToWorld(localCenterOfMass, this.worldCenterOfMass);
    } else {
      this.worldCenterOfMass.copy(this.position);
    }
  }

  /** Sets the mass properties after checking a dynamic body can be moved by them. Doesn't refresh the derived state. */
  protected assignMassProperties(massProperties: MassProperties): void {
    const inverseInertia = massProperties.inertia.clone().invert();
    if (this.isDynamic && !inverseInertia.elements.every(Number.isFinite)) {
      throw new InvalidMassError('Inertia tensor of a dynamic body must be invertible');
    }
    if (this.isDynamic && inverseInertia.determinant() <= 0) {
      throw new InvalidMassError('Inertia tensor of a dynamic body must be positive definite (is it only point masses?)');
    }
    this.currentMassProperties = massProperties;
    this.hasEvenInertia = isEven(massProperties.inertia);
    this.currentInverseMass = this.isDynamic ? 1 / massProperties.mass : 0;
    this.localInverseInertia.copy(this.isDynamic ? inverseInertia : zeroMatrix);
  }
}

/**
 * R T Rᵀ for the rotation R of `quaternion` and a symmetric tensor `tensor`, written into
 * `target`: the tensor turned into world space. Worked out with plain arithmetic, using the
 * symmetry, since it runs for every body on every substep.
 */
function turnTensor(quaternion: Quaternion, tensor: Matrix3, target: Matrix3): void {
  // the products of the quaternion's parts that make up R, as three.js's makeRotationFromQuaternion names them
  const twiceX = quaternion.x + quaternion.x;
  const twiceY = quaternion.y + quaternion.y;
  const twiceZ = quaternion.z + quaternion.z;
  const xx = quaternion.x * twiceX;
  const xy = quaternion.x * twiceY;
  const xz = quaternion.x * twiceZ;
  const yy = quaternion.y * twiceY;
  const yz = quaternion.y * twiceZ;
  const zz = quaternion.z * twiceZ;
  const wx = quaternion.w * twiceX;
  const wy = quaternion.w * twiceY;
  const wz = quaternion.w * twiceZ;
  // rows of R
  const r00 = 1 - (yy + zz);
  const r01 = xy - wz;
  const r02 = xz + wy;
  const r10 = xy + wz;
  const r11 = 1 - (xx + zz);
  const r12 = yz - wx;
  const r20 = xz - wy;
  const r21 = yz + wx;
  const r22 = 1 - (xx + yy);
  // the tensor, symmetric, read from three's column-major elements
  const elements = tensor.elements;
  const t00 = elements[0]!;
  const t01 = elements[3]!;
  const t02 = elements[6]!;
  const t11 = elements[4]!;
  const t12 = elements[7]!;
  const t22 = elements[8]!;
  // M = R T
  const m00 = r00 * t00 + r01 * t01 + r02 * t02;
  const m01 = r00 * t01 + r01 * t11 + r02 * t12;
  const m02 = r00 * t02 + r01 * t12 + r02 * t22;
  const m10 = r10 * t00 + r11 * t01 + r12 * t02;
  const m11 = r10 * t01 + r11 * t11 + r12 * t12;
  const m12 = r10 * t02 + r11 * t12 + r12 * t22;
  const m20 = r20 * t00 + r21 * t01 + r22 * t02;
  const m21 = r20 * t01 + r21 * t11 + r22 * t12;
  const m22 = r20 * t02 + r21 * t12 + r22 * t22;
  // M Rᵀ, symmetric again
  const w00 = m00 * r00 + m01 * r01 + m02 * r02;
  const w01 = m00 * r10 + m01 * r11 + m02 * r12;
  const w02 = m00 * r20 + m01 * r21 + m02 * r22;
  const w11 = m10 * r10 + m11 * r11 + m12 * r12;
  const w12 = m10 * r20 + m11 * r21 + m12 * r22;
  const w22 = m20 * r20 + m21 * r21 + m22 * r22;
  target.set(w00, w01, w02, w01, w11, w12, w02, w12, w22);
}

/** Whether a tensor is the same about every axis: a multiple of the identity, to rounding. */
function isEven(tensor: Matrix3): boolean {
  const elements = tensor.elements;
  const scale = Math.max(Math.abs(elements[0]!), Math.abs(elements[4]!), Math.abs(elements[8]!));
  const tolerance = 1e-12 * scale;
  const offDiagonal = [1, 2, 3, 5, 6, 7].every((index) => Math.abs(elements[index]!) <= tolerance);
  return offDiagonal && Math.abs(elements[0]! - elements[4]!) <= tolerance && Math.abs(elements[0]! - elements[8]!) <= tolerance;
}
