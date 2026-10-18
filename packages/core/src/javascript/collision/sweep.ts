import { Box3, Vector3 } from 'three';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import { PlaneCollider } from '../../colliders/PlaneCollider.js';
import { shapeDistance, supportShapeOf, triangleShape } from './gjk.js';
import type { SupportShape } from './gjk.js';
import { triangleShapeOf } from './triangleShapes.js';

/**
 * The geometry of scene queries against one collider: casting a ray or sweeping a shape along a
 * straight line until it first touches, and testing whether two shapes overlap.
 *
 * A sweep is conservative advancement on GJK distances: the gap between two convex shapes, as one
 * slides along a line, is a convex function of how far it has slid, so the slide that would
 * close the gap if it kept shrinking at its current rate never overshoots. That converges in a
 * few steps, in one against a flat face.
 */

/** Where a ray or swept shape first touches a collider. */
export interface SweepHit {
  /** How far along the direction the ray or shape travelled before touching. */
  distance: number;
  /** The touching point, on the collider's surface. */
  point: Vector3;
  /** The collider's surface normal there, pointing out toward the ray or shape. */
  normal: Vector3;
}

/** A ray or shape registered by a plugin with its own way of casting against a shape, such as a mesh's bounding volume tree. */
export type RayTest<SomeCollider extends Collider = Collider> = (collider: SomeCollider, pose: ColliderPose, origin: Vector3, direction: Vector3, maxDistance: number) => SweepHit | undefined;

const rayTests = new Map<string, RayTest>();

/** Gives a shape a ray cast of its own, used instead of the general one. */
export function registerRayTest<SomeCollider extends Collider>(shape: string, test: RayTest<SomeCollider>): void {
  rayTests.set(shape, test as RayTest);
}

/**
 * How close, in metres, the sweep comes before it works out the last bit of the way from the
 * gap's rate of closing, exactly for flat faces. Much closer and GJK's nearest points and normal
 * drown in rounding.
 */
const TOUCHING = 1e-5;
const MAX_ADVANCES = 64;

/** A support shape slid along `direction` by `distance`. */
function slid(shape: SupportShape, direction: Vector3, distance: number): SupportShape {
  const offset = direction.clone().multiplyScalar(distance);
  return { center: shape.center.clone().add(offset), radius: shape.radius, support: (toward, target) => shape.support(toward, target).add(offset) };
}

/** How far `moving` slides along the unit `direction` before it touches `fixed`, up to `maxDistance`. */
export function sweepShapes(moving: SupportShape, direction: Vector3, fixed: SupportShape, maxDistance: number): SweepHit | undefined {
  let travelled = 0;
  for (let advance = 0; advance < MAX_ADVANCES; advance++) {
    const gap = shapeDistance(slid(moving, direction, travelled), fixed);
    if (gap.overlapping) {
      // overlapping from the start: touching at once, the way back being against the direction
      if (travelled === 0) return { distance: 0, point: moving.center.clone(), normal: direction.clone().negate() };
      return { distance: travelled, point: gap.pointB, normal: gap.normal };
    }
    const closing = -direction.dot(gap.normal);
    if (gap.distance < TOUCHING) {
      const distance = travelled + (closing > 0 ? gap.distance / closing : 0);
      return distance > maxDistance ? undefined : { distance, point: gap.pointB, normal: gap.normal };
    }
    if (closing <= 1e-12) return undefined;
    // to just short of touching, where the nearest points and normal are still well defined
    travelled += (gap.distance - TOUCHING / 2) / closing;
    if (travelled > maxDistance) return undefined;
  }
  return undefined;
}

const sweptRegion = new Box3();
const endBounds = new Box3();

/** Where the convex `moving` shape (a collider at `movingPose`), slid along the unit `direction`, first touches `target`. */
export function sweepAgainst(
  moving: SupportShape,
  movingBounds: Box3,
  direction: Vector3,
  maxDistance: number,
  target: Collider,
  targetPose: ColliderPose,
): SweepHit | undefined {
  if (target instanceof PlaneCollider) return sweepAgainstPlane(moving, direction, maxDistance, target, targetPose);
  const convex = supportShapeOf(target, targetPose);
  if (convex) return sweepShapes(moving, direction, convex, maxDistance);
  const triangles = triangleShapeOf(target);
  if (!triangles) return undefined;
  // the triangles the moving shape passes over, within the target's bounds
  const reach = Number.isFinite(maxDistance) ? maxDistance : 0;
  sweptRegion.copy(movingBounds).union(endBounds.copy(movingBounds).translate(direction.clone().multiplyScalar(reach)));
  if (!Number.isFinite(maxDistance)) sweptRegion.union(target.bounds(targetPose, endBounds));
  let nearest: SweepHit | undefined;
  triangles.forEachTriangle(target, targetPose, sweptRegion, (first, second, third) => {
    if (triangles.oneSided && behindTriangle(moving.center, first, second, third)) return;
    const hit = sweepShapes(moving, direction, triangleShape(first, second, third), nearest?.distance ?? maxDistance);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
  });
  return nearest;
}

function sweepAgainstPlane(moving: SupportShape, direction: Vector3, maxDistance: number, plane: PlaneCollider, planePose: ColliderPose): SweepHit | undefined {
  const normal = plane.normal(planePose);
  const lowest = moving.support(normal.clone().negate(), new Vector3()).addScaledVector(normal, -moving.radius);
  const height = normal.dot(lowest) - normal.dot(planePose.position);
  if (height <= 0) return { distance: 0, point: lowest.addScaledVector(normal, -height), normal };
  const closing = -direction.dot(normal);
  if (closing <= 1e-12 || height / closing > maxDistance) return undefined;
  const distance = height / closing;
  return { distance, point: lowest.addScaledVector(direction, distance), normal };
}

function behindTriangle(point: Vector3, first: Vector3, second: Vector3, third: Vector3): boolean {
  const normal = new Vector3().subVectors(second, first).cross(new Vector3().subVectors(third, first));
  return normal.dot(new Vector3().subVectors(point, first)) < 0;
}

/** Where a ray from `origin` along the unit `direction` first meets `target`, up to `maxDistance`. A ray starting inside a solid meets it at once. */
export function castRayAgainst(origin: Vector3, direction: Vector3, maxDistance: number, target: Collider, targetPose: ColliderPose): SweepHit | undefined {
  const ownTest = rayTests.get(target.shape);
  if (ownTest) return ownTest(target, targetPose, origin, direction, maxDistance);
  const triangles = triangleShapeOf(target);
  if (triangles) return rayAgainstTriangles(origin, direction, maxDistance, target, targetPose, triangles.oneSided);
  const point: SupportShape = { center: origin, radius: 0, support: (_toward, result) => result.copy(origin) };
  const pointBounds = new Box3(origin.clone(), origin.clone());
  const hit = sweepAgainst(point, pointBounds, direction, maxDistance, target, targetPose);
  // on the ray itself, rather than the nearest point of the surface to where the sweep stopped
  if (hit) hit.point.copy(origin).addScaledVector(direction, hit.distance);
  return hit;
}

function rayAgainstTriangles(origin: Vector3, direction: Vector3, maxDistance: number, target: Collider, targetPose: ColliderPose, oneSided: boolean): SweepHit | undefined {
  const triangles = triangleShapeOf(target)!;
  // the part of the ray inside the target's bounds
  const bounds = target.bounds(targetPose, new Box3());
  const span = raySpanInBox(origin, direction, bounds);
  if (!span) return undefined;
  const end = Math.min(span.exit, maxDistance);
  if (span.enter > end) return undefined;
  const region = new Box3().setFromPoints([origin.clone().addScaledVector(direction, span.enter), origin.clone().addScaledVector(direction, end)]);
  let nearest: SweepHit | undefined;
  triangles.forEachTriangle(target, targetPose, region, (first, second, third) => {
    const hit = rayTriangle(origin, direction, first, second, third, oneSided);
    if (hit && hit.distance <= end && (!nearest || hit.distance < nearest.distance)) nearest = hit;
  });
  return nearest;
}

/** Where a ray meets a triangle (Möller and Trumbore 1997), from the front only if `oneSided`. */
export function rayTriangle(origin: Vector3, direction: Vector3, first: Vector3, second: Vector3, third: Vector3, oneSided: boolean): SweepHit | undefined {
  const edge = new Vector3().subVectors(second, first);
  const otherEdge = new Vector3().subVectors(third, first);
  const across = new Vector3().crossVectors(direction, otherEdge);
  const determinant = edge.dot(across);
  // the determinant is minus the direction along the normal: positive coming at the front
  if (Math.abs(determinant) < 1e-14 || (oneSided && determinant < 0)) return undefined;
  const fromFirst = new Vector3().subVectors(origin, first);
  const alongEdge = fromFirst.dot(across) / determinant;
  if (alongEdge < 0 || alongEdge > 1) return undefined;
  const up = new Vector3().crossVectors(fromFirst, edge);
  const alongOther = direction.dot(up) / determinant;
  if (alongOther < 0 || alongEdge + alongOther > 1) return undefined;
  const distance = otherEdge.dot(up) / determinant;
  if (distance < 0) return undefined;
  const normal = new Vector3().crossVectors(edge, otherEdge).normalize();
  if (normal.dot(direction) > 0) normal.negate();
  return { distance, point: origin.clone().addScaledVector(direction, distance), normal };
}

/** The stretch of a ray inside a box, as distances along it, or undefined if it misses. */
export function raySpanInBox(origin: Vector3, direction: Vector3, box: Box3): { enter: number; exit: number } | undefined {
  let enter = 0;
  let exit = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const along = direction[axis];
    if (Math.abs(along) < 1e-15) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return undefined;
      continue;
    }
    let near = (box.min[axis] - origin[axis]) / along;
    let far = (box.max[axis] - origin[axis]) / along;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    exit = Math.min(exit, far);
    if (enter > exit) return undefined;
  }
  return { enter, exit };
}

/** Whether a convex shape overlaps `target`. */
export function overlapsCollider(shape: SupportShape, shapeBounds: Box3, target: Collider, targetPose: ColliderPose): boolean {
  if (target instanceof PlaneCollider) {
    const normal = target.normal(targetPose);
    const lowest = shape.support(normal.clone().negate(), new Vector3());
    return normal.dot(lowest) - shape.radius <= normal.dot(targetPose.position);
  }
  const convex = supportShapeOf(target, targetPose);
  if (convex) return shapeDistance(shape, convex).overlapping;
  const triangles = triangleShapeOf(target);
  if (!triangles) return false;
  let overlapping = false;
  triangles.forEachTriangle(target, targetPose, shapeBounds, (first, second, third) => {
    if (overlapping) return;
    if (shapeDistance(shape, triangleShape(first, second, third)).overlapping) overlapping = true;
    // below one-sided terrain counts as inside it
    else if (triangles.oneSided && behindTriangle(shape.center, first, second, third) && underTriangle(shape.center, first, second, third)) overlapping = true;
  });
  return overlapping;
}

/** Whether `point` is straight behind the triangle, within its outline. */
function underTriangle(point: Vector3, first: Vector3, second: Vector3, third: Vector3): boolean {
  const normal = new Vector3().subVectors(second, first).cross(new Vector3().subVectors(third, first)).normalize();
  const height = normal.dot(new Vector3().subVectors(point, first));
  const projected = point.clone().addScaledVector(normal, -height);
  return rayTriangle(projected.clone().addScaledVector(normal, 1), normal.clone().negate(), first, second, third, false) !== undefined;
}

const boundsScratch = new Box3();

/** Whether two colliders overlap or touch: for sensors. At least one must be convex; two shapes of triangles never do. */
export function collidersOverlap(colliderA: Collider, poseA: ColliderPose, colliderB: Collider, poseB: ColliderPose): boolean {
  const convexA = supportShapeOf(colliderA, poseA);
  if (convexA) return overlapsCollider(convexA, colliderA.bounds(poseA, boundsScratch), colliderB, poseB);
  const convexB = supportShapeOf(colliderB, poseB);
  if (convexB) return overlapsCollider(convexB, colliderB.bounds(poseB, boundsScratch), colliderA, poseA);
  return false;
}
