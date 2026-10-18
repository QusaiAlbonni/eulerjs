import type { Quaternion} from 'three';
import { Vector3 } from 'three';
import type { BoxCollider } from '../../colliders/BoxCollider.js';
import type { ColliderPose } from '../../colliders/Collider.js';
import { ConvexCollider } from '../../colliders/ConvexCollider.js';
import type { PlaneCollider } from '../../colliders/PlaneCollider.js';
import type { SphereCollider } from '../../colliders/SphereCollider.js';
import { clipPolygon, closestPointsOnSegments, registerCollisionTest } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';

/** A hull placed in the world: its vertices and face planes in world space. */
export interface PlacedHull {
  hull: ConvexCollider;
  vertices: Vector3[];
  normals: Vector3[];
  offsets: number[];
  /** The collider's origin in world space, which its bounding radius is measured from. */
  origin: Vector3;
  /** The average of its vertices: a point inside the hull. */
  center: Vector3;
  /** Per edge: its two faces' normals crossed (the edge's arc on the Gauss map), its start and its vector. */
  edgeArcs: Vector3[];
  edgeStarts: Vector3[];
  edgeVectors: Vector3[];
}

/** The last placement of each hull, reused while its pose is unchanged (contacts are found once per step). */
const placements = new WeakMap<ConvexCollider, { position: Vector3; quaternion: Quaternion; placed: PlacedHull }>();

export function place(hull: ConvexCollider, pose: ColliderPose): PlacedHull {
  const cached = placements.get(hull);
  if (cached && cached.position.equals(pose.position) && cached.quaternion.equals(pose.quaternion)) return cached.placed;
  const placed = placeAfresh(hull, pose);
  placements.set(hull, { position: pose.position.clone(), quaternion: pose.quaternion.clone(), placed });
  return placed;
}

function placeAfresh(hull: ConvexCollider, pose: ColliderPose): PlacedHull {
  const vertices = hull.vertices.map((vertex) => vertex.clone().applyMatrix3(pose.rotation).add(pose.position));
  const normals = hull.faces.map((face) => face.normal.clone().applyMatrix3(pose.rotation));
  const offsets = hull.faces.map((face, index) => normals[index]!.dot(vertices[face.vertexIndices[0]!]!));
  const center = vertices.reduce((sum, vertex) => sum.add(vertex), new Vector3()).divideScalar(vertices.length);
  const edgeArcs = hull.edgeFaces.map(([face, otherFace]) => new Vector3().crossVectors(normals[otherFace]!, normals[face]!));
  const edgeStarts = hull.edges.map(([tail]) => vertices[tail]!);
  const edgeVectors = hull.edges.map(([tail, head]) => new Vector3().subVectors(vertices[head]!, vertices[tail]!));
  return { hull, vertices, normals, offsets, origin: pose.position.clone(), center, edgeArcs, edgeStarts, edgeVectors };
}

/** Hulls standing in for boxes, so boxes collide with hulls through the same test. */
const boxHulls = new WeakMap<BoxCollider, ConvexCollider>();
export function hullOfBox(box: BoxCollider): ConvexCollider {
  let hull = boxHulls.get(box);
  if (!hull) {
    const { x: halfX, y: halfY, z: halfZ } = box.halfExtents;
    const points: Vector3[] = [];
    for (const signX of [-1, 1]) for (const signY of [-1, 1]) for (const signZ of [-1, 1]) points.push(new Vector3(signX * halfX, signY * halfY, signZ * halfZ));
    hull = new ConvexCollider({ points });
    boxHulls.set(box, hull);
  }
  return hull;
}

/** How far `other` stays outside face `faceIndex` of `placed`: negative when it reaches through. */
function faceSeparation(placed: PlacedHull, faceIndex: number, other: PlacedHull): number {
  const normal = placed.normals[faceIndex]!;
  let deepest = Infinity;
  for (const vertex of other.vertices) deepest = Math.min(deepest, normal.dot(vertex));
  return deepest - placed.offsets[faceIndex]!;
}

function bestFace(placed: PlacedHull, other: PlacedHull, margin: number): { index: number; separation: number } | undefined {
  let best = { index: -1, separation: -Infinity };
  for (let index = 0; index < placed.normals.length; index++) {
    const separation = faceSeparation(placed, index, other);
    if (separation > margin) return undefined;
    if (separation > best.separation) best = { index, separation };
  }
  return best;
}

interface EdgeAxis {
  /** Unit axis from A toward B. */
  axis: Vector3;
  /** The two touching edges, as segment ends in world space. */
  edgeA: [Vector3, Vector3];
  edgeB: [Vector3, Vector3];
  separation: number;
}

const candidateAxis = new Vector3();
const offsetScratch = new Vector3();

/**
 * The edge pair whose cross product separates the hulls best. Only edge pairs that form a face of
 * the Minkowski difference can separate them (Gregorius, "The Separating Axis Test between Convex
 * Polyhedra", GDC 2013): seen as arcs between their faces' normals on the unit sphere, with B's
 * normals negated, the two arcs must cross.
 */
function bestEdgeAxis(hullA: PlacedHull, hullB: PlacedHull, margin: number): EdgeAxis | undefined | null {
  let best: EdgeAxis | undefined;
  const edgeCountA = hullA.edgeArcs.length;
  const edgeCountB = hullB.edgeArcs.length;
  for (let indexA = 0; indexA < edgeCountA; indexA++) {
    const [faceA, otherFaceA] = hullA.hull.edgeFaces[indexA]!;
    const normalA = hullA.normals[faceA]!;
    const otherNormalA = hullA.normals[otherFaceA]!;
    const arcA = hullA.edgeArcs[indexA]!;
    for (let indexB = 0; indexB < edgeCountB; indexB++) {
      const [faceB, otherFaceB] = hullB.hull.edgeFaces[indexB]!;
      const normalBAcrossA = hullB.normals[faceB]!.dot(arcA);
      const otherNormalBAcrossA = hullB.normals[otherFaceB]!.dot(arcA);
      if (normalBAcrossA * otherNormalBAcrossA >= 0) continue;
      const arcB = hullB.edgeArcs[indexB]!;
      const normalAAcrossB = normalA.dot(arcB);
      const otherNormalAAcrossB = otherNormalA.dot(arcB);
      if (normalAAcrossB * otherNormalAAcrossB >= 0 || normalBAcrossA * otherNormalAAcrossB >= 0) continue;

      const vectorA = hullA.edgeVectors[indexA]!;
      const vectorB = hullB.edgeVectors[indexB]!;
      candidateAxis.crossVectors(vectorA, vectorB);
      const length = candidateAxis.length();
      if (length < 1e-6 * vectorA.length() * vectorB.length()) continue;
      candidateAxis.divideScalar(length);
      const startA = hullA.edgeStarts[indexA]!;
      const startB = hullB.edgeStarts[indexB]!;
      if (candidateAxis.dot(offsetScratch.subVectors(startA, hullA.center)) < 0) candidateAxis.negate();
      const separation = candidateAxis.dot(offsetScratch.subVectors(startB, startA));
      if (separation > margin) return null;
      if (!best || separation > best.separation) {
        best = {
          axis: candidateAxis.clone(),
          edgeA: [startA, startA.clone().add(vectorA)],
          edgeB: [startB, startB.clone().add(vectorB)],
          separation,
        };
      }
    }
  }
  return best;
}

/** Separating-axis test between two hulls, then contacts from clipping faces or from two crossing edges. */
function hullHull(hullA: PlacedHull, hullB: PlacedHull, contacts: ContactPoint[], margin: number): void {
  const reach = hullA.hull.boundingRadius + hullB.hull.boundingRadius + margin;
  if (hullA.origin.distanceToSquared(hullB.origin) > reach * reach) return;
  const faceOfA = bestFace(hullA, hullB, margin);
  if (!faceOfA) return;
  const faceOfB = bestFace(hullB, hullA, margin);
  if (!faceOfB) return;
  const edge = bestEdgeAxis(hullA, hullB, margin);
  if (edge === null) return;

  const scale = Math.min(hullA.hull.boundingRadius, hullB.hull.boundingRadius);
  const faceSeparationBest = Math.max(faceOfA.separation, faceOfB.separation);
  // Prefer faces: they give a whole patch of contacts, which keeps resting bodies steady.
  if (edge && edge.separation > faceSeparationBest + 0.01 * scale) {
    edgeContact(edge, contacts);
  } else if (faceOfA.separation >= faceOfB.separation) {
    faceContacts(hullA, faceOfA.index, hullB, true, contacts, margin);
  } else {
    faceContacts(hullB, faceOfB.index, hullA, false, contacts, margin);
  }
}

function faceContacts(reference: PlacedHull, faceIndex: number, incident: PlacedHull, referenceIsA: boolean, contacts: ContactPoint[], margin: number): void {
  const referenceNormal = reference.normals[faceIndex]!;
  const referenceOffset = reference.offsets[faceIndex]!;
  const referenceCorners = reference.hull.faces[faceIndex]!.vertexIndices.map((index) => reference.vertices[index]!);

  // The incident face is the one facing most against the reference normal.
  let incidentFace = 0;
  for (let index = 1; index < incident.normals.length; index++) {
    if (incident.normals[index]!.dot(referenceNormal) < incident.normals[incidentFace]!.dot(referenceNormal)) incidentFace = index;
  }
  let polygon = incident.hull.faces[incidentFace]!.vertexIndices.map((index) => incident.vertices[index]!.clone());

  // Clip it to the side planes through the reference face's edges.
  referenceCorners.forEach((corner, position) => {
    const next = referenceCorners[(position + 1) % referenceCorners.length]!;
    const sideNormal = new Vector3().subVectors(next, corner).cross(referenceNormal).normalize();
    polygon = clipPolygon(polygon, sideNormal, sideNormal.dot(corner));
  });

  const normalFromBToA = referenceIsA ? referenceNormal.clone().negate() : referenceNormal.clone();
  for (const point of polygon) {
    const separation = referenceNormal.dot(point) - referenceOffset;
    if (separation > margin) continue;
    const onReference = point.clone().addScaledVector(referenceNormal, -separation);
    contacts.push(
      referenceIsA
        ? { pointA: onReference, pointB: point, normal: normalFromBToA.clone(), depth: -separation }
        : { pointA: point, pointB: onReference, normal: normalFromBToA.clone(), depth: -separation },
    );
  }
}

function edgeContact(edge: EdgeAxis, contacts: ContactPoint[]): void {
  const segment = ([start, end]: [Vector3, Vector3]) => {
    const middle = new Vector3().addVectors(start, end).multiplyScalar(0.5);
    const direction = new Vector3().subVectors(end, start);
    const halfLength = direction.length() / 2;
    return { middle, direction: direction.normalize(), halfLength };
  };
  const onA = segment(edge.edgeA);
  const onB = segment(edge.edgeB);
  const [pointA, pointB] = closestPointsOnSegments(onA.middle, onA.direction, onA.halfLength, onB.middle, onB.direction, onB.halfLength);
  contacts.push({ pointA, pointB, normal: edge.axis.clone().negate(), depth: -edge.separation });
}

function convexConvex(colliderA: ConvexCollider, poseA: ColliderPose, colliderB: ConvexCollider, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  hullHull(place(colliderA, poseA), place(colliderB, poseB), contacts, margin);
}

function boxConvex(box: BoxCollider, boxPose: ColliderPose, convex: ConvexCollider, convexPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  hullHull(place(hullOfBox(box), boxPose), place(convex, convexPose), contacts, margin);
}

function convexPlane(convex: ConvexCollider, convexPose: ColliderPose, plane: PlaneCollider, planePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const normal = plane.normal(planePose);
  const planeHeight = normal.dot(planePose.position);
  for (const vertex of convex.vertices) {
    const corner = vertex.clone().applyMatrix3(convexPose.rotation).add(convexPose.position);
    const height = normal.dot(corner) - planeHeight;
    if (height >= margin) continue;
    contacts.push({ pointA: corner, pointB: corner.clone().addScaledVector(normal, -height), normal: normal.clone(), depth: -height });
  }
}

export function sphereConvex(sphere: SphereCollider, spherePose: ColliderPose, convex: ConvexCollider, convexPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const placed = place(convex, convexPose);
  const center = spherePose.position;
  let outermost = 0;
  for (let index = 1; index < placed.normals.length; index++) {
    if (placed.normals[index]!.dot(center) - placed.offsets[index]! > placed.normals[outermost]!.dot(center) - placed.offsets[outermost]!) outermost = index;
  }
  const outermostDistance = placed.normals[outermost]!.dot(center) - placed.offsets[outermost]!;

  if (outermostDistance <= 0) {
    // centre inside the hull: push it out through the nearest face
    const normal = placed.normals[outermost]!.clone();
    contacts.push({
      pointA: center.clone().addScaledVector(normal, -sphere.radius),
      pointB: center.clone().addScaledVector(normal, -outermostDistance),
      normal,
      depth: sphere.radius - outermostDistance,
    });
    return;
  }

  // centre outside: the nearest point on any face it is in front of
  let nearest: Vector3 | undefined;
  let nearestDistance = Infinity;
  placed.hull.faces.forEach((face, faceIndex) => {
    if (placed.normals[faceIndex]!.dot(center) - placed.offsets[faceIndex]! <= 0) return;
    const corners = face.vertexIndices.map((index) => placed.vertices[index]!);
    for (let corner = 1; corner + 1 < corners.length; corner++) {
      const candidate = closestPointOnTriangle(center, corners[0]!, corners[corner]!, corners[corner + 1]!);
      const distance = candidate.distanceTo(center);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = candidate;
      }
    }
  });
  if (!nearest || nearestDistance >= sphere.radius + margin || nearestDistance < 1e-12) return;
  const normal = new Vector3().subVectors(center, nearest).divideScalar(nearestDistance);
  contacts.push({ pointA: center.clone().addScaledVector(normal, -sphere.radius), pointB: nearest, normal, depth: sphere.radius - nearestDistance });
}

/** Closest point of triangle (first, second, third) to `point` (Ericson, Real-Time Collision Detection, 5.1.5). */
export function closestPointOnTriangle(point: Vector3, first: Vector3, second: Vector3, third: Vector3): Vector3 {
  const edgeFirstSecond = new Vector3().subVectors(second, first);
  const edgeFirstThird = new Vector3().subVectors(third, first);
  const fromFirst = new Vector3().subVectors(point, first);
  const firstAlongSecond = edgeFirstSecond.dot(fromFirst);
  const firstAlongThird = edgeFirstThird.dot(fromFirst);
  if (firstAlongSecond <= 0 && firstAlongThird <= 0) return first.clone();

  const fromSecond = new Vector3().subVectors(point, second);
  const secondAlongSecond = edgeFirstSecond.dot(fromSecond);
  const secondAlongThird = edgeFirstThird.dot(fromSecond);
  if (secondAlongSecond >= 0 && secondAlongThird <= secondAlongSecond) return second.clone();

  const regionFirstSecond = firstAlongSecond * secondAlongThird - secondAlongSecond * firstAlongThird;
  if (regionFirstSecond <= 0 && firstAlongSecond >= 0 && secondAlongSecond <= 0) {
    return first.clone().addScaledVector(edgeFirstSecond, firstAlongSecond / (firstAlongSecond - secondAlongSecond));
  }

  const fromThird = new Vector3().subVectors(point, third);
  const thirdAlongSecond = edgeFirstSecond.dot(fromThird);
  const thirdAlongThird = edgeFirstThird.dot(fromThird);
  if (thirdAlongThird >= 0 && thirdAlongSecond <= thirdAlongThird) return third.clone();

  const regionFirstThird = thirdAlongSecond * firstAlongThird - firstAlongSecond * thirdAlongThird;
  if (regionFirstThird <= 0 && firstAlongThird >= 0 && thirdAlongThird <= 0) {
    return first.clone().addScaledVector(edgeFirstThird, firstAlongThird / (firstAlongThird - thirdAlongThird));
  }

  const regionSecondThird = secondAlongSecond * thirdAlongThird - thirdAlongSecond * secondAlongThird;
  if (regionSecondThird <= 0 && secondAlongThird - secondAlongSecond >= 0 && thirdAlongSecond - thirdAlongThird >= 0) {
    const share = (secondAlongThird - secondAlongSecond) / (secondAlongThird - secondAlongSecond + (thirdAlongSecond - thirdAlongThird));
    return second.clone().addScaledVector(new Vector3().subVectors(third, second), share);
  }

  const total = 1 / (regionSecondThird + regionFirstThird + regionFirstSecond);
  return first.clone().addScaledVector(edgeFirstSecond, regionFirstThird * total).addScaledVector(edgeFirstThird, regionFirstSecond * total);
}

/** Registers the convex hull collision tests. Called by the collision system; safe to call again. */
export function registerConvexCollisionTests(): void {
  registerCollisionTest('convex', 'convex', convexConvex);
  registerCollisionTest('box', 'convex', boxConvex);
  registerCollisionTest('convex', 'plane', convexPlane);
  registerCollisionTest('sphere', 'convex', sphereConvex);
}
