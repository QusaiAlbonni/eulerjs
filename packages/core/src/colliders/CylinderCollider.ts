import { Vector3 } from 'three';
import type { Box3 } from 'three';
import { MassProperties } from '../MassProperties.js';
import type { MassSpecification } from '../MassProperties.js';
import { Collider, ROUND_ROLLING_RESISTANCE } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';
import { ConvexCollider } from './ConvexCollider.js';

export interface CylinderColliderOptions extends ColliderOptions {
  radius: number;
  /** Length along the collider's y axis, centred on its origin, as three.js's CylinderGeometry. */
  height: number;
}

/** How many sides the hull standing in for a round shape has, against shapes other than planes and spheres. */
export const ROUND_HULL_SIDES = 16;

const axisScratch = new Vector3();

/**
 * A solid cylinder along its y axis, such as a barrel, a log or a wheel. Its mass, ray casts and
 * contacts with planes and spheres are exact, so it rolls smoothly on the ground; against other
 * shapes it collides as a 16-sided prism.
 */
export class CylinderCollider extends Collider {
  readonly shape = 'cylinder';
  readonly radius: number;
  readonly height: number;
  private standIn: ConvexCollider | undefined;

  constructor(options: CylinderColliderOptions) {
    super(options, ROUND_ROLLING_RESISTANCE);
    if (!(options.radius > 0)) throw new RangeError(`radius must be positive, got ${options.radius}`);
    if (!(options.height > 0)) throw new RangeError(`height must be positive, got ${options.height}`);
    this.radius = options.radius;
    this.height = options.height;
  }

  get boundingRadius(): number {
    return Math.sqrt(this.radius ** 2 + (this.height / 2) ** 2);
  }

  /** @internal The prism it collides as against shapes it has no exact test for, in the collider's frame. */
  get hull(): ConvexCollider {
    this.standIn ??= new ConvexCollider({ points: roundPrismPoints(this.radius, this.height / 2, this.radius, -this.height / 2) });
    return this.standIn;
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    axisAt(pose, axisScratch);
    for (const component of ['x', 'y', 'z'] as const) {
      const along = axisScratch[component];
      const reach = (this.height / 2) * Math.abs(along) + this.radius * Math.sqrt(Math.max(0, 1 - along * along));
      target.min[component] = pose.position[component] - reach;
      target.max[component] = pose.position[component] + reach;
    }
    return target;
  }

  massProperties(specification: MassSpecification): MassProperties {
    const volume = Math.PI * this.radius ** 2 * this.height;
    const mass = 'mass' in specification ? specification.mass : specification.density * volume;
    return MassProperties.cylinder(this.radius, this.height, mass).placed(this.offset, this.rotation);
  }
}

/** Writes the world-space direction of the collider's y axis at `pose`. */
export function axisAt(pose: ColliderPose, target: Vector3): Vector3 {
  const elements = pose.rotation.elements;
  return target.set(elements[3]!, elements[4]!, elements[5]!);
}

/**
 * Corners of a prism with round ends, along y: a ring of `topRadius` at height `top` and one of
 * `bottomRadius` at `bottom`; a radius of 0 gives a single point, the tip of a cone.
 */
export function roundPrismPoints(topRadius: number, top: number, bottomRadius: number, bottom: number): Vector3[] {
  const points: Vector3[] = [];
  for (const [radius, height] of [
    [topRadius, top],
    [bottomRadius, bottom],
  ] as const) {
    if (radius === 0) {
      points.push(new Vector3(0, height, 0));
      continue;
    }
    // the ring's corners lie outside the circle so the prism's flat sides touch it, never cutting in
    const cornerRadius = radius / Math.cos(Math.PI / ROUND_HULL_SIDES);
    for (let side = 0; side < ROUND_HULL_SIDES; side++) {
      const angle = (2 * Math.PI * side) / ROUND_HULL_SIDES;
      points.push(new Vector3(cornerRadius * Math.cos(angle), height, cornerRadius * Math.sin(angle)));
    }
  }
  return points;
}
