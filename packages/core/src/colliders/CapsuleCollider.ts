import { Matrix3, Matrix4, Vector3 } from 'three';
import type { Box3 } from 'three';
import { MassProperties } from '../MassProperties.js';
import type { MassSpecification } from '../MassProperties.js';
import { Collider, ROUND_ROLLING_RESISTANCE } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';

export interface CapsuleColliderOptions extends ColliderOptions {
  radius: number;
  /** Distance between the centres of the two rounded ends, along the collider's y axis. 0 makes a sphere. */
  length: number;
}

const rotationScratch = new Matrix3();
const transposeScratch = new Matrix3();
const axisScratch = new Vector3();
const startScratch = new Vector3();
const endScratch = new Vector3();

/** A cylinder with rounded ends, along its y axis: the usual shape for limbs and characters. */
export class CapsuleCollider extends Collider {
  readonly shape = 'capsule';
  radius: number;
  length: number;

  constructor(options: CapsuleColliderOptions) {
    super(options, ROUND_ROLLING_RESISTANCE);
    if (!(options.radius > 0)) throw new RangeError(`radius must be positive, got ${options.radius}`);
    if (!(options.length >= 0)) throw new RangeError(`length must not be negative, got ${options.length}`);
    this.radius = options.radius;
    this.length = options.length;
  }

  get boundingRadius(): number {
    return this.length / 2 + this.radius;
  }

  /** Writes the centres of the two rounded ends in world space, for the collider at `pose`. */
  endsAt(pose: ColliderPose, start: Vector3, end: Vector3): void {
    const elements = pose.rotation.elements;
    const halfLength = this.length / 2;
    axisScratch.set(elements[3]! * halfLength, elements[4]! * halfLength, elements[5]! * halfLength);
    start.copy(pose.position).sub(axisScratch);
    end.copy(pose.position).add(axisScratch);
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    this.endsAt(pose, startScratch, endScratch);
    target.min.copy(startScratch).min(endScratch).subScalar(this.radius);
    target.max.copy(startScratch).max(endScratch).addScalar(this.radius);
    return target;
  }

  massProperties(specification: MassSpecification): MassProperties {
    const volume = Math.PI * this.radius ** 2 * this.length + (4 / 3) * Math.PI * this.radius ** 3;
    const mass = 'mass' in specification ? specification.mass : specification.density * volume;
    const unturned = MassProperties.capsule(this.radius, this.length, mass, this.offset);
    rotationScratch.setFromMatrix4(new Matrix4().makeRotationFromQuaternion(this.rotation));
    transposeScratch.copy(rotationScratch).transpose();
    const inertia = rotationScratch.clone().multiply(unturned.inertia).multiply(transposeScratch);
    return new MassProperties(mass, this.offset, inertia);
  }
}
