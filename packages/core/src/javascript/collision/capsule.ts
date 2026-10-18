import { MathUtils, Matrix3, Quaternion, Vector3 } from 'three';
import type { BoxCollider } from '../../colliders/BoxCollider.js';
import type { CapsuleCollider } from '../../colliders/CapsuleCollider.js';
import type { ColliderPose } from '../../colliders/Collider.js';
import type { ConvexCollider } from '../../colliders/ConvexCollider.js';
import type { PlaneCollider } from '../../colliders/PlaneCollider.js';
import { SphereCollider } from '../../colliders/SphereCollider.js';
import { place, sphereConvex } from './convex.js';
import { closestPointsOnSegments, registerCollisionTest, sphereBox, spherePlane, sphereSphere } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';

/**
 * Capsules collide as the spheres of their radius that sit on their middle segment: a capsule
 * touches something wherever one of those spheres does. Each test picks the few spheres that
 * matter, both ends, so that a capsule lying on something rests on two points, and the point
 * of the segment nearest the other shape, for a capsule across an edge or another capsule.
 */

/** Golden-section search steps for the point of a segment nearest a box or hull: plenty for millimetres on a limb. */
const NEAREST_POINT_STEPS = 24;
/** An inner sphere is only worth testing if it is this much nearer the other shape than either end, in metres. */
const INNER_POINT_GAIN = 1e-4;
/** Segments closer to parallel than this (|cos|) rest along each other, touching at both ends of the shorter. */
const PARALLEL = 0.995;

const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;

/** A sphere standing in for part of a capsule; its radius and pose are set for each use. */
const standIn = new SphereCollider({ radius: 1 });
const standInPose: ColliderPose = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };
const otherStandIn = new SphereCollider({ radius: 1 });
const otherStandInPose: ColliderPose = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };

const start = new Vector3();
const end = new Vector3();
const otherStart = new Vector3();
const otherEnd = new Vector3();
const middle = new Vector3();
const otherMiddle = new Vector3();
const direction = new Vector3();
const otherDirection = new Vector3();
const alongSegment = new Vector3();
const candidate = new Vector3();
const localPoint = new Vector3();
const inverseRotation = new Matrix3();

/** The stand-in sphere of `capsule`'s radius, centred at `center`. */
function sphereOf(capsule: CapsuleCollider, center: Vector3): SphereCollider {
  standIn.radius = capsule.radius;
  standInPose.position.copy(center);
  return standIn;
}

function capsulePlane(capsule: CapsuleCollider, pose: ColliderPose, plane: PlaneCollider, planePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  // height above a plane changes evenly along the segment, so the nearest points are at its ends
  capsule.endsAt(pose, start, end);
  spherePlane(sphereOf(capsule, start), standInPose, plane, planePose, contacts, margin);
  if (capsule.length > 0) spherePlane(sphereOf(capsule, end), standInPose, plane, planePose, contacts, margin);
}

function capsuleSphere(capsule: CapsuleCollider, pose: ColliderPose, sphere: SphereCollider, spherePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  capsule.endsAt(pose, start, end);
  nearestOnSegment(start, end, spherePose.position, candidate);
  sphereSphere(sphereOf(capsule, candidate), standInPose, sphere, spherePose, contacts, margin);
}

function capsuleCapsule(capsuleA: CapsuleCollider, poseA: ColliderPose, capsuleB: CapsuleCollider, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  capsuleA.endsAt(poseA, start, end);
  capsuleB.endsAt(poseB, otherStart, otherEnd);
  segmentMiddleAndDirection(start, end, middle, direction);
  segmentMiddleAndDirection(otherStart, otherEnd, otherMiddle, otherDirection);
  otherStandIn.radius = capsuleB.radius;

  const [nearestOnA, nearestOnB] = closestPointsOnSegments(middle, direction, capsuleA.length / 2, otherMiddle, otherDirection, capsuleB.length / 2);
  const parallel = capsuleA.length > 0 && capsuleB.length > 0 && Math.abs(direction.dot(otherDirection)) > PARALLEL;
  if (parallel) {
    // lying along each other: hold them apart at both ends of the shorter, against the nearest point of the longer
    const aIsShorter = capsuleA.length <= capsuleB.length;
    let nearestEndGap = Infinity;
    for (const shortEnd of aIsShorter ? [start, end] : [otherStart, otherEnd]) {
      if (aIsShorter) {
        nearestOnSegment(otherStart, otherEnd, shortEnd, otherStandInPose.position);
        nearestEndGap = Math.min(nearestEndGap, shortEnd.distanceTo(otherStandInPose.position));
        sphereSphere(sphereOf(capsuleA, shortEnd), standInPose, otherStandIn, otherStandInPose, contacts, margin);
      } else {
        nearestOnSegment(start, end, shortEnd, candidate);
        nearestEndGap = Math.min(nearestEndGap, shortEnd.distanceTo(candidate));
        otherStandInPose.position.copy(shortEnd);
        sphereSphere(sphereOf(capsuleA, candidate), standInPose, otherStandIn, otherStandInPose, contacts, margin);
      }
    }
    // and where they cross, if they cross between the ends at a shallow angle
    if (nearestOnA.distanceTo(nearestOnB) > nearestEndGap - INNER_POINT_GAIN) return;
  }
  otherStandInPose.position.copy(nearestOnB);
  sphereSphere(sphereOf(capsuleA, nearestOnA), standInPose, otherStandIn, otherStandInPose, contacts, margin);
}

function capsuleBox(capsule: CapsuleCollider, pose: ColliderPose, box: BoxCollider, boxPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  inverseRotation.copy(boxPose.rotation).transpose();
  const distanceToBox = (point: Vector3) => signedDistanceToBox(point, box, boxPose);
  forEachNearSphere(capsule, pose, distanceToBox, (center) => sphereBox(sphereOf(capsule, center), standInPose, box, boxPose, contacts, margin));
}

function capsuleConvex(capsule: CapsuleCollider, pose: ColliderPose, convex: ConvexCollider, convexPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const placed = place(convex, convexPose);
  // how far outside the hull's furthest face plane: a lower bound on the distance that is exact inside, and convex
  const outsideFaces = (point: Vector3) => {
    let outermost = -Infinity;
    for (let index = 0; index < placed.normals.length; index++) outermost = Math.max(outermost, placed.normals[index]!.dot(point) - placed.offsets[index]!);
    return outermost;
  };
  forEachNearSphere(capsule, pose, outsideFaces, (center) => sphereConvex(sphereOf(capsule, center), standInPose, convex, convexPose, contacts, margin));
}

/**
 * Calls `test` with the centres of the spheres worth testing against a convex shape: both ends
 * of the segment, and the point between them nearest the shape if it is nearer than either.
 * `distance` must be convex along the segment, as any distance to a convex shape is.
 */
export function forEachNearSphere(capsule: CapsuleCollider, pose: ColliderPose, distance: (point: Vector3) => number, test: (center: Vector3) => void): void {
  capsule.endsAt(pose, start, end);
  if (capsule.length === 0) {
    test(start);
    return;
  }
  const startDistance = distance(start);
  const endDistance = distance(end);
  const pointAt = (fraction: number) => candidate.lerpVectors(start, end, fraction);
  let low = 0;
  let high = 1;
  for (let step = 0; step < NEAREST_POINT_STEPS; step++) {
    const lower = high - GOLDEN_RATIO * (high - low);
    const upper = low + GOLDEN_RATIO * (high - low);
    if (distance(pointAt(lower)) < distance(pointAt(upper))) high = upper;
    else low = lower;
  }
  const nearestFraction = (low + high) / 2;
  const innerDistance = distance(pointAt(nearestFraction));
  if (innerDistance < Math.min(startDistance, endDistance) - INNER_POINT_GAIN) test(alongSegment.copy(pointAt(nearestFraction)));
  test(start);
  test(end);
}

/** Distance from `point` to the box: positive outside, minus the depth inside. */
function signedDistanceToBox(point: Vector3, box: BoxCollider, boxPose: ColliderPose): number {
  localPoint.subVectors(point, boxPose.position).applyMatrix3(inverseRotation);
  const halfExtents = box.halfExtents;
  const outsideX = Math.abs(localPoint.x) - halfExtents.x;
  const outsideY = Math.abs(localPoint.y) - halfExtents.y;
  const outsideZ = Math.abs(localPoint.z) - halfExtents.z;
  const outside = Math.hypot(Math.max(outsideX, 0), Math.max(outsideY, 0), Math.max(outsideZ, 0));
  return outside > 0 ? outside : Math.max(outsideX, outsideY, outsideZ);
}

/**
 * Runs `test` on each stand-in sphere of `capsule` worth testing against a convex shape `distance`
 * measures (see `forEachNearSphere`): for collision tests of other modules, such as triangles.
 */
export function forEachStandInSphere(capsule: CapsuleCollider, pose: ColliderPose, distance: (point: Vector3) => number, test: (sphere: SphereCollider, spherePose: ColliderPose) => void): void {
  forEachNearSphere(capsule, pose, distance, (center) => test(sphereOf(capsule, center), standInPose));
}

function nearestOnSegment(segmentStart: Vector3, segmentEnd: Vector3, point: Vector3, target: Vector3): Vector3 {
  alongSegment.subVectors(segmentEnd, segmentStart);
  const lengthSquared = alongSegment.lengthSq();
  const fraction = lengthSquared > 0 ? MathUtils.clamp(alongSegment.dot(target.subVectors(point, segmentStart)) / lengthSquared, 0, 1) : 0;
  return target.copy(segmentStart).addScaledVector(alongSegment, fraction);
}

function segmentMiddleAndDirection(segmentStart: Vector3, segmentEnd: Vector3, middleTarget: Vector3, directionTarget: Vector3): void {
  middleTarget.addVectors(segmentStart, segmentEnd).multiplyScalar(0.5);
  directionTarget.subVectors(segmentEnd, segmentStart);
  const length = directionTarget.length();
  if (length > 0) directionTarget.divideScalar(length);
  else directionTarget.set(0, 1, 0);
}

export function registerCapsuleCollisionTests(): void {
  registerCollisionTest('capsule', 'plane', capsulePlane);
  registerCollisionTest('capsule', 'sphere', capsuleSphere);
  registerCollisionTest('capsule', 'capsule', capsuleCapsule);
  registerCollisionTest('capsule', 'box', capsuleBox);
  registerCollisionTest('capsule', 'convex', capsuleConvex);
}
