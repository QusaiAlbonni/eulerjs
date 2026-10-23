import { Vector3 } from 'three';
import { CapsuleCollider } from '../../colliders/CapsuleCollider.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import { ConeCollider } from '../../colliders/ConeCollider.js';
import { axisAt, CylinderCollider } from '../../colliders/CylinderCollider.js';
import type { PlaneCollider } from '../../colliders/PlaneCollider.js';
import { SphereCollider } from '../../colliders/SphereCollider.js';
import { collide, registerCollisionTest } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';

/**
 * Cylinders and cones: exact contacts with planes, and with spheres for cylinders; against every
 * other shape they collide as their hull. Also how a contact on any round shape (sphere, capsule,
 * cylinder, cone) stays where the shapes touch as the shape rolls.
 */

/** Below this sine between a contact's normal and a cylinder's axis, the contact is on a flat end rather than the round side. */
const ROUND_SIDE_SINE = 0.7;

const axis = new Vector3();
const planeNormal = new Vector3();
const across = new Vector3();
const sideways = new Vector3();
const ringCenter = new Vector3();
const point = new Vector3();
const localCenter = new Vector3();
const nearest = new Vector3();
const offset = new Vector3();

/** The rings a round-ended shape is made of, along its y axis: height and radius, a radius of 0 being a tip. */
function ringsOf(collider: CylinderCollider | ConeCollider): readonly (readonly [number, number])[] {
  const half = collider.height / 2;
  return collider instanceof CylinderCollider
    ? [
        [half, collider.radius],
        [-half, collider.radius],
      ]
    : [
        [half, 0],
        [-half, collider.radius],
      ];
}

/**
 * A cylinder or cone on a plane: on each ring, the point reaching furthest into the plane and the
 * points a quarter and half a turn round from it, so that one standing on an end rests on a
 * patch, one lying down rests on a line, and one rolling touches exactly where it should.
 */
function roundOnPlane(collider: CylinderCollider | ConeCollider, pose: ColliderPose, plane: PlaneCollider, planePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  plane.normal(planePose, planeNormal);
  axisAt(pose, axis);
  // the way across the shape that reaches furthest into the plane
  across.copy(planeNormal).addScaledVector(axis, -planeNormal.dot(axis)).negate();
  if (across.lengthSq() < 1e-12) across.set(axis.y, axis.z, axis.x).cross(axis);
  across.normalize();
  sideways.crossVectors(axis, across);
  const planeHeight = planeNormal.dot(planePose.position);
  for (const [height, radius] of ringsOf(collider)) {
    ringCenter.copy(pose.position).addScaledVector(axis, height);
    const directions = radius === 0 ? [[0, 0]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [alongAcross, alongSideways] of directions) {
      point.copy(ringCenter).addScaledVector(across, radius * alongAcross!).addScaledVector(sideways, radius * alongSideways!);
      const above = planeNormal.dot(point) - planeHeight;
      if (above >= margin) continue;
      contacts.push({ pointA: point.clone(), pointB: point.clone().addScaledVector(planeNormal, -above), normal: planeNormal.clone(), depth: -above });
    }
  }
}

/** A sphere against a solid cylinder, exactly: the nearest point of the cylinder, or the nearest way out of it. */
function sphereCylinder(sphere: SphereCollider, spherePose: ColliderPose, cylinder: CylinderCollider, cylinderPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const inverse = cylinderPose.rotation.clone().transpose();
  localCenter.subVectors(spherePose.position, cylinderPose.position).applyMatrix3(inverse);
  const half = cylinder.height / 2;
  const radial = Math.hypot(localCenter.x, localCenter.z);
  const outward = new Vector3();
  let depth: number;
  if (radial <= cylinder.radius && Math.abs(localCenter.y) <= half) {
    // centre inside: out through the nearest of the side and the two ends
    const throughSide = cylinder.radius - radial;
    const throughEnd = half - Math.abs(localCenter.y);
    if (throughSide < throughEnd && radial > 1e-12) {
      outward.set(localCenter.x / radial, 0, localCenter.z / radial);
      nearest.set(outward.x * cylinder.radius, localCenter.y, outward.z * cylinder.radius);
      depth = sphere.radius + throughSide;
    } else {
      outward.set(0, Math.sign(localCenter.y) || 1, 0);
      nearest.set(localCenter.x, outward.y * half, localCenter.z);
      depth = sphere.radius + throughEnd;
    }
  } else {
    const shrink = radial > cylinder.radius ? cylinder.radius / radial : 1;
    nearest.set(localCenter.x * shrink, Math.min(Math.max(localCenter.y, -half), half), localCenter.z * shrink);
    outward.subVectors(localCenter, nearest);
    const distance = outward.length();
    if (distance >= sphere.radius + margin || distance < 1e-12) return;
    outward.divideScalar(distance);
    depth = sphere.radius - distance;
  }
  const normal = outward.applyMatrix3(cylinderPose.rotation);
  const pointB = nearest.applyMatrix3(cylinderPose.rotation).add(cylinderPose.position).clone();
  contacts.push({ pointA: spherePose.position.clone().addScaledVector(normal, -sphere.radius), pointB, normal: normal.clone(), depth });
}

/** The collider a shape collides as when there is no exact test for the pair: a round shape's hull, otherwise itself. */
export function standInFor(collider: Collider): Collider {
  return collider instanceof CylinderCollider || collider instanceof ConeCollider ? collider.hull : collider;
}

function viaHulls(colliderA: Collider, poseA: ColliderPose, colliderB: Collider, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  collide(standInFor(colliderA), poseA, standInFor(colliderB), poseB, contacts, margin);
}

/** Registers the cylinder and cone collision tests. Called by the collision system; safe to call again. */
export function registerRoundCollisionTests(): void {
  registerCollisionTest('cylinder', 'plane', roundOnPlane);
  registerCollisionTest('cone', 'plane', roundOnPlane);
  registerCollisionTest('sphere', 'cylinder', sphereCylinder);
  registerCollisionTest('sphere', 'cone', viaHulls);
  for (const other of ['box', 'convex', 'capsule', 'cylinder', 'cone']) registerCollisionTest('cylinder', other, viaHulls);
  for (const other of ['box', 'convex', 'capsule', 'cone']) registerCollisionTest('cone', other, viaHulls);
}

/**
 * Where a contact sits on a round shape that can roll, for the length of a step: a centre that
 * turns with the shape (a sphere's centre, a point on a capsule's or cylinder's axis) and the
 * reach from it to the surface along the way the shape faces the other, which stays put as the
 * shape rolls. Undefined for shapes, or parts of them, that don't roll, such as a cylinder's
 * flat end.
 * @param outward Unit direction from this collider toward the other one.
 */
export function roundingAt(collider: Collider, pose: ColliderPose, contactPoint: Vector3, outward: Vector3): { center: Vector3; reach: Vector3 } | undefined {
  if (collider instanceof SphereCollider) return { center: pose.position.clone(), reach: outward.clone().multiplyScalar(collider.radius) };
  if (!(collider instanceof CapsuleCollider || collider instanceof CylinderCollider || collider instanceof ConeCollider)) return undefined;
  axisAt(pose, axis);
  const half = collider instanceof CapsuleCollider ? collider.length / 2 : collider.height / 2;
  const alongAxis = Math.min(Math.max(offset.subVectors(contactPoint, pose.position).dot(axis), -half), half);
  const center = pose.position.clone().addScaledVector(axis, alongAxis);
  if (collider instanceof CapsuleCollider) return { center, reach: outward.clone().multiplyScalar(collider.radius) };
  // A cylinder or cone rolls on its side about the point where the normal through the contact
  // meets the axis: the centre of the surface's curvature around it. For a cylinder that is
  // straight across from the contact; a cone's normal leans toward its tip, so the centre is
  // further along the axis and further away than the axis is.
  across.copy(outward).addScaledVector(axis, -outward.dot(axis));
  const sine = across.length();
  if (sine < ROUND_SIDE_SINE) return undefined;
  const reach = offset.subVectors(contactPoint, center).dot(across) / (sine * sine);
  return { center: contactPoint.clone().addScaledVector(outward, -reach), reach: outward.clone().multiplyScalar(reach) };
}

/** Below this sine between the outward direction and a cylinder's or cone's axis, it stands flat on an end, with no one lowest point on the rim. */
const RIM_TILT_SINE = 0.01;
const rimCenter = new Vector3();
const rimPoint = new Vector3();

/**
 * Where a contact sits on the rim of a cylinder's or cone's end, if it is the rim's furthest
 * point toward the other body, as a tipped drum's lowest point is: the middle of the end, the
 * rim's radius, the axis and its sine with the outward direction. The rim's furthest point goes
 * round it as the drum rolls on it, so it is followed as the end turns, not fixed in the body:
 * it reaches `radius × √(1 − (outward · axis)²)` out from the middle along the outward direction.
 * @param outward Unit direction from this collider toward the other one.
 */
export function rimAt(collider: Collider, pose: ColliderPose, contactPoint: Vector3, outward: Vector3): { center: Vector3; radius: number; axis: Vector3; sine: number } | undefined {
  if (!(collider instanceof CylinderCollider || collider instanceof ConeCollider)) return undefined;
  axisAt(pose, axis);
  across.copy(outward).addScaledVector(axis, -outward.dot(axis));
  const sine = across.length();
  if (sine < RIM_TILT_SINE) return undefined;
  across.divideScalar(sine);
  for (const [height, radius] of ringsOf(collider)) {
    if (radius === 0) continue;
    rimCenter.copy(pose.position).addScaledVector(axis, height);
    rimPoint.copy(rimCenter).addScaledVector(across, radius);
    if (rimPoint.distanceToSquared(contactPoint) <= (1e-6 * radius) ** 2) return { center: rimCenter.clone(), radius, axis: axis.clone(), sine };
  }
  return undefined;
}

/** The radius a collider rolls on, for rolling resistance: a sphere's, capsule's or cylinder's, or a cone's at its middle. */
export function rollingRadius(collider: Collider): number | undefined {
  if (collider instanceof SphereCollider || collider instanceof CapsuleCollider || collider instanceof CylinderCollider) return collider.radius;
  if (collider instanceof ConeCollider) return collider.radius / 2;
  return undefined;
}
