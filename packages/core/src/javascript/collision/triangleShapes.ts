import { Box3 } from 'three';
import type { Vector3 } from 'three';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import { registerCollisionTest } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';
import { triangleTestFor } from './triangle.js';

/** Receives one triangle in world space, wound anticlockwise seen from its front, and its active edges (see `TriangleTest`). */
export type TriangleVisitor = (first: Vector3, second: Vector3, third: Vector3, activeEdges: number) => void;

/** A shape made of triangles, such as a heightfield or a mesh, described by the triangles it has in a region. */
export interface TriangleShape<SomeCollider extends Collider = Collider> {
  /**
   * Calls `visit` for every triangle of `collider` at `pose` that may reach into `region`, a box
   * in world space. Triangles outside it may be visited too; the corners passed may be reused
   * once `visit` returns.
   */
  forEachTriangle(collider: SomeCollider, pose: ColliderPose, region: Box3, visit: TriangleVisitor): void;
  /** Whether only the front of each triangle is solid, as for terrain; otherwise both sides are. */
  readonly oneSided: boolean;
}

/** The convex shapes that collide with triangle shapes. */
const CONVEX_SHAPES = ['sphere', 'capsule', 'box', 'convex', 'cylinder', 'cone'];

const triangleShapes = new Map<string, TriangleShape>();
const region = new Box3();

/**
 * Teaches the engine a shape made of triangles: from the triangles it gives in a region, it
 * collides with every convex shape, and scene queries (ray casts, shape casts, overlaps) work
 * against it.
 */
export function registerTriangleShape<SomeCollider extends Collider>(shape: string, triangles: TriangleShape<SomeCollider>): void {
  triangleShapes.set(shape, triangles as TriangleShape);
  const test = (other: Collider, otherPose: ColliderPose, collider: SomeCollider, pose: ColliderPose, contacts: ContactPoint[], margin: number) => {
    const againstTriangle = triangleTestFor(other, otherPose);
    if (!againstTriangle) return;
    other.bounds(otherPose, region).expandByScalar(margin);
    triangles.forEachTriangle(collider, pose, region, (first, second, third, activeEdges) =>
      againstTriangle(first, second, third, contacts, margin, triangles.oneSided, activeEdges),
    );
  };
  for (const other of CONVEX_SHAPES) registerCollisionTest(other, shape, test);
}

/** How a shape is made of triangles, if it is one. */
export function triangleShapeOf(collider: Collider): TriangleShape | undefined {
  return triangleShapes.get(collider.shape);
}
