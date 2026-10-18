import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Box3, Matrix3 } from 'three';
import type { MassProperties, MassSpecification } from '../MassProperties.js';
import type { RigidBodyState } from '../RigidBodyState.js';

const rotationMatrixScratch = new Matrix4();

export interface ColliderOptions {
  /** Where the collider sits in its body's frame. Defaults to the origin. */
  offset?: Vector3 | undefined;
  /** How the collider is turned in its body's frame. */
  rotation?: Quaternion | undefined;
  /** Coulomb friction coefficient. Two colliders use the geometric mean of theirs. Defaults to 0.5. */
  friction?: number | undefined;
  /** Bounciness, 0 (none) to 1 (perfectly elastic). Two colliders use the larger. Defaults to 0. */
  restitution?: number | undefined;
  /**
   * Resistance to rolling, as a share of the load: a ball, capsule, cylinder or cone rolling on
   * this, or this one rolling, is held back by a torque of at most this times the contact force
   * times its radius, and so is one spinning on the spot. Two colliders use the larger. Defaults
   * to 0, rolling for ever; about 0.002 for steel on steel, 0.01 for a ball on a hard floor, 0.05
   * or more for something soft.
   */
  rollingResistance?: number | undefined;
  /** Bit mask of the groups this collider is in. Defaults to group 1. */
  collisionGroups?: number | undefined;
  /** Bit mask of the groups it collides with. Defaults to every group. */
  collidesWith?: number | undefined;
  /**
   * A sensor detects what overlaps it, reporting it through the world's `sensorEnter` and
   * `sensorExit` events, without pushing anything: a trigger volume, such as a finish line or a
   * pickup. Defaults to false.
   */
  sensor?: boolean | undefined;
}

/** Where a collider is in the world on the current substep. */
export interface ColliderPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  /** The collider's axes in world space, as matrix columns. */
  readonly rotation: Matrix3;
}

/**
 * The shape a body collides with: a description that every backend turns into its own shape.
 * Its material and filter settings can be changed at any time.
 */
export abstract class Collider {
  /** Name of the shape, used to find the right collision test for a pair of colliders. */
  abstract readonly shape: string;
  readonly offset: Vector3;
  readonly rotation: Quaternion;
  friction: number;
  restitution: number;
  rollingResistance: number;
  collisionGroups: number;
  collidesWith: number;
  sensor: boolean;

  constructor(options: ColliderOptions = {}) {
    this.offset = (options.offset ?? new Vector3()).clone();
    this.rotation = (options.rotation ?? new Quaternion()).clone().normalize();
    this.friction = options.friction ?? 0.5;
    this.restitution = options.restitution ?? 0;
    this.rollingResistance = options.rollingResistance ?? 0;
    this.collisionGroups = options.collisionGroups ?? 1;
    this.collidesWith = options.collidesWith ?? 0xffffffff;
    this.sensor = options.sensor ?? false;
  }

  /** @internal Writes where this collider is in the world, given its body's pose. */
  poseIn(body: RigidBodyState, target: { position: Vector3; quaternion: Quaternion; rotation: Matrix3 }): void {
    body.pointToWorld(this.offset, target.position);
    target.quaternion.multiplyQuaternions(body.quaternion, this.rotation);
    target.rotation.setFromMatrix4(rotationMatrixScratch.makeRotationFromQuaternion(target.quaternion));
  }

  canCollideWith(other: Collider): boolean {
    return (this.collisionGroups & other.collidesWith) !== 0 && (other.collisionGroups & this.collidesWith) !== 0;
  }

  /** World-space box around the collider at `pose`. Infinite shapes return an infinite box. */
  abstract bounds(pose: ColliderPose, target: Box3): Box3;

  /** Radius of a sphere around the offset that contains the shape; Infinity for infinite shapes. */
  abstract get boundingRadius(): number;

  /** Mass properties of the solid in the body frame, or undefined for shapes without a volume. */
  abstract massProperties(specification: MassSpecification): MassProperties | undefined;
}

