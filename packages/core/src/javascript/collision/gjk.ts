import { Vector3 } from 'three';
import { BoxCollider } from '../../colliders/BoxCollider.js';
import { CapsuleCollider } from '../../colliders/CapsuleCollider.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import { ConeCollider } from '../../colliders/ConeCollider.js';
import { ConvexCollider } from '../../colliders/ConvexCollider.js';
import { CylinderCollider } from '../../colliders/CylinderCollider.js';
import { SphereCollider } from '../../colliders/SphereCollider.js';
import { place } from './convex.js';

/**
 * Distances between convex shapes by GJK (Gilbert, Johnson and Keerthi 1988), for scene queries.
 * Each shape is described by its support function: the point of it furthest along a direction.
 * Spheres and capsules are a point and a segment with a radius around them, which keeps GJK
 * working on corners and keeps their round surfaces exact.
 */

/** A convex shape in world space, as GJK sees it: a core with a support function, and a radius around it. */
export interface SupportShape {
  /** Writes the point of the core furthest along `direction` (not necessarily a unit vector). */
  support(direction: Vector3, target: Vector3): Vector3;
  /** A point inside the core. */
  readonly center: Vector3;
  readonly radius: number;
}

/** How close two shapes are: the gap between them and the nearest points of each. */
export interface ShapeDistance {
  /** The gap; 0 when the shapes touch or overlap. */
  distance: number;
  /** Nearest points on each shape's surface; meaningless when overlapping. */
  pointA: Vector3;
  pointB: Vector3;
  /** Unit direction from B toward A; meaningless when overlapping. */
  normal: Vector3;
  overlapping: boolean;
}

const MAX_ITERATIONS = 64;
/** Relative progress below which GJK stops: it has found the nearest points to rounding. */
const RELATIVE_TOLERANCE = 1e-14;

const localDirection = new Vector3();
const nearer = new Vector3();

/** The support shape of a convex collider at `pose`, or undefined for shapes that aren't convex solids: planes, heightfields, meshes. */
export function supportShapeOf(collider: Collider, pose: ColliderPose): SupportShape | undefined {
  const center = pose.position.clone();
  if (collider instanceof SphereCollider) return { center, radius: collider.radius, support: (_direction, target) => target.copy(center) };
  if (collider instanceof CapsuleCollider) {
    const axis = new Vector3().setFromMatrix3Column(pose.rotation, 1).multiplyScalar(collider.length / 2);
    return { center, radius: collider.radius, support: (direction, target) => target.copy(center).addScaledVector(axis, direction.dot(axis) >= 0 ? 1 : -1) };
  }
  const rotation = pose.rotation.clone();
  const inverse = rotation.clone().transpose();
  const toWorld = (local: Vector3, target: Vector3) => target.copy(local).applyMatrix3(rotation).add(center);
  if (collider instanceof BoxCollider) {
    const half = collider.halfExtents.clone();
    return {
      center,
      radius: 0,
      support: (direction, target) => {
        localDirection.copy(direction).applyMatrix3(inverse);
        return toWorld(localDirection.set(Math.sign(localDirection.x) * half.x || half.x, Math.sign(localDirection.y) * half.y || half.y, Math.sign(localDirection.z) * half.z || half.z), target);
      },
    };
  }
  if (collider instanceof ConvexCollider) {
    const placed = place(collider, pose);
    const vertices = placed.vertices;
    return { center: placed.center.clone(), radius: 0, support: (direction, target) => target.copy(furthest(vertices, direction)) };
  }
  if (collider instanceof CylinderCollider || collider instanceof ConeCollider) {
    const half = collider.height / 2;
    const isCone = collider instanceof ConeCollider;
    const coreCenter = isCone ? toWorld(new Vector3(0, -half / 2, 0), new Vector3()) : center;
    return {
      center: coreCenter,
      radius: 0,
      support: (direction, target) => {
        localDirection.copy(direction).applyMatrix3(inverse);
        const across = Math.hypot(localDirection.x, localDirection.z);
        const rimX = across > 1e-12 ? (collider.radius * localDirection.x) / across : collider.radius;
        const rimZ = across > 1e-12 ? (collider.radius * localDirection.z) / across : 0;
        if (isCone) {
          // the tip, or the point of the base's rim furthest along the direction
          const tipReach = localDirection.y * half;
          const rimReach = rimX * localDirection.x + rimZ * localDirection.z - localDirection.y * half;
          return toWorld(tipReach >= rimReach ? localDirection.set(0, half, 0) : localDirection.set(rimX, -half, rimZ), target);
        }
        return toWorld(localDirection.set(rimX, localDirection.y >= 0 ? half : -half, rimZ), target);
      },
    };
  }
  return undefined;
}

/** The support shape of the triangle (first, second, third). */
export function triangleShape(first: Vector3, second: Vector3, third: Vector3): SupportShape {
  const corners = [first.clone(), second.clone(), third.clone()];
  return { center: new Vector3().add(first).add(second).add(third).divideScalar(3), radius: 0, support: (direction, target) => target.copy(furthest(corners, direction)) };
}

function furthest(points: readonly Vector3[], direction: Vector3): Vector3 {
  let best = points[0]!;
  let bestReach = best.dot(direction);
  for (let index = 1; index < points.length; index++) {
    const reach = points[index]!.dot(direction);
    if (reach > bestReach) {
      best = points[index]!;
      bestReach = reach;
    }
  }
  return best;
}

/** A corner of the simplex: a point of the Minkowski difference A - B, and the points of A and B it came from. */
interface SimplexPoint {
  difference: Vector3;
  onA: Vector3;
  onB: Vector3;
}

/** The nearest points of two support shapes and the gap between their surfaces. */
export function shapeDistance(shapeA: SupportShape, shapeB: SupportShape): ShapeDistance {
  const toward = new Vector3().subVectors(shapeA.center, shapeB.center);
  if (toward.lengthSq() < 1e-24) toward.set(1, 0, 0);
  let simplex: SimplexPoint[] = [];
  let weights: number[] = [];
  const closest = toward.clone();
  const searchDirection = new Vector3();
  let overlapping = false;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    searchDirection.copy(closest).negate();
    const onA = shapeA.support(searchDirection, new Vector3()).clone();
    const onB = shapeB.support(closest, new Vector3()).clone();
    const difference = new Vector3().subVectors(onA, onB);
    const closestSquared = closest.lengthSq();
    // no point of the difference is nearer the origin than `closest` by more than rounding: done
    if (simplex.length > 0 && closestSquared - closest.dot(difference) <= RELATIVE_TOLERANCE * closestSquared) break;
    if (simplex.some((point) => point.difference.distanceToSquared(difference) < 1e-24)) break;
    const reduced = nearestToOrigin([...simplex, { difference, onA, onB }]);
    nearer.set(0, 0, 0);
    reduced.simplex.forEach((point, index) => nearer.addScaledVector(point.difference, reduced.weights[index]!));
    // Each step comes nearer the origin, or GJK is done. A step that doesn't is rounding in a
    // simplex gone flat, a support point all but repeated (as a cone's rim point is, close to its
    // side), and its nearest point can be anywhere: the last simplex stands.
    if (simplex.length > 0 && reduced.simplex.length < 4 && nearer.lengthSq() >= closestSquared) break;
    simplex = reduced.simplex;
    weights = reduced.weights;
    closest.copy(nearer);
    if (simplex.length === 4 || closest.lengthSq() < 1e-24) {
      overlapping = true;
      break;
    }
  }
  const coreDistance = overlapping ? 0 : closest.length();
  const pointA = new Vector3();
  const pointB = new Vector3();
  simplex.forEach((point, index) => {
    pointA.addScaledVector(point.onA, weights[index]!);
    pointB.addScaledVector(point.onB, weights[index]!);
  });
  const normal = coreDistance > 0 ? closest.clone().divideScalar(coreDistance) : new Vector3(0, 1, 0);
  pointA.addScaledVector(normal, -shapeA.radius);
  pointB.addScaledVector(normal, shapeB.radius);
  const distance = coreDistance - shapeA.radius - shapeB.radius;
  return { distance: Math.max(distance, 0), pointA, pointB, normal, overlapping: overlapping || distance <= 0 };
}

/**
 * The point of the simplex nearest the origin, as weights of its corners, and the smallest part of
 * the simplex that holds it (Ericson, Real-Time Collision Detection, 5.1). Four corners means the
 * origin is inside.
 */
function nearestToOrigin(simplex: SimplexPoint[]): { simplex: SimplexPoint[]; weights: number[] } {
  if (simplex.length === 1) return { simplex, weights: [1] };
  if (simplex.length === 2) return nearestOnSegment(simplex[0]!, simplex[1]!);
  if (simplex.length === 3) return nearestOnTriangle(simplex[0]!, simplex[1]!, simplex[2]!);
  return nearestOnTetrahedron(simplex as [SimplexPoint, SimplexPoint, SimplexPoint, SimplexPoint]);
}

function nearestOnSegment(first: SimplexPoint, second: SimplexPoint): { simplex: SimplexPoint[]; weights: number[] } {
  const along = new Vector3().subVectors(second.difference, first.difference);
  const lengthSquared = along.lengthSq();
  const fraction = lengthSquared > 0 ? -first.difference.dot(along) / lengthSquared : 0;
  if (fraction <= 0) return { simplex: [first], weights: [1] };
  if (fraction >= 1) return { simplex: [second], weights: [1] };
  return { simplex: [first, second], weights: [1 - fraction, fraction] };
}

function nearestOnTriangle(first: SimplexPoint, second: SimplexPoint, third: SimplexPoint): { simplex: SimplexPoint[]; weights: number[] } {
  const firstPoint = first.difference;
  const secondPoint = second.difference;
  const thirdPoint = third.difference;
  const firstToSecond = new Vector3().subVectors(secondPoint, firstPoint);
  const firstToThird = new Vector3().subVectors(thirdPoint, firstPoint);
  // the origin seen from each corner, measured along the two edges from the first
  const fromFirst = firstPoint.clone().negate();
  const firstAlongSecond = firstToSecond.dot(fromFirst);
  const firstAlongThird = firstToThird.dot(fromFirst);
  if (firstAlongSecond <= 0 && firstAlongThird <= 0) return { simplex: [first], weights: [1] };
  const fromSecond = secondPoint.clone().negate();
  const secondAlongSecond = firstToSecond.dot(fromSecond);
  const secondAlongThird = firstToThird.dot(fromSecond);
  if (secondAlongSecond >= 0 && secondAlongThird <= secondAlongSecond) return { simplex: [second], weights: [1] };
  const regionFirstSecond = firstAlongSecond * secondAlongThird - secondAlongSecond * firstAlongThird;
  if (regionFirstSecond <= 0 && firstAlongSecond >= 0 && secondAlongSecond <= 0) {
    const fraction = firstAlongSecond / (firstAlongSecond - secondAlongSecond);
    return { simplex: [first, second], weights: [1 - fraction, fraction] };
  }
  const fromThird = thirdPoint.clone().negate();
  const thirdAlongSecond = firstToSecond.dot(fromThird);
  const thirdAlongThird = firstToThird.dot(fromThird);
  if (thirdAlongThird >= 0 && thirdAlongSecond <= thirdAlongThird) return { simplex: [third], weights: [1] };
  const regionFirstThird = thirdAlongSecond * firstAlongThird - firstAlongSecond * thirdAlongThird;
  if (regionFirstThird <= 0 && firstAlongThird >= 0 && thirdAlongThird <= 0) {
    const fraction = firstAlongThird / (firstAlongThird - thirdAlongThird);
    return { simplex: [first, third], weights: [1 - fraction, fraction] };
  }
  const regionSecondThird = secondAlongSecond * thirdAlongThird - thirdAlongSecond * secondAlongThird;
  if (regionSecondThird <= 0 && secondAlongThird - secondAlongSecond >= 0 && thirdAlongSecond - thirdAlongThird >= 0) {
    const fraction = (secondAlongThird - secondAlongSecond) / (secondAlongThird - secondAlongSecond + (thirdAlongSecond - thirdAlongThird));
    return { simplex: [second, third], weights: [1 - fraction, fraction] };
  }
  const total = regionSecondThird + regionFirstThird + regionFirstSecond;
  if (total <= 0) return nearestOnSegment(first, second);
  return { simplex: [first, second, third], weights: [regionSecondThird / total, regionFirstThird / total, regionFirstSecond / total] };
}

function nearestOnTetrahedron(simplex: [SimplexPoint, SimplexPoint, SimplexPoint, SimplexPoint]): { simplex: SimplexPoint[]; weights: number[] } {
  let best: { simplex: SimplexPoint[]; weights: number[] } | undefined;
  let bestDistance = Infinity;
  const faces = [
    [0, 1, 2, 3],
    [0, 2, 3, 1],
    [0, 3, 1, 2],
    [1, 3, 2, 0],
  ] as const;
  for (const [first, second, third, opposite] of faces) {
    if (!originOutsideFace(simplex[first].difference, simplex[second].difference, simplex[third].difference, simplex[opposite].difference)) continue;
    const candidate = nearestOnTriangle(simplex[first], simplex[second], simplex[third]);
    const point = new Vector3();
    candidate.simplex.forEach((corner, index) => point.addScaledVector(corner.difference, candidate.weights[index]!));
    const distance = point.lengthSq();
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best ?? { simplex, weights: [0.25, 0.25, 0.25, 0.25] };
}

/** Whether the origin and `opposite` are on different sides of the plane through the face. */
function originOutsideFace(first: Vector3, second: Vector3, third: Vector3, opposite: Vector3): boolean {
  const normal = new Vector3().subVectors(second, first).cross(new Vector3().subVectors(third, first));
  const originSide = -normal.dot(first);
  const oppositeSide = normal.dot(new Vector3().subVectors(opposite, first));
  // a flat tetrahedron gives no answer; treat its faces as all outside so the nearest is found
  if (Math.abs(oppositeSide) < 1e-18) return true;
  return originSide * oppositeSide < 0;
}
