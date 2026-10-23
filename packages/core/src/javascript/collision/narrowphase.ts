import { MathUtils, Matrix3, Vector3 } from 'three';
import type { BoxCollider } from '../../colliders/BoxCollider.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import type { PlaneCollider } from '../../colliders/PlaneCollider.js';
import type { SphereCollider } from '../../colliders/SphereCollider.js';
import { FACE_PATCH_POINTS, reduceManifold } from './manifoldReduction.js';

/**
 * Where two colliders touch, or nearly do. `normal` is a unit vector from B toward A (the way A
 * must move to separate), `pointA` and `pointB` are the closest (or deepest) points of each, and
 * `depth` is how far they overlap along the normal, (pointB - pointA) · normal: negative for a
 * gap, which a contact within the margin can have.
 */
export interface ContactPoint {
  readonly pointA: Vector3;
  readonly pointB: Vector3;
  readonly normal: Vector3;
  depth: number;
}

/**
 * Adds the contacts between two colliders to `contacts`, including points still up to `margin`
 * apart: the bodies may close that gap during the step.
 */
export type CollisionTest<ColliderA extends Collider = Collider, ColliderB extends Collider = Collider> = (
  colliderA: ColliderA,
  poseA: ColliderPose,
  colliderB: ColliderB,
  poseB: ColliderPose,
  contacts: ContactPoint[],
  margin: number,
) => void;

/** The tests by the first shape's name, then the second's: looked up for every pair of colliders, without making a key string for each. */
const collisionTests = new Map<string, Map<string, CollisionTest>>();

/**
 * Teaches the engine how two shapes collide. Register each pair once; the reverse order is
 * handled for you.
 */
export function registerCollisionTest<ColliderA extends Collider, ColliderB extends Collider>(
  shapeA: string,
  shapeB: string,
  test: CollisionTest<ColliderA, ColliderB>,
): void {
  let byOther = collisionTests.get(shapeA);
  if (!byOther) collisionTests.set(shapeA, (byOther = new Map()));
  byOther.set(shapeB, test as CollisionTest);
}

/**
 * Every contact between two colliders at the given poses, counting points up to `margin` apart.
 * None if they don't touch or no test is registered for the pair of shapes.
 */
export function collide(colliderA: Collider, poseA: ColliderPose, colliderB: Collider, poseB: ColliderPose, contacts: ContactPoint[], margin = 0): void {
  const forward = collisionTests.get(colliderA.shape)?.get(colliderB.shape);
  if (forward) {
    forward(colliderA, poseA, colliderB, poseB, contacts, margin);
    return;
  }
  const reverse = collisionTests.get(colliderB.shape)?.get(colliderA.shape);
  if (!reverse) return;
  const firstNew = contacts.length;
  reverse(colliderB, poseB, colliderA, poseA, contacts, margin);
  for (let index = firstNew; index < contacts.length; index++) {
    const contact = contacts[index]!;
    contacts[index] = { pointA: contact.pointB, pointB: contact.pointA, normal: contact.normal.negate(), depth: contact.depth };
  }
}

function addContact(contacts: ContactPoint[], pointA: Vector3, pointB: Vector3, normal: Vector3, depth: number): void {
  contacts.push({ pointA: pointA.clone(), pointB: pointB.clone(), normal: normal.clone(), depth });
}

const difference = new Vector3();
const normalScratch = new Vector3();
const pointAScratch = new Vector3();
const pointBScratch = new Vector3();
const localCenter = new Vector3();
const clampedCenter = new Vector3();
const inverseRotation = new Matrix3();
const cornerScratch = new Vector3();

export function sphereSphere(sphereA: SphereCollider, poseA: ColliderPose, sphereB: SphereCollider, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  difference.subVectors(poseA.position, poseB.position);
  const distance = difference.length();
  const depth = sphereA.radius + sphereB.radius - distance;
  if (depth <= -margin) return;
  if (distance > 1e-12) normalScratch.copy(difference).divideScalar(distance);
  else normalScratch.set(0, 1, 0);
  pointAScratch.copy(poseA.position).addScaledVector(normalScratch, -sphereA.radius);
  pointBScratch.copy(poseB.position).addScaledVector(normalScratch, sphereB.radius);
  addContact(contacts, pointAScratch, pointBScratch, normalScratch, depth);
}

export function spherePlane(sphere: SphereCollider, spherePose: ColliderPose, plane: PlaneCollider, planePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  plane.normal(planePose, normalScratch);
  const height = difference.subVectors(spherePose.position, planePose.position).dot(normalScratch);
  const depth = sphere.radius - height;
  if (depth <= -margin) return;
  pointAScratch.copy(spherePose.position).addScaledVector(normalScratch, -sphere.radius);
  pointBScratch.copy(spherePose.position).addScaledVector(normalScratch, -height);
  addContact(contacts, pointAScratch, pointBScratch, normalScratch, depth);
}

function boxPlane(box: BoxCollider, boxPose: ColliderPose, plane: PlaneCollider, planePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  plane.normal(planePose, normalScratch);
  const { x: halfX, y: halfY, z: halfZ } = box.halfExtents;
  for (const signX of [-1, 1]) {
    for (const signY of [-1, 1]) {
      for (const signZ of [-1, 1]) {
        cornerScratch.set(signX * halfX, signY * halfY, signZ * halfZ).applyMatrix3(boxPose.rotation).add(boxPose.position);
        const height = difference.subVectors(cornerScratch, planePose.position).dot(normalScratch);
        if (height >= margin) continue;
        pointBScratch.copy(cornerScratch).addScaledVector(normalScratch, -height);
        addContact(contacts, cornerScratch, pointBScratch, normalScratch, -height);
      }
    }
  }
}

export function sphereBox(sphere: SphereCollider, spherePose: ColliderPose, box: BoxCollider, boxPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  inverseRotation.copy(boxPose.rotation).transpose();
  localCenter.subVectors(spherePose.position, boxPose.position).applyMatrix3(inverseRotation);
  const halfExtents = box.halfExtents;
  clampedCenter.set(
    MathUtils.clamp(localCenter.x, -halfExtents.x, halfExtents.x),
    MathUtils.clamp(localCenter.y, -halfExtents.y, halfExtents.y),
    MathUtils.clamp(localCenter.z, -halfExtents.z, halfExtents.z),
  );
  const outside = difference.subVectors(localCenter, clampedCenter);
  const distance = outside.length();

  if (distance > 1e-12) {
    // centre outside the box: the nearest point on its surface
    if (distance >= sphere.radius + margin) return;
    normalScratch.copy(outside).divideScalar(distance).applyMatrix3(boxPose.rotation);
    pointBScratch.copy(clampedCenter).applyMatrix3(boxPose.rotation).add(boxPose.position);
    pointAScratch.copy(spherePose.position).addScaledVector(normalScratch, -sphere.radius);
    addContact(contacts, pointAScratch, pointBScratch, normalScratch, sphere.radius - distance);
    return;
  }

  // centre inside the box: push it out through the nearest face
  const distancesToFaces = [halfExtents.x - Math.abs(localCenter.x), halfExtents.y - Math.abs(localCenter.y), halfExtents.z - Math.abs(localCenter.z)];
  const axis = distancesToFaces.indexOf(Math.min(...distancesToFaces));
  const sign = localCenter.getComponent(axis) >= 0 ? 1 : -1;
  normalScratch.set(0, 0, 0).setComponent(axis, sign).applyMatrix3(boxPose.rotation);
  clampedCenter.copy(localCenter).setComponent(axis, sign * halfExtents.getComponent(axis));
  pointBScratch.copy(clampedCenter).applyMatrix3(boxPose.rotation).add(boxPose.position);
  pointAScratch.copy(spherePose.position).addScaledVector(normalScratch, -sphere.radius);
  addContact(contacts, pointAScratch, pointBScratch, normalScratch, sphere.radius + distancesToFaces[axis]!);
}

/** A box's centre, axes (world space) and half extents, as the box-box test needs them. */
interface OrientedBox {
  center: Vector3;
  axes: [Vector3, Vector3, Vector3];
  halfExtents: [number, number, number];
}

// The box-box test's working space, reused from one pair to the next: a pile of boxes is tens of
// thousands of pairs a second, and only their contacts need be new.
const orientedBoxA: OrientedBox = { center: new Vector3(), axes: [new Vector3(), new Vector3(), new Vector3()], halfExtents: [0, 0, 0] };
const orientedBoxB: OrientedBox = { center: new Vector3(), axes: [new Vector3(), new Vector3(), new Vector3()], halfExtents: [0, 0, 0] };
const centerOffset = new Vector3();
/** How each of B's axes lines up with each of A's, row by row: Aᵢ · Bⱼ at 3i + j. */
const alignment = new Float64Array(9);
/** B's centre from A's, along A's axes. */
const offsetInA = new Float64Array(3);
const bestEdgeAxis = new Vector3();
const toIncident = new Vector3();
const referenceNormal = new Vector3();
const negatedSideNormal = new Vector3();
const referenceFaceCenter = new Vector3();
const incidentNormal = new Vector3();
const incidentFaceCenter = new Vector3();
const sideFirst = new Vector3();
const sideSecond = new Vector3();
const normalFromBToA = new Vector3();
const onReferenceFace = new Vector3();
const edgeMiddleA = new Vector3();
const edgeMiddleB = new Vector3();
/** A face clipped by four planes has at most eight corners: two pools of them, clipped from one into the other. */
const clipPool = Array.from({ length: 8 }, () => new Vector3());
const clipOtherPool = Array.from({ length: 8 }, () => new Vector3());

function orientedBox(box: BoxCollider, pose: ColliderPose, target: OrientedBox): OrientedBox {
  const elements = pose.rotation.elements;
  target.center.copy(pose.position);
  target.axes[0].set(elements[0], elements[1], elements[2]);
  target.axes[1].set(elements[3], elements[4], elements[5]);
  target.axes[2].set(elements[6], elements[7], elements[8]);
  target.halfExtents[0] = box.halfExtents.x;
  target.halfExtents[1] = box.halfExtents.y;
  target.halfExtents[2] = box.halfExtents.z;
  return target;
}

/** How far a box reaches along a unit axis from its centre. */
function projectedRadius(box: OrientedBox, axis: Vector3): number {
  return box.halfExtents[0] * Math.abs(box.axes[0].dot(axis)) + box.halfExtents[1] * Math.abs(box.axes[1].dot(axis)) + box.halfExtents[2] * Math.abs(box.axes[2].dot(axis));
}

/** How far apart two boxes are along a unit axis, their centres `offset` apart: negative when they overlap along it. */
function separationAlong(boxA: OrientedBox, boxB: OrientedBox, offset: Vector3, axis: Vector3): number {
  return Math.abs(offset.dot(axis)) - projectedRadius(boxA, axis) - projectedRadius(boxB, axis);
}

/**
 * Separating-axis test over the 15 candidate axes; then contacts from clipping the incident face
 * against the reference face, or from the closest points of two edges.
 */
function boxBox(colliderA: BoxCollider, poseA: ColliderPose, colliderB: BoxCollider, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const boxA = orientedBox(colliderA, poseA, orientedBoxA);
  const boxB = orientedBox(colliderB, poseB, orientedBoxB);
  centerOffset.subVectors(boxB.center, boxA.center);

  // A's faces, then B's
  let faceIsA = true;
  let faceIndex = -1;
  let faceSeparation = -Infinity;
  for (let side = 0; side < 2; side++) {
    const box = side === 0 ? boxA : boxB;
    for (let index = 0; index < 3; index++) {
      const separation = separationAlong(boxA, boxB, centerOffset, box.axes[index]!);
      if (separation > margin) return;
      if (faceIndex === -1 || separation > faceSeparation) {
        faceIsA = side === 0;
        faceIndex = index;
        faceSeparation = separation;
      }
    }
  }
  const sizeTolerance = 0.01 * Math.min(boxA.halfExtents[0], boxA.halfExtents[1], boxA.halfExtents[2], boxB.halfExtents[0], boxB.halfExtents[1], boxB.halfExtents[2]);
  let edgeIndexA = -1;
  let edgeIndexB = -1;
  let edgeSeparation = -Infinity;
  // The edge axes, Aᵢ × Bⱼ, worked out in A's frame from how each axis of B lines up with each of
  // A's (Ericson, Real-Time Collision Detection, 4.4.1) rather than each made and measured in the
  // world: a ninth of the dot products.
  for (let indexA = 0; indexA < 3; indexA++) {
    offsetInA[indexA] = centerOffset.dot(boxA.axes[indexA]!);
    for (let indexB = 0; indexB < 3; indexB++) alignment[3 * indexA + indexB] = boxA.axes[indexA]!.dot(boxB.axes[indexB]!);
  }
  for (let indexA = 0; indexA < 3; indexA++) {
    // the axis has no part along Aᵢ: its parts along A's other two axes are these
    const nextA = (indexA + 1) % 3;
    const lastA = (indexA + 2) % 3;
    for (let indexB = 0; indexB < 3; indexB++) {
      const nextB = (indexB + 1) % 3;
      const lastB = (indexB + 2) % 3;
      const alongNext = -alignment[3 * lastA + indexB]!;
      const alongLast = alignment[3 * nextA + indexB]!;
      const length = Math.sqrt(alongNext * alongNext + alongLast * alongLast);
      if (length < 1e-6) continue;
      const reachA = boxA.halfExtents[nextA]! * Math.abs(alongNext) + boxA.halfExtents[lastA]! * Math.abs(alongLast);
      const reachB = boxB.halfExtents[nextB]! * Math.abs(alignment[3 * indexA + lastB]!) + boxB.halfExtents[lastB]! * Math.abs(alignment[3 * indexA + nextB]!);
      const separation = (Math.abs(offsetInA[nextA]! * alongNext + offsetInA[lastA]! * alongLast) - reachA - reachB) / length;
      if (separation > margin) return;
      if (edgeIndexA === -1 || separation > edgeSeparation) {
        edgeIndexA = indexA;
        edgeIndexB = indexB;
        edgeSeparation = separation;
      }
    }
  }
  if (edgeIndexA !== -1) bestEdgeAxis.crossVectors(boxA.axes[edgeIndexA]!, boxB.axes[edgeIndexB]!).normalize();

  // Prefer faces: they give a whole patch of contacts, which is what keeps stacks steady.
  if (edgeIndexA !== -1 && edgeSeparation > faceSeparation + sizeTolerance) {
    edgeContact(boxA, boxB, edgeIndexA, edgeIndexB, bestEdgeAxis, edgeSeparation, contacts);
  } else if (faceIsA) {
    faceContacts(boxA, boxB, faceIndex, true, contacts, margin);
  } else {
    faceContacts(boxB, boxA, faceIndex, false, contacts, margin);
  }
}

/** Contacts where a face of `reference` touches `incident`; `referenceIsA` says which collider each box is. */
function faceContacts(reference: OrientedBox, incident: OrientedBox, axisIndex: number, referenceIsA: boolean, contacts: ContactPoint[], margin: number): void {
  toIncident.subVectors(incident.center, reference.center);
  referenceNormal.copy(reference.axes[axisIndex]!);
  if (referenceNormal.dot(toIncident) < 0) referenceNormal.negate();
  referenceFaceCenter.copy(reference.center).addScaledVector(referenceNormal, reference.halfExtents[axisIndex]!);

  // The incident face is the one facing most against the reference normal.
  let incidentAxis = 0;
  for (let index = 1; index < 3; index++) {
    if (Math.abs(incident.axes[index]!.dot(referenceNormal)) > Math.abs(incident.axes[incidentAxis]!.dot(referenceNormal))) incidentAxis = index;
  }
  incidentNormal.copy(incident.axes[incidentAxis]!);
  if (incidentNormal.dot(referenceNormal) > 0) incidentNormal.negate();
  incidentFaceCenter.copy(incident.center).addScaledVector(incidentNormal, incident.halfExtents[incidentAxis]!);
  // the incident face's other two axes, in order
  const sideAxisFirst = incidentAxis === 0 ? 1 : 0;
  const sideAxisSecond = incidentAxis === 2 ? 1 : 2;
  sideFirst.copy(incident.axes[sideAxisFirst]!).multiplyScalar(incident.halfExtents[sideAxisFirst]!);
  sideSecond.copy(incident.axes[sideAxisSecond]!).multiplyScalar(incident.halfExtents[sideAxisSecond]!);
  let polygon = clipPool;
  let other = clipOtherPool;
  polygon[0]!.copy(incidentFaceCenter).add(sideFirst).add(sideSecond);
  polygon[1]!.copy(incidentFaceCenter).add(sideFirst).sub(sideSecond);
  polygon[2]!.copy(incidentFaceCenter).sub(sideFirst).sub(sideSecond);
  polygon[3]!.copy(incidentFaceCenter).sub(sideFirst).add(sideSecond);
  let count = 4;

  // Clip it to the four side planes of the reference face.
  for (let sideAxis = 0; sideAxis < 3; sideAxis++) {
    if (sideAxis === axisIndex) continue;
    const sideNormal = reference.axes[sideAxis]!;
    const centerAlongSide = reference.center.dot(sideNormal);
    const halfWidth = reference.halfExtents[sideAxis]!;
    count = clipInto(polygon, count, sideNormal, centerAlongSide + halfWidth, other);
    [polygon, other] = [other, polygon];
    count = clipInto(polygon, count, negatedSideNormal.copy(sideNormal).negate(), -centerAlongSide + halfWidth, other);
    [polygon, other] = [other, polygon];
  }

  normalFromBToA.copy(referenceNormal);
  if (referenceIsA) normalFromBToA.negate();
  const firstNew = contacts.length;
  for (let index = 0; index < count; index++) {
    const point = polygon[index]!;
    const separation = difference.subVectors(point, referenceFaceCenter).dot(referenceNormal);
    if (separation > margin) continue;
    onReferenceFace.copy(point).addScaledVector(referenceNormal, -separation);
    if (referenceIsA) addContact(contacts, onReferenceFace, point, normalFromBToA, -separation);
    else addContact(contacts, point, onReferenceFace, normalFromBToA, -separation);
  }
  // a turned face clips to as many as eight corners: the four that span them do as well
  if (contacts.length - firstNew > FACE_PATCH_POINTS) {
    const patch = contacts.splice(firstNew);
    reduceManifold(patch, FACE_PATCH_POINTS);
    for (const contact of patch) contacts.push(contact);
  }
}

/**
 * Sutherland–Hodgman as `clipPolygon`, from the `count` corners of `polygon` into the vectors of
 * `target`, which it overwrites: the number of corners kept.
 */
function clipInto(polygon: Vector3[], count: number, normal: Vector3, offset: number, target: Vector3[]): number {
  let kept = 0;
  for (let index = 0; index < count; index++) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % count]!;
    const currentDistance = current.dot(normal) - offset;
    const nextDistance = next.dot(normal) - offset;
    if (currentDistance <= 0) target[kept++]!.copy(current);
    if (currentDistance * nextDistance < 0) target[kept++]!.copy(current).lerp(next, currentDistance / (currentDistance - nextDistance));
  }
  return kept;
}

/** Sutherland–Hodgman: keeps the part of `polygon` where point · normal <= offset. */
export function clipPolygon(polygon: Vector3[], normal: Vector3, offset: number): Vector3[] {
  const clipped: Vector3[] = [];
  polygon.forEach((current, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    const currentDistance = current.dot(normal) - offset;
    const nextDistance = next.dot(normal) - offset;
    if (currentDistance <= 0) clipped.push(current);
    if (currentDistance * nextDistance < 0) {
      clipped.push(current.clone().lerp(next, currentDistance / (currentDistance - nextDistance)));
    }
  });
  return clipped;
}

function edgeContact(boxA: OrientedBox, boxB: OrientedBox, indexA: number, indexB: number, edgeAxisFound: Vector3, separation: number, contacts: ContactPoint[]): void {
  const axis = edgeAxisFound;
  if (axis.dot(centerOffset) < 0) axis.negate(); // from A toward B
  // The edge of each box that reaches furthest toward the other.
  edgeMiddleA.copy(boxA.center);
  edgeMiddleB.copy(boxB.center);
  for (let index = 0; index < 3; index++) {
    if (index !== indexA) edgeMiddleA.addScaledVector(boxA.axes[index]!, Math.sign(boxA.axes[index]!.dot(axis)) * boxA.halfExtents[index]!);
    if (index !== indexB) edgeMiddleB.addScaledVector(boxB.axes[index]!, -Math.sign(boxB.axes[index]!.dot(axis)) * boxB.halfExtents[index]!);
  }
  const [pointA, pointB] = closestPointsOnSegments(edgeMiddleA, boxA.axes[indexA]!, boxA.halfExtents[indexA]!, edgeMiddleB, boxB.axes[indexB]!, boxB.halfExtents[indexB]!);
  addContact(contacts, pointA, pointB, axis.negate(), -separation);
}

/** Closest points of two segments, each given by its middle, unit direction and half length. */
export function closestPointsOnSegments(
  middleA: Vector3,
  directionA: Vector3,
  halfLengthA: number,
  middleB: Vector3,
  directionB: Vector3,
  halfLengthB: number,
): [Vector3, Vector3] {
  const between = new Vector3().subVectors(middleA, middleB);
  const alignment = directionA.dot(directionB);
  const alongA = directionA.dot(between);
  const alongB = directionB.dot(between);
  const denominator = 1 - alignment * alignment;
  let offsetA = denominator > 1e-12 ? (alignment * alongB - alongA) / denominator : 0;
  offsetA = MathUtils.clamp(offsetA, -halfLengthA, halfLengthA);
  let offsetB = MathUtils.clamp(alignment * offsetA + alongB, -halfLengthB, halfLengthB);
  offsetA = MathUtils.clamp(alignment * offsetB - alongA, -halfLengthA, halfLengthA);
  offsetB = MathUtils.clamp(alignment * offsetA + alongB, -halfLengthB, halfLengthB);
  return [middleA.clone().addScaledVector(directionA, offsetA), middleB.clone().addScaledVector(directionB, offsetB)];
}

registerCollisionTest('sphere', 'sphere', sphereSphere);
registerCollisionTest('sphere', 'plane', spherePlane);
registerCollisionTest('box', 'plane', boxPlane);
registerCollisionTest('sphere', 'box', sphereBox);
registerCollisionTest('box', 'box', boxBox);
