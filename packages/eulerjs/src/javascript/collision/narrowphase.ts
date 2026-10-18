import { MathUtils, Matrix3, Vector3 } from 'three';
import type { BoxCollider } from '../../colliders/BoxCollider.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import type { PlaneCollider } from '../../colliders/PlaneCollider.js';
import type { SphereCollider } from '../../colliders/SphereCollider.js';

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

const collisionTests = new Map<string, CollisionTest>();

/**
 * Teaches the engine how two shapes collide. Register each pair once; the reverse order is
 * handled for you.
 */
export function registerCollisionTest<ColliderA extends Collider, ColliderB extends Collider>(
  shapeA: string,
  shapeB: string,
  test: CollisionTest<ColliderA, ColliderB>,
): void {
  collisionTests.set(`${shapeA}|${shapeB}`, test as CollisionTest);
}

/**
 * Every contact between two colliders at the given poses, counting points up to `margin` apart.
 * None if they don't touch or no test is registered for the pair of shapes.
 */
export function collide(colliderA: Collider, poseA: ColliderPose, colliderB: Collider, poseB: ColliderPose, contacts: ContactPoint[], margin = 0): void {
  const forward = collisionTests.get(`${colliderA.shape}|${colliderB.shape}`);
  if (forward) {
    forward(colliderA, poseA, colliderB, poseB, contacts, margin);
    return;
  }
  const reverse = collisionTests.get(`${colliderB.shape}|${colliderA.shape}`);
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

function orientedBox(box: BoxCollider, pose: ColliderPose): OrientedBox {
  const elements = pose.rotation.elements;
  return {
    center: pose.position.clone(),
    axes: [
      new Vector3(elements[0], elements[1], elements[2]),
      new Vector3(elements[3], elements[4], elements[5]),
      new Vector3(elements[6], elements[7], elements[8]),
    ],
    halfExtents: [box.halfExtents.x, box.halfExtents.y, box.halfExtents.z],
  };
}

/** How far a box reaches along a unit axis from its centre. */
function projectedRadius(box: OrientedBox, axis: Vector3): number {
  return box.halfExtents[0] * Math.abs(box.axes[0].dot(axis)) + box.halfExtents[1] * Math.abs(box.axes[1].dot(axis)) + box.halfExtents[2] * Math.abs(box.axes[2].dot(axis));
}

type SeparatingAxis = { kind: 'faceA' | 'faceB'; index: number; separation: number } | { kind: 'edge'; indexA: number; indexB: number; axis: Vector3; separation: number };

/**
 * Separating-axis test over the 15 candidate axes; then contacts from clipping the incident face
 * against the reference face, or from the closest points of two edges.
 */
function boxBox(colliderA: BoxCollider, poseA: ColliderPose, colliderB: BoxCollider, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const boxA = orientedBox(colliderA, poseA);
  const boxB = orientedBox(colliderB, poseB);
  const centerOffset = new Vector3().subVectors(boxB.center, boxA.center);
  const separationAlong = (axis: Vector3) => Math.abs(centerOffset.dot(axis)) - projectedRadius(boxA, axis) - projectedRadius(boxB, axis);

  let bestFace: SeparatingAxis | undefined;
  for (const [kind, box] of [['faceA', boxA], ['faceB', boxB]] as const) {
    for (let index = 0; index < 3; index++) {
      const separation = separationAlong(box.axes[index]!);
      if (separation > margin) return;
      if (!bestFace || separation > bestFace.separation) bestFace = { kind, index, separation };
    }
  }
  if (!bestFace) return;
  const sizeTolerance = 0.01 * Math.min(...boxA.halfExtents, ...boxB.halfExtents);
  let bestEdge: SeparatingAxis | undefined;
  for (let indexA = 0; indexA < 3; indexA++) {
    for (let indexB = 0; indexB < 3; indexB++) {
      const axis = new Vector3().crossVectors(boxA.axes[indexA]!, boxB.axes[indexB]!);
      const length = axis.length();
      if (length < 1e-6) continue;
      axis.divideScalar(length);
      const separation = separationAlong(axis);
      if (separation > margin) return;
      if (!bestEdge || separation > bestEdge.separation) bestEdge = { kind: 'edge', indexA, indexB, axis, separation };
    }
  }

  // Prefer faces: they give a whole patch of contacts, which is what keeps stacks steady.
  if (bestEdge && bestEdge.kind === 'edge' && bestEdge.separation > bestFace.separation + sizeTolerance) {
    edgeContact(boxA, boxB, bestEdge, centerOffset, contacts);
  } else if (bestFace.kind === 'faceA') {
    faceContacts(boxA, boxB, bestFace.index, true, contacts, margin);
  } else if (bestFace.kind === 'faceB') {
    faceContacts(boxB, boxA, bestFace.index, false, contacts, margin);
  }
}

/** Contacts where a face of `reference` touches `incident`; `referenceIsA` says which collider each box is. */
function faceContacts(reference: OrientedBox, incident: OrientedBox, axisIndex: number, referenceIsA: boolean, contacts: ContactPoint[], margin: number): void {
  const toIncident = new Vector3().subVectors(incident.center, reference.center);
  const referenceNormal = reference.axes[axisIndex]!.clone();
  if (referenceNormal.dot(toIncident) < 0) referenceNormal.negate();
  const referenceFaceCenter = reference.center.clone().addScaledVector(referenceNormal, reference.halfExtents[axisIndex]!);

  // The incident face is the one facing most against the reference normal.
  let incidentAxis = 0;
  for (let index = 1; index < 3; index++) {
    if (Math.abs(incident.axes[index]!.dot(referenceNormal)) > Math.abs(incident.axes[incidentAxis]!.dot(referenceNormal))) incidentAxis = index;
  }
  const incidentNormal = incident.axes[incidentAxis]!.clone();
  if (incidentNormal.dot(referenceNormal) > 0) incidentNormal.negate();
  const incidentFaceCenter = incident.center.clone().addScaledVector(incidentNormal, incident.halfExtents[incidentAxis]!);
  const [sideAxisFirst, sideAxisSecond] = [0, 1, 2].filter((index) => index !== incidentAxis) as [number, number];
  const sideFirst = incident.axes[sideAxisFirst]!.clone().multiplyScalar(incident.halfExtents[sideAxisFirst]!);
  const sideSecond = incident.axes[sideAxisSecond]!.clone().multiplyScalar(incident.halfExtents[sideAxisSecond]!);
  let polygon = [
    incidentFaceCenter.clone().add(sideFirst).add(sideSecond),
    incidentFaceCenter.clone().add(sideFirst).sub(sideSecond),
    incidentFaceCenter.clone().sub(sideFirst).sub(sideSecond),
    incidentFaceCenter.clone().sub(sideFirst).add(sideSecond),
  ];

  // Clip it to the four side planes of the reference face.
  for (const sideAxis of [0, 1, 2].filter((index) => index !== axisIndex)) {
    const sideNormal = reference.axes[sideAxis]!;
    const centerAlongSide = reference.center.dot(sideNormal);
    const halfWidth = reference.halfExtents[sideAxis]!;
    polygon = clipPolygon(polygon, sideNormal, centerAlongSide + halfWidth);
    polygon = clipPolygon(polygon, sideNormal.clone().negate(), -centerAlongSide + halfWidth);
  }

  const normalFromBToA = referenceIsA ? referenceNormal.clone().negate() : referenceNormal;
  for (const point of polygon) {
    const separation = difference.subVectors(point, referenceFaceCenter).dot(referenceNormal);
    if (separation > margin) continue;
    const onReferenceFace = point.clone().addScaledVector(referenceNormal, -separation);
    if (referenceIsA) addContact(contacts, onReferenceFace, point, normalFromBToA, -separation);
    else addContact(contacts, point, onReferenceFace, normalFromBToA, -separation);
  }
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

function edgeContact(boxA: OrientedBox, boxB: OrientedBox, edge: Extract<SeparatingAxis, { kind: 'edge' }>, centerOffset: Vector3, contacts: ContactPoint[]): void {
  const axis = edge.axis.clone();
  if (axis.dot(centerOffset) < 0) axis.negate(); // from A toward B
  // The edge of each box that reaches furthest toward the other.
  const edgeMiddleA = boxA.center.clone();
  const edgeMiddleB = boxB.center.clone();
  for (let index = 0; index < 3; index++) {
    if (index !== edge.indexA) edgeMiddleA.addScaledVector(boxA.axes[index]!, Math.sign(boxA.axes[index]!.dot(axis)) * boxA.halfExtents[index]!);
    if (index !== edge.indexB) edgeMiddleB.addScaledVector(boxB.axes[index]!, -Math.sign(boxB.axes[index]!.dot(axis)) * boxB.halfExtents[index]!);
  }
  const [pointA, pointB] = closestPointsOnSegments(
    edgeMiddleA,
    boxA.axes[edge.indexA]!,
    boxA.halfExtents[edge.indexA]!,
    edgeMiddleB,
    boxB.axes[edge.indexB]!,
    boxB.halfExtents[edge.indexB]!,
  );
  addContact(contacts, pointA, pointB, axis.negate(), -edge.separation);
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
