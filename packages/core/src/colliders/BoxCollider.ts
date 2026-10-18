import { Matrix3, Matrix4 } from 'three';
import type { Box3 , Vector3 } from 'three';
import { MassProperties } from '../MassProperties.js';
import type { MassSpecification } from '../MassProperties.js';
import { Collider } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';

export interface BoxColliderOptions extends ColliderOptions {
  /** Edge lengths along the collider's x, y and z axes. */
  size: Vector3;
}

const rotationScratch = new Matrix3();
const transposeScratch = new Matrix3();

/** A box, centred on the collider's position, its edges along the collider's axes. */
export class BoxCollider extends Collider {
  readonly shape = 'box';
  /** Half the edge lengths. */
  readonly halfExtents: Vector3;

  constructor(options: BoxColliderOptions) {
    super(options);
    if (!(options.size.x > 0 && options.size.y > 0 && options.size.z > 0)) {
      throw new RangeError(`every edge of a box must be positive, got ${options.size.toArray()}`);
    }
    this.halfExtents = options.size.clone().multiplyScalar(0.5);
  }

  get boundingRadius(): number {
    return this.halfExtents.length();
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    // half-widths of the turned box along each world axis: |R| e
    const elements = pose.rotation.elements;
    const { x: halfX, y: halfY, z: halfZ } = this.halfExtents;
    const reachX = Math.abs(elements[0]) * halfX + Math.abs(elements[3]) * halfY + Math.abs(elements[6]) * halfZ;
    const reachY = Math.abs(elements[1]) * halfX + Math.abs(elements[4]) * halfY + Math.abs(elements[7]) * halfZ;
    const reachZ = Math.abs(elements[2]) * halfX + Math.abs(elements[5]) * halfY + Math.abs(elements[8]) * halfZ;
    target.min.set(pose.position.x - reachX, pose.position.y - reachY, pose.position.z - reachZ);
    target.max.set(pose.position.x + reachX, pose.position.y + reachY, pose.position.z + reachZ);
    return target;
  }

  massProperties(specification: MassSpecification): MassProperties {
    const size = this.halfExtents.clone().multiplyScalar(2);
    const volume = size.x * size.y * size.z;
    const mass = 'mass' in specification ? specification.mass : specification.density * volume;
    const unturned = MassProperties.box(size, mass, this.offset);
    rotationScratch.setFromMatrix4(new Matrix4().makeRotationFromQuaternion(this.rotation));
    transposeScratch.copy(rotationScratch).transpose();
    const inertia = rotationScratch.clone().multiply(unturned.inertia).multiply(transposeScratch);
    return new MassProperties(mass, this.offset, inertia);
  }
}
