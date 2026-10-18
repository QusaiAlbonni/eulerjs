import { Vector3 } from 'three';
import type { Box3 } from 'three';
import { Collider } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';

/**
 * An infinite flat ground: everything on the side its normal points away from is solid. Its
 * normal is the collider's +y axis; turn it with `rotation`. Only for static and kinematic bodies.
 */
export class PlaneCollider extends Collider {
  readonly shape = 'plane';

  constructor(options: ColliderOptions = {}) {
    super(options);
  }

  get boundingRadius(): number {
    return Infinity;
  }

  /** The plane's normal in world space at `pose`. */
  normal(pose: ColliderPose, target = new Vector3()): Vector3 {
    const elements = pose.rotation.elements;
    return target.set(elements[3], elements[4], elements[5]);
  }

  bounds(_pose: ColliderPose, target: Box3): Box3 {
    target.min.setScalar(-Infinity);
    target.max.setScalar(Infinity);
    return target;
  }

  massProperties(): undefined {
    return undefined;
  }
}
