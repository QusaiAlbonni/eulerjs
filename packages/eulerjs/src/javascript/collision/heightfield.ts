import { Matrix3, Vector3 } from 'three';
import type { Box3 } from 'three';
import type { ColliderPose } from '../../colliders/Collider.js';
import type { HeightfieldCollider } from '../../colliders/HeightfieldCollider.js';
import { registerTriangleShape } from './triangleShapes.js';
import type { TriangleVisitor } from './triangleShapes.js';

const localMinimum = new Vector3();
const localMaximum = new Vector3();
const corner = new Vector3();
const inverseRotation = new Matrix3();
const worldFirst = new Vector3();
const worldSecond = new Vector3();
const worldThird = new Vector3();

/** The triangles of the heightfield cells under a box in world space. */
function forEachTriangle(field: HeightfieldCollider, pose: ColliderPose, region: Box3, visit: TriangleVisitor): void {
  // the region as a box in the heightfield's frame
  inverseRotation.copy(pose.rotation).transpose();
  localMinimum.setScalar(Infinity);
  localMaximum.setScalar(-Infinity);
  for (const cornerX of [region.min.x, region.max.x]) {
    for (const cornerY of [region.min.y, region.max.y]) {
      for (const cornerZ of [region.min.z, region.max.z]) {
        corner.set(cornerX, cornerY, cornerZ).sub(pose.position).applyMatrix3(inverseRotation);
        localMinimum.min(corner);
        localMaximum.max(corner);
      }
    }
  }
  const toWorld = (local: Vector3, target: Vector3) => target.copy(local).applyMatrix3(pose.rotation).add(pose.position);
  field.forEachTriangleIn(localMinimum, localMaximum, (first, second, third, activeEdges) => {
    visit(toWorld(first, worldFirst), toWorld(second, worldSecond), toWorld(third, worldThird), activeEdges);
  });
}

/** Registers heightfields as a triangle shape. Called by the collision system; safe to call again. */
export function registerHeightfieldCollisionTests(): void {
  registerTriangleShape<HeightfieldCollider>('heightfield', { forEachTriangle, oneSided: true });
}
