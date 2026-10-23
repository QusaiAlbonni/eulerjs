import type { Box3 } from 'three';
import { MassProperties } from '../MassProperties.js';
import type { MassSpecification } from '../MassProperties.js';
import { Collider, ROUND_ROLLING_RESISTANCE } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';

export interface SphereColliderOptions extends ColliderOptions {
  /** In metres. */
  radius: number;
}

/** A sphere, centred on the collider's position. */
export class SphereCollider extends Collider {
  readonly shape = 'sphere';
  radius: number;

  constructor(options: SphereColliderOptions) {
    super(options, ROUND_ROLLING_RESISTANCE);
    if (!(options.radius > 0)) throw new RangeError(`radius must be positive, got ${options.radius}`);
    this.radius = options.radius;
  }

  get boundingRadius(): number {
    return this.radius;
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    target.min.copy(pose.position).subScalar(this.radius);
    target.max.copy(pose.position).addScalar(this.radius);
    return target;
  }

  massProperties(specification: MassSpecification): MassProperties {
    const volume = (4 / 3) * Math.PI * this.radius ** 3;
    const mass = 'mass' in specification ? specification.mass : specification.density * volume;
    return MassProperties.sphere(this.radius, mass, this.offset);
  }
}
