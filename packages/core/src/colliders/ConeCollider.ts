import { Vector3 } from 'three';
import type { Box3 } from 'three';
import { MassProperties } from '../MassProperties.js';
import type { MassSpecification } from '../MassProperties.js';
import { Collider } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';
import { ConvexCollider } from './ConvexCollider.js';
import { axisAt, roundPrismPoints } from './CylinderCollider.js';

export interface ConeColliderOptions extends ColliderOptions {
  /** Radius of the base. */
  radius: number;
  /** From base to tip along the collider's y axis, tip up, centred on its origin as three.js's ConeGeometry. */
  height: number;
}

const axisScratch = new Vector3();

/**
 * A solid cone along its y axis, tip up, such as a traffic cone. Its mass, ray casts and contacts
 * with planes are exact; against other shapes it collides as a 16-sided pyramid.
 */
export class ConeCollider extends Collider {
  readonly shape = 'cone';
  readonly radius: number;
  readonly height: number;
  private standIn: ConvexCollider | undefined;

  constructor(options: ConeColliderOptions) {
    super(options);
    if (!(options.radius > 0)) throw new RangeError(`radius must be positive, got ${options.radius}`);
    if (!(options.height > 0)) throw new RangeError(`height must be positive, got ${options.height}`);
    this.radius = options.radius;
    this.height = options.height;
  }

  get boundingRadius(): number {
    return Math.sqrt(this.radius ** 2 + (this.height / 2) ** 2);
  }

  /** @internal The pyramid it collides as against shapes it has no exact test for, in the collider's frame. */
  get hull(): ConvexCollider {
    this.standIn ??= new ConvexCollider({ points: roundPrismPoints(0, this.height / 2, this.radius, -this.height / 2) });
    return this.standIn;
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    axisAt(pose, axisScratch);
    for (const component of ['x', 'y', 'z'] as const) {
      const along = axisScratch[component];
      const tip = pose.position[component] + (this.height / 2) * along;
      const baseCenter = pose.position[component] - (this.height / 2) * along;
      const baseReach = this.radius * Math.sqrt(Math.max(0, 1 - along * along));
      target.min[component] = Math.min(tip, baseCenter - baseReach);
      target.max[component] = Math.max(tip, baseCenter + baseReach);
    }
    return target;
  }

  massProperties(specification: MassSpecification): MassProperties {
    const volume = (Math.PI * this.radius ** 2 * this.height) / 3;
    const mass = 'mass' in specification ? specification.mass : specification.density * volume;
    return MassProperties.cone(this.radius, this.height, mass).placed(this.offset, this.rotation);
  }
}
