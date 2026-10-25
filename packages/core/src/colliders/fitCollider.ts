import { Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import type { ColliderShorthand } from '../Body.js';
import { BoxCollider } from './BoxCollider.js';
import { CapsuleCollider } from './CapsuleCollider.js';
import type { Collider, ColliderOptions } from './Collider.js';
import { ConeCollider } from './ConeCollider.js';
import { ConvexCollider } from './ConvexCollider.js';
import { CylinderCollider } from './CylinderCollider.js';
import { SphereCollider } from './SphereCollider.js';

/**
 * A collider of the given shape fitted around a geometry, in the geometry's frame: its bounding
 * box, its bounding sphere, its convex hull, or a cylinder, cone or capsule standing along its y
 * axis, as three.js's own cylinder, cone and capsule geometries do, as wide as the wider of x and z.
 * What `world.addBody(object, { collider: 'box' })` and the rest fit; `options` sets the rest of
 * the collider, its friction say, all but where it sits, which the fit decides.
 */
export function fitCollider(shape: ColliderShorthand, geometry: BufferGeometry, options: Omit<ColliderOptions, 'offset' | 'rotation'> = {}): Collider {
  if (shape === 'convex') return ConvexCollider.fromGeometry(geometry, options);
  if (shape === 'sphere') {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere!;
    return new SphereCollider({ ...options, radius: sphere.radius, offset: sphere.center.clone() });
  }
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const size = bounds.getSize(new Vector3());
  const offset = bounds.getCenter(new Vector3());
  const radius = Math.max(size.x, size.z) / 2;
  switch (shape) {
    case 'box':
      return new BoxCollider({ ...options, size, offset });
    case 'cylinder':
      return new CylinderCollider({ ...options, radius, height: size.y, offset });
    case 'cone':
      return new ConeCollider({ ...options, radius, height: size.y, offset });
    case 'capsule':
      return new CapsuleCollider({ ...options, radius, length: Math.max(0, size.y - 2 * radius), offset });
  }
}
