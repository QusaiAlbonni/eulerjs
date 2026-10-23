import { Vector3 } from 'three';
import { BoxCollider } from '../../colliders/BoxCollider.js';
import { CapsuleCollider } from '../../colliders/CapsuleCollider.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import { ConvexCollider } from '../../colliders/ConvexCollider.js';
import { SphereCollider } from '../../colliders/SphereCollider.js';
import { forEachStandInSphere } from './capsule.js';
import { closestPointOnTriangle, hullOfBox, place, withEdges } from './convex.js';
import type { PlacedHull } from './convex.js';
import { clipPolygon, closestPointsOnSegments } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';
import { standInFor } from './round.js';

/**
 * Collisions between a collider and single triangles, for shapes made of them: heightfields, and
 * triangle meshes in plugins. Contacts are reported with the collider as A and the triangle as B,
 * so their normals point from the triangle toward the collider.
 */

/**
 * Adds the contacts between the collider it was made for and the triangle (first, second, third),
 * counting points up to `margin` apart. A one-sided triangle, such as a piece of terrain, only
 * ever pushes out of the side its corners wind anticlockwise around.
 *
 * `activeEdges` has bit k set for each edge, from corner k to the next, that may push on its own
 * (see `isActiveEdge`); the default is all three. An inactive edge lies between this triangle and
 * a neighbour that covers it, so a contact on it would only be a ghost of the neighbour's.
 */
export type TriangleTest = (first: Vector3, second: Vector3, third: Vector3, contacts: ContactPoint[], margin: number, oneSided?: boolean, activeEdges?: number) => void;

/** All three edges active. */
export const ALL_EDGES = 0b111;

/** Neighbouring triangles closer to flat than this, as the cosine of the angle between their normals, share an inactive edge. */
const ACTIVE_EDGE_COSINE = Math.cos((5 * Math.PI) / 180);

/**
 * Whether the edge from `start` to `end` of a triangle with unit normal `normal` should push on
 * its own: yes on the border of a surface (no neighbour), and where the surface folds away from
 * the triangle's front by more than a few degrees, a ridge; no where it is nearly flat, or folds
 * up into a valley, where the faces either side do all the pushing.
 * @param neighbourCorner The corner of the triangle on the other side of the edge that isn't on it.
 */
export function isActiveEdge(normal: Vector3, start: Vector3, end: Vector3, neighbourCorner: Vector3 | undefined): boolean {
  if (!neighbourCorner) return true;
  const neighbourNormal = new Vector3().crossVectors(edgeScratch.subVectors(start, end), otherEdgeScratch.subVectors(neighbourCorner, end)).normalize();
  if (normal.dot(neighbourNormal) > ACTIVE_EDGE_COSINE) return false;
  // a ridge: the neighbour's far corner is behind this triangle's plane
  return normal.dot(offsetScratch.subVectors(neighbourCorner, start)) < 0;
}

/**
 * The test of `collider` at `pose` against triangles, set up once to be run on many: undefined
 * for shapes that can't collide with triangles, such as planes and other triangle shapes.
 */
export function triangleTestFor(collider: Collider, pose: ColliderPose): TriangleTest | undefined {
  const shape = standInFor(collider);
  if (shape instanceof SphereCollider) {
    return (first, second, third, contacts, margin, oneSided, activeEdges) => sphereTriangle(shape, pose.position, first, second, third, contacts, margin, oneSided ?? false, activeEdges ?? ALL_EDGES);
  }
  if (shape instanceof CapsuleCollider) {
    return (first, second, third, contacts, margin, oneSided, activeEdges) => {
      const distance = (point: Vector3) => point.distanceTo(closestPointOnTriangle(point, first, second, third));
      forEachStandInSphere(shape, pose, distance, (sphere, spherePose) => sphereTriangle(sphere, spherePose.position, first, second, third, contacts, margin, oneSided ?? false, activeEdges ?? ALL_EDGES));
    };
  }
  const hull = shape instanceof BoxCollider ? hullOfBox(shape) : shape instanceof ConvexCollider ? shape : undefined;
  if (!hull) return undefined;
  const placed = withEdges(place(hull, pose));
  const edgeDirections = hull.edgeDirections.map((direction) => direction.clone().applyMatrix3(pose.rotation));
  return (first, second, third, contacts, margin, oneSided, activeEdges) => hullTriangle(placed, edgeDirections, [first, second, third], contacts, margin, oneSided ?? false, activeEdges ?? ALL_EDGES);
}

const triangleNormal = new Vector3();
const edgeScratch = new Vector3();
const otherEdgeScratch = new Vector3();
const offsetScratch = new Vector3();

function normalOf(first: Vector3, second: Vector3, third: Vector3, target: Vector3): Vector3 {
  return target.crossVectors(edgeScratch.subVectors(second, first), otherEdgeScratch.subVectors(third, first)).normalize();
}

function sphereTriangle(sphere: SphereCollider, center: Vector3, first: Vector3, second: Vector3, third: Vector3, contacts: ContactPoint[], margin: number, oneSided: boolean, activeEdges: number): void {
  normalOf(first, second, third, triangleNormal);
  if (triangleNormal.lengthSq() === 0) return;
  const height = triangleNormal.dot(offsetScratch.subVectors(center, first));
  const nearest = closestPointOnTriangle(center, first, second, third);
  if (oneSided && height < 0) {
    // centre behind a one-sided surface: out through the front, if it is behind the triangle itself
    if (nearest.distanceToSquared(offsetScratch.copy(center).addScaledVector(triangleNormal, -height)) > 1e-18) return;
    const normal = triangleNormal.clone();
    contacts.push({ pointA: center.clone().addScaledVector(normal, -sphere.radius), pointB: nearest, normal, depth: sphere.radius - height });
    return;
  }
  const distance = nearest.distanceTo(center);
  if (distance >= sphere.radius + margin) return;
  // straight below the centre is the face itself, wherever on it; off to the side, an edge or corner, which may not push
  const onFace = nearest.distanceToSquared(offsetScratch.copy(center).addScaledVector(triangleNormal, -height)) <= 1e-18 * (1 + center.lengthSq());
  if (!onFace && activeEdges !== ALL_EDGES && !onActiveFeature(nearest, [first, second, third], activeEdges)) return;
  const normal = distance > 1e-12 ? new Vector3().subVectors(center, nearest).divideScalar(distance) : triangleNormal.clone().multiplyScalar(height < 0 ? -1 : 1);
  contacts.push({ pointA: center.clone().addScaledVector(normal, -sphere.radius), pointB: nearest, normal, depth: sphere.radius - distance });
}

/** Whether `point`, the nearest point of the triangle to something, is inside it or on an edge or corner that may push. */
function onActiveFeature(point: Vector3, corners: readonly Vector3[], activeEdges: number): boolean {
  const scale = corners[0]!.distanceTo(corners[1]!) + corners[1]!.distanceTo(corners[2]!);
  const tolerance = 1e-9 * scale;
  let onAnyEdge = false;
  for (let edge = 0; edge < 3; edge++) {
    const start = corners[edge]!;
    const along = edgeScratch.subVectors(corners[(edge + 1) % 3]!, start);
    const fraction = Math.min(Math.max(along.dot(offsetScratch.subVectors(point, start)) / along.lengthSq(), 0), 1);
    if (offsetScratch.copy(start).addScaledVector(along, fraction).distanceTo(point) > tolerance) continue;
    onAnyEdge = true;
    if ((activeEdges >> edge) & 1) return true;
  }
  return !onAnyEdge;
}

interface Separation {
  /** Unit axis from the triangle toward the hull. */
  axis: Vector3;
  separation: number;
}

interface FaceSeparation extends Separation {
  faceIndex: number;
}

interface EdgeSeparation extends Separation {
  hullDirection: Vector3;
  triangleEdge: number;
}

/** The hull reaches below the triangle's plane by its lowest vertex; the triangle reaches above the hull by its highest corner. */
function separationAlong(axis: Vector3, placed: PlacedHull, corners: readonly Vector3[]): number {
  let lowestOfHull = Infinity;
  for (const vertex of placed.vertices) lowestOfHull = Math.min(lowestOfHull, axis.dot(vertex));
  let highestOfTriangle = -Infinity;
  for (const corner of corners) highestOfTriangle = Math.max(highestOfTriangle, axis.dot(corner));
  return lowestOfHull - highestOfTriangle;
}

/**
 * Separating axes between a hull and a triangle: the triangle's normal, the hull's faces, and the
 * cross products of their edges. Contacts come from clipping the hull's face against the triangle,
 * the triangle against the hull's face, or from the closest points of two crossing edges.
 */
function hullTriangle(placed: PlacedHull, edgeDirections: readonly Vector3[], corners: readonly Vector3[], contacts: ContactPoint[], margin: number, oneSided: boolean, activeEdges: number): void {
  const normal = normalOf(corners[0]!, corners[1]!, corners[2]!, new Vector3());
  if (normal.lengthSq() === 0) return;
  const triangleCenter = new Vector3().add(corners[0]!).add(corners[1]!).add(corners[2]!).divideScalar(3);
  const towardHull = new Vector3().subVectors(placed.center, triangleCenter);
  const behind = normal.dot(towardHull) < 0;
  if (behind && !oneSided) normal.negate();
  const face: Separation = { axis: normal, separation: separationAlong(normal, placed, corners) };
  if (face.separation > margin) return;
  // behind a one-sided surface, the only way out is through its front
  if (behind && oneSided) {
    triangleFaceContacts(placed, corners, face.axis, contacts, margin);
    return;
  }

  let bestHullFace: FaceSeparation | undefined;
  for (let faceIndex = 0; faceIndex < placed.normals.length; faceIndex++) {
    const faceNormal = placed.normals[faceIndex]!;
    let nearestCorner = Infinity;
    for (const corner of corners) nearestCorner = Math.min(nearestCorner, faceNormal.dot(corner));
    const separation = nearestCorner - placed.offsets[faceIndex]!;
    if (separation > margin) return;
    if (!bestHullFace || separation > bestHullFace.separation) bestHullFace = { axis: faceNormal.clone().negate(), separation, faceIndex };
  }

  let bestEdge: EdgeSeparation | undefined;
  for (const hullDirection of edgeDirections) {
    for (let triangleEdge = 0; triangleEdge < 3; triangleEdge++) {
      edgeScratch.subVectors(corners[(triangleEdge + 1) % 3]!, corners[triangleEdge]!);
      const axis = new Vector3().crossVectors(hullDirection, edgeScratch);
      const length = axis.length();
      if (length < 1e-6 * edgeScratch.length()) continue;
      axis.divideScalar(length);
      if (axis.dot(towardHull) < 0) axis.negate();
      // a one-sided surface can't push down through itself
      if (oneSided && axis.dot(normal) < 0) continue;
      const separation = separationAlong(axis, placed, corners);
      if (separation > margin) return;
      if (!bestEdge || separation > bestEdge.separation) bestEdge = { axis, separation, hullDirection, triangleEdge };
    }
  }

  // Prefer faces, the triangle's above all: they give a patch of contacts and keep a body resting on a surface steady.
  const tolerance = 0.01 * placed.hull.boundingRadius;
  const bestOther = Math.max(bestHullFace?.separation ?? -Infinity, bestEdge?.separation ?? -Infinity);
  if (face.separation >= bestOther - tolerance) triangleFaceContacts(placed, corners, face.axis, contacts, margin);
  else if (bestHullFace && bestHullFace.separation >= (bestEdge?.separation ?? -Infinity) - tolerance) hullFaceContacts(placed, bestHullFace.faceIndex, corners, contacts, margin);
  // across an edge that doesn't push on its own, the neighbour's face is what the hull is meeting
  else if (bestEdge && !((activeEdges >> bestEdge.triangleEdge) & 1)) triangleFaceContacts(placed, corners, face.axis, contacts, margin);
  else if (bestEdge) edgeContact(placed, corners, bestEdge, contacts);
}

/** The hull's face most against the triangle, clipped to the triangle: contacts on the triangle's face. */
function triangleFaceContacts(placed: PlacedHull, corners: readonly Vector3[], axis: Vector3, contacts: ContactPoint[], margin: number): void {
  let incidentFace = 0;
  for (let index = 1; index < placed.normals.length; index++) {
    if (placed.normals[index]!.dot(axis) < placed.normals[incidentFace]!.dot(axis)) incidentFace = index;
  }
  let polygon = placed.hull.faces[incidentFace]!.vertexIndices.map((index) => placed.vertices[index]!.clone());
  const triangleCenter = new Vector3().add(corners[0]!).add(corners[1]!).add(corners[2]!).divideScalar(3);
  for (let edge = 0; edge < 3; edge++) {
    const start = corners[edge]!;
    const sideNormal = new Vector3().subVectors(corners[(edge + 1) % 3]!, start).cross(axis).normalize();
    if (sideNormal.dot(offsetScratch.subVectors(triangleCenter, start)) > 0) sideNormal.negate();
    polygon = clipPolygon(polygon, sideNormal, sideNormal.dot(start));
  }
  const planeOffset = axis.dot(corners[0]!);
  for (const point of polygon) {
    const separation = axis.dot(point) - planeOffset;
    if (separation > margin) continue;
    contacts.push({ pointA: point, pointB: point.clone().addScaledVector(axis, -separation), normal: axis.clone(), depth: -separation });
  }
}

/** The triangle clipped to one of the hull's faces: contacts on the hull's face. */
function hullFaceContacts(placed: PlacedHull, faceIndex: number, corners: readonly Vector3[], contacts: ContactPoint[], margin: number): void {
  const faceNormal = placed.normals[faceIndex]!;
  const faceCorners = placed.hull.faces[faceIndex]!.vertexIndices.map((index) => placed.vertices[index]!);
  let polygon = corners.map((corner) => corner.clone());
  faceCorners.forEach((corner, position) => {
    const next = faceCorners[(position + 1) % faceCorners.length]!;
    const sideNormal = new Vector3().subVectors(next, corner).cross(faceNormal).normalize();
    polygon = clipPolygon(polygon, sideNormal, sideNormal.dot(corner));
  });
  const offset = placed.offsets[faceIndex]!;
  for (const point of polygon) {
    const separation = faceNormal.dot(point) - offset;
    if (separation > margin) continue;
    contacts.push({ pointA: point.clone().addScaledVector(faceNormal, -separation), pointB: point, normal: faceNormal.clone().negate(), depth: -separation });
  }
}

/** Where an edge of the hull crosses an edge of the triangle. */
function edgeContact(placed: PlacedHull, corners: readonly Vector3[], edge: EdgeSeparation, contacts: ContactPoint[]): void {
  // the hull's edge along that direction reaching furthest toward the triangle
  let hullEdge = -1;
  let lowest = Infinity;
  placed.edgeVectors.forEach((vector, index) => {
    const length = vector.length();
    if (Math.abs(vector.dot(edge.hullDirection)) < (1 - 1e-6) * length) return;
    const height = edge.axis.dot(offsetScratch.copy(placed.edgeStarts[index]!).addScaledVector(vector, 0.5));
    if (height < lowest) {
      lowest = height;
      hullEdge = index;
    }
  });
  if (hullEdge === -1) return;
  const hullVector = placed.edgeVectors[hullEdge]!;
  const hullMiddle = placed.edgeStarts[hullEdge]!.clone().addScaledVector(hullVector, 0.5);
  const triangleStart = corners[edge.triangleEdge]!;
  const triangleVector = new Vector3().subVectors(corners[(edge.triangleEdge + 1) % 3]!, triangleStart);
  const triangleMiddle = triangleStart.clone().addScaledVector(triangleVector, 0.5);
  const [pointA, pointB] = closestPointsOnSegments(
    hullMiddle,
    hullVector.clone().normalize(),
    hullVector.length() / 2,
    triangleMiddle,
    triangleVector.clone().normalize(),
    triangleVector.length() / 2,
  );
  contacts.push({ pointA, pointB, normal: edge.axis.clone(), depth: -edge.separation });
}
