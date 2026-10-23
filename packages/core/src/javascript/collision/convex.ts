import { Quaternion, Vector3 } from 'three';
import type { BoxCollider } from '../../colliders/BoxCollider.js';
import type { ColliderPose } from '../../colliders/Collider.js';
import { ConvexCollider } from '../../colliders/ConvexCollider.js';
import type { PlaneCollider } from '../../colliders/PlaneCollider.js';
import type { SphereCollider } from '../../colliders/SphereCollider.js';
import { shapeDistance } from './gjk.js';
import type { SupportShape } from './gjk.js';
import { closestPointsOnSegments, registerCollisionTest } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';
import { FACE_PATCH_POINTS, reduceManifold } from './manifoldReduction.js';

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
  /** The vertices, the face normals and the edges' arcs again, three numbers each, for the tests' inner loops. */
  vertexData: Float64Array;
  normalData: Float64Array;
  arcData: Float64Array;
  /**
   * Whether the edges' arcs and vectors are worked out for the pose: only when something asks for
   * them (see `withEdges`), most pairs being decided by their faces or their distance alone.
   */
  edgesPlaced: boolean;
}

/** What doesn't change with a hull's pose: each vertex's neighbours, and each edge's two faces, as flat arrays. */
interface HullTables {
  /** The neighbours of vertex `v` are `neighbours[neighbourStarts[v]]` up to `neighbourStarts[v + 1]`. */
  neighbourStarts: Int32Array;
  neighbours: Int32Array;
  /** Edge `e`'s faces are `edgeFaces[2e]` and `edgeFaces[2e + 1]`. */
  edgeFaces: Int32Array;
}

const tablesOfHull = new WeakMap<ConvexCollider, HullTables>();

function tablesOf(hull: ConvexCollider): HullTables {
  let tables = tablesOfHull.get(hull);
  if (tables) return tables;
  const lists: number[][] = hull.vertices.map(() => []);
  for (const [tail, head] of hull.edges) {
    if (!lists[tail]!.includes(head)) lists[tail]!.push(head);
    if (!lists[head]!.includes(tail)) lists[head]!.push(tail);
  }
  const neighbourStarts = new Int32Array(lists.length + 1);
  lists.forEach((list, index) => (neighbourStarts[index + 1] = neighbourStarts[index]! + list.length));
  tables = { neighbourStarts, neighbours: Int32Array.from(lists.flat()), edgeFaces: Int32Array.from(hull.edgeFaces.flat()) };
  tablesOfHull.set(hull, tables);
  return tables;
}

/**
 * Each hull's last placement, reused while its pose is unchanged (contacts are found once per
 * step): per body, since one collider may be on many, or per collider for a pose of no body's.
 */
const placementsByOwner = new WeakMap<object, WeakMap<ConvexCollider, { position: Vector3; quaternion: Quaternion; placed: PlacedHull }>>();
const placementsOfNoOwner = new WeakMap<ConvexCollider, { position: Vector3; quaternion: Quaternion; placed: PlacedHull }>();

export function place(hull: ConvexCollider, pose: ColliderPose): PlacedHull {
  let placements = placementsOfNoOwner;
  if (pose.owner) {
    placements = placementsByOwner.get(pose.owner) ?? new WeakMap();
    placementsByOwner.set(pose.owner, placements);
  }
  const cached = placements.get(hull);
  if (cached && cached.position.equals(pose.position) && cached.quaternion.equals(pose.quaternion)) return cached.placed;
  if (cached && pose.owner) {
    // a body's: placed again where it is now, in the same arrays, a moving body being placed every
    // step; a pose of no body's, a query's, is placed afresh, as it may be placed at several at once
    placeInto(cached.placed, pose);
    cached.position.copy(pose.position);
    cached.quaternion.copy(pose.quaternion);
    return cached.placed;
  }
  const placed = placeAfresh(hull, pose);
  placements.set(hull, { position: pose.position.clone(), quaternion: pose.quaternion.clone(), placed });
  return placed;
}

function placeAfresh(hull: ConvexCollider, pose: ColliderPose): PlacedHull {
  const vertices = hull.vertices.map(() => new Vector3());
  const placed: PlacedHull = {
    hull,
    vertices,
    normals: hull.faces.map(() => new Vector3()),
    offsets: hull.faces.map(() => 0),
    origin: new Vector3(),
    center: new Vector3(),
    edgeArcs: hull.edges.map(() => new Vector3()),
    edgeStarts: hull.edges.map(([tail]) => vertices[tail]!),
    edgeVectors: hull.edges.map(() => new Vector3()),
    vertexData: new Float64Array(hull.vertices.length * 3),
    normalData: new Float64Array(hull.faces.length * 3),
    arcData: new Float64Array(hull.edges.length * 3),
    edgesPlaced: false,
  };
  placeInto(placed, pose);
  return placed;
}

/** `vector`'s three numbers into `data` from `at`. */
function store(vector: Vector3, data: Float64Array, at: number): void {
  data[at] = vector.x;
  data[at + 1] = vector.y;
  data[at + 2] = vector.z;
}

function placeInto(placed: PlacedHull, pose: ColliderPose): void {
  const { hull, vertices, normals, offsets, center, vertexData, normalData } = placed;
  center.set(0, 0, 0);
  const localVertices = hull.vertices;
  for (let index = 0; index < localVertices.length; index++) {
    const vertex = vertices[index]!.copy(localVertices[index]!).applyMatrix3(pose.rotation).add(pose.position);
    store(vertex, vertexData, index * 3);
    center.add(vertex);
  }
  center.divideScalar(vertices.length);
  const faces = hull.faces;
  for (let index = 0; index < faces.length; index++) {
    const face = faces[index]!;
    const normal = normals[index]!.copy(face.normal).applyMatrix3(pose.rotation);
    store(normal, normalData, index * 3);
    offsets[index] = normal.dot(vertices[face.vertexIndices[0]!]!);
  }
  placed.edgesPlaced = false;
  placed.origin.copy(pose.position);
}

/** `placed`, its edges' arcs and vectors worked out for its pose if they aren't yet. */
export function withEdges(placed: PlacedHull): PlacedHull {
  if (placed.edgesPlaced) return placed;
  const { hull, vertices, normals, edgeArcs, edgeVectors, arcData } = placed;
  const edgeFaces = hull.edgeFaces;
  const edges = hull.edges;
  for (let index = 0; index < edges.length; index++) {
    const [face, otherFace] = edgeFaces[index]!;
    store(edgeArcs[index]!.crossVectors(normals[otherFace]!, normals[face]!), arcData, index * 3);
    const [tail, head] = edges[index]!;
    edgeVectors[index]!.subVectors(vertices[head]!, vertices[tail]!);
  }
  placed.edgesPlaced = true;
  return placed;
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

/**
 * The face of `placed` that `other` stays furthest outside of, and how far (negative when it
 * reaches through); undefined if one leaves it more than `margin` outside, which separates them.
 * Each face's deepest vertex of `other` is found by walking from vertex to neighbouring vertex
 * while they go deeper, from where the face before's walk ended: on a convex hull a vertex deeper
 * than none of its neighbours is the deepest of all.
 */
function bestFace(placed: PlacedHull, other: PlacedHull, margin: number): { index: number; separation: number } | undefined {
  const normals = placed.normalData;
  const vertices = other.vertexData;
  const { neighbourStarts, neighbours } = tablesOf(other.hull);
  let bestIndex = -1;
  let bestSeparation = -Infinity;
  let vertex = 0;
  for (let index = 0; index < placed.offsets.length; index++) {
    const normalX = normals[index * 3]!;
    const normalY = normals[index * 3 + 1]!;
    const normalZ = normals[index * 3 + 2]!;
    let deepest = normalX * vertices[vertex * 3]! + normalY * vertices[vertex * 3 + 1]! + normalZ * vertices[vertex * 3 + 2]!;
    for (let moved = true; moved; ) {
      moved = false;
      for (let at = neighbourStarts[vertex]!, end = neighbourStarts[vertex + 1]!; at < end; at++) {
        const neighbour = neighbours[at]!;
        const depth = normalX * vertices[neighbour * 3]! + normalY * vertices[neighbour * 3 + 1]! + normalZ * vertices[neighbour * 3 + 2]!;
        if (depth < deepest) {
          deepest = depth;
          vertex = neighbour;
          moved = true;
        }
      }
    }
    const separation = deepest - placed.offsets[index]!;
    if (separation > margin) return undefined;
    if (separation > bestSeparation) {
      bestSeparation = separation;
      bestIndex = index;
    }
  }
  return { index: bestIndex, separation: bestSeparation };
}

interface EdgeAxis {
  /** Unit axis from A toward B. */
  axis: Vector3;
  /** The two touching edges, as segment ends in world space, and which of each hull's edges they are. */
  edgeA: [Vector3, Vector3];
  edgeB: [Vector3, Vector3];
  indexA: number;
  indexB: number;
  separation: number;
}

const candidateAxis = new Vector3();
const offsetScratch = new Vector3();
/** The edges each hull's search looks at. */
let keptScratchA: Int32Array = new Int32Array(64);
let keptScratchB: Int32Array = new Int32Array(64);
const towardEdge = new Vector3();

/**
 * The edges of `placed` that come within `reach` of the sphere round `other`, which holds all of
 * it; all of them when `reach` is undefined. Into `indices`, grown if it must be.
 */
function edgesNear(placed: PlacedHull, other: PlacedHull, reach: number | undefined, indices: Int32Array): { indices: Int32Array; count: number } {
  const edgeCount = placed.edgeVectors.length;
  if (indices.length < edgeCount) indices = new Int32Array(edgeCount * 2);
  let count = 0;
  const within = reach === undefined ? Infinity : other.hull.boundingRadius + reach;
  for (let index = 0; index < edgeCount; index++) {
    if (within !== Infinity) {
      // the point of the edge nearest the other's sphere's centre
      const start = placed.edgeStarts[index]!;
      const vector = placed.edgeVectors[index]!;
      towardEdge.subVectors(other.origin, start);
      const share = Math.min(Math.max(towardEdge.dot(vector) / vector.lengthSq(), 0), 1);
      towardEdge.addScaledVector(vector, -share);
      if (towardEdge.lengthSq() > within * within) continue;
    }
    indices[count++] = index;
  }
  return { indices, count };
}

/**
 * The edge pair whose cross product separates the hulls best. Only edge pairs that form a face of
 * the Minkowski difference can separate them (Gregorius, "The Separating Axis Test between Convex
 * Polyhedra", GDC 2013): seen as arcs between their faces' normals on the unit sphere, with B's
 * normals negated, the two arcs must cross.
 */
function bestEdgeAxis(hullA: PlacedHull, hullB: PlacedHull, margin: number, reach?: number): EdgeAxis | undefined | null {
  withEdges(hullA);
  withEdges(hullB);
  let best: EdgeAxis | undefined;
  const facesA = tablesOf(hullA.hull).edgeFaces;
  const facesB = tablesOf(hullB.hull).edgeFaces;
  const normalsA = hullA.normalData;
  const normalsB = hullB.normalData;
  const arcsA = hullA.arcData;
  const arcsB = hullB.arcData;
  // the edges near enough the other hull to matter, or all of them
  const keptA = edgesNear(hullA, hullB, reach, keptScratchA);
  const keptB = edgesNear(hullB, hullA, reach, keptScratchB);
  keptScratchA = keptA.indices;
  keptScratchB = keptB.indices;
  for (let atA = 0; atA < keptA.count; atA++) {
    const indexA = keptA.indices[atA]!;
    const arcX = arcsA[indexA * 3]!;
    const arcY = arcsA[indexA * 3 + 1]!;
    const arcZ = arcsA[indexA * 3 + 2]!;
    const faceA = facesA[indexA * 2]! * 3;
    const otherFaceA = facesA[indexA * 2 + 1]! * 3;
    for (let atB = 0; atB < keptB.count; atB++) {
      const indexB = keptB.indices[atB]!;
      const faceB = facesB[indexB * 2]! * 3;
      const otherFaceB = facesB[indexB * 2 + 1]! * 3;
      const normalBAcrossA = normalsB[faceB]! * arcX + normalsB[faceB + 1]! * arcY + normalsB[faceB + 2]! * arcZ;
      const otherNormalBAcrossA = normalsB[otherFaceB]! * arcX + normalsB[otherFaceB + 1]! * arcY + normalsB[otherFaceB + 2]! * arcZ;
      if (normalBAcrossA * otherNormalBAcrossA >= 0) continue;
      const arcBX = arcsB[indexB * 3]!;
      const arcBY = arcsB[indexB * 3 + 1]!;
      const arcBZ = arcsB[indexB * 3 + 2]!;
      const normalAAcrossB = normalsA[faceA]! * arcBX + normalsA[faceA + 1]! * arcBY + normalsA[faceA + 2]! * arcBZ;
      const otherNormalAAcrossB = normalsA[otherFaceA]! * arcBX + normalsA[otherFaceA + 1]! * arcBY + normalsA[otherFaceA + 2]! * arcBZ;
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
          edgeA: [startA.clone(), startA.clone().add(vectorA)],
          edgeB: [startB.clone(), startB.clone().add(vectorB)],
          indexA,
          indexB,
          separation,
        };
      }
    }
  }
  return best;
}

/** What decides two hulls' contacts: that they are apart, a face of one of them, a pair of edges, or, a little apart, their nearest points. */
type Decision = { kind: 'apart' } | { kind: 'faceOfA'; face: number } | { kind: 'faceOfB'; face: number } | { kind: 'edges'; edgeA: number; edgeB: number } | { kind: 'nearest' };

/**
 * A pair's decision, kept with how B was posed in A's frame when it was made and the margin it
 * was made with: finding it is most of what two hulls touching cost, and from one step to the
 * next it is mostly the same. While no point of B has moved more than a few millimetres in A's
 * frame since, turning included (a turn of a degree moves the surface of a hull half a metre
 * across by nearly a centimetre), and the margin is no greater than a little over, it stands, and only the
 * contacts are found again from it, where the hulls are now: the same points as finding it again
 * would give, but where it would have changed in the meantime.
 */
interface KeptDecision {
  hullA: ConvexCollider;
  hullB: ConvexCollider;
  position: Vector3;
  quaternion: Quaternion;
  margin: number;
  decision: Decision;
}

/**
 * How far any point of B may move in A's frame, in metres, before the decision is made again: a
 * contact's depth then differs from a fresh decision's by under a millimetre, as random pairs
 * moving slowly against each other show, where they differ at all (one step in a hundred).
 */
const MOST_MOVE = 0.003;
const MARGIN_ALLOWANCE = 0.001;

/** Each pair of bodies' kept decisions, by the hulls on them. */
const keptDecisions = new WeakMap<object, WeakMap<object, KeptDecision[]>>();
const inverseTurnA = new Quaternion();
const relativePosition = new Vector3();
const relativeQuaternion = new Quaternion();

/** B's pose in A's frame, into `relativePosition` and `relativeQuaternion`. */
function relativePose(poseA: ColliderPose, poseB: ColliderPose): void {
  inverseTurnA.copy(poseA.quaternion).invert();
  relativePosition.subVectors(poseB.position, poseA.position).applyQuaternion(inverseTurnA);
  relativeQuaternion.multiplyQuaternions(inverseTurnA, poseB.quaternion);
}

/**
 * Contacts between two hulls on bodies: by the pair's decision while it stands, or by deciding
 * afresh, and keeping the decision. Poses of no body's are decided afresh each time.
 */
function hullContacts(hullA: PlacedHull, poseA: ColliderPose, hullB: PlacedHull, poseB: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const ownerA = poseA.owner;
  const ownerB = poseB.owner;
  if (!ownerA || !ownerB) {
    contactsBy(decide(hullA, hullB, margin), hullA, hullB, contacts, margin);
    return;
  }
  let byB = keptDecisions.get(ownerA);
  if (!byB) {
    byB = new WeakMap();
    keptDecisions.set(ownerA, byB);
  }
  let pairs = byB.get(ownerB);
  if (!pairs) {
    pairs = [];
    byB.set(ownerB, pairs);
  }
  let kept = pairs.find((pair) => pair.hullA === hullA.hull && pair.hullB === hullB.hull);
  relativePose(poseA, poseB);
  if (kept && margin <= kept.margin + MARGIN_ALLOWANCE && movedSince(kept, hullB) <= MOST_MOVE && contactsBy(kept.decision, hullA, hullB, contacts, margin)) return;
  const decision = decide(hullA, hullB, margin);
  contactsBy(decision, hullA, hullB, contacts, margin);
  if (!kept) {
    kept = { hullA: hullA.hull, hullB: hullB.hull, position: new Vector3(), quaternion: new Quaternion(), margin, decision };
    pairs.push(kept);
  }
  kept.position.copy(relativePosition);
  kept.quaternion.copy(relativeQuaternion);
  kept.margin = margin;
  kept.decision = decision;
}

/**
 * How far any point of B could have moved in A's frame since `kept` was decided, at most: its
 * origin's move, and its turn's about the origin at the furthest of it (a turn of θ moves a point
 * r out by 2 r sin(θ/2)). A stays where it is in its own frame.
 */
function movedSince(kept: KeptDecision, hullB: PlacedHull): number {
  const alignment = Math.min(Math.abs(relativeQuaternion.dot(kept.quaternion)), 1);
  const halfTurnSine = Math.sqrt(1 - alignment * alignment);
  return relativePosition.distanceTo(kept.position) + 2 * halfTurnSine * hullB.hull.boundingRadius;
}

/** Separating-axis test between two hulls: what decides their contacts. */
function decide(hullA: PlacedHull, hullB: PlacedHull, margin: number): Decision {
  const reach = hullA.hull.boundingRadius + hullB.hull.boundingRadius + margin;
  if (hullA.origin.distanceToSquared(hullB.origin) > reach * reach) return { kind: 'apart' };
  // their distance first: further apart than the margin, no face can say otherwise
  const gap = hullGap(hullA, hullB);
  if (gap > margin) return { kind: 'apart' };
  const faceOfA = bestFace(hullA, hullB, margin);
  if (!faceOfA) return { kind: 'apart' };
  const faceOfB = bestFace(hullB, hullA, margin);
  if (!faceOfB) return { kind: 'apart' };
  const faceSeparationBest = Math.max(faceOfA.separation, faceOfB.separation);
  // The hulls' distance, by GJK, decides what is left to find:
  // - further apart than the margin, they are apart, whatever the faces' separations say: along
  //   no axis can they be further apart than they are, and along some they are less;
  // - overlapping, the edges that decide it, if edges do, are within the overlap of each other:
  //   the nearest face of the hulls' Minkowski difference to the origin holds the origin's foot,
  //   and an edge pair's face is the differences of the two edges' points. The overlap is no more
  //   than the faces' least, so the edge search can leave out every edge further than that from
  //   the other hull's bounding sphere and find what searching them all would;
  // - apart within the margin, no edge pair separates them by more than their distance either: if
  //   that is within the faces' separation and preference, a face decides it; if not, their
  //   nearest points, which GJK has found, as Rapier takes them.
  const preference = edgePreference(hullA, hullB);
  let edge: EdgeAxis | undefined | null;
  if (gap === 0 && faceSeparationBest < 0) edge = bestEdgeAxis(hullA, hullB, margin, -faceSeparationBest * (1 + 1e-9) + 1e-12);
  else if (gap <= faceSeparationBest + preference) edge = undefined;
  else return { kind: 'nearest' };
  if (edge === null) return { kind: 'apart' };
  // Prefer faces: they give a whole patch of contacts, which keeps resting bodies steady.
  if (edge && edge.separation > faceSeparationBest + preference) return { kind: 'edges', edgeA: edge.indexA, edgeB: edge.indexB };
  return faceOfA.separation >= faceOfB.separation ? { kind: 'faceOfA', face: faceOfA.index } : { kind: 'faceOfB', face: faceOfB.index };
}

/** How much more than the faces' an edge pair's separation must be for its contact to be taken. */
function edgePreference(hullA: PlacedHull, hullB: PlacedHull): number {
  return 0.01 * Math.min(hullA.hull.boundingRadius, hullB.hull.boundingRadius);
}

/** The contacts `decision` gives the hulls where they are now; false if it no longer gives any, as two edges come to lie parallel. */
function contactsBy(decision: Decision, hullA: PlacedHull, hullB: PlacedHull, contacts: ContactPoint[], margin: number): boolean {
  switch (decision.kind) {
    case 'apart':
      return true;
    case 'faceOfA':
    case 'faceOfB': {
      // a face that no longer gives a point: decided again, rather than the hulls let pass
      const before = contacts.length;
      if (decision.kind === 'faceOfA') faceContacts(hullA, decision.face, hullB, true, contacts, margin);
      else faceContacts(hullB, decision.face, hullA, false, contacts, margin);
      return contacts.length > before;
    }
    case 'nearest': {
      // still apart within the margin, the one point where they are nearest
      const between = shapeDistance(supportOf(hullA), supportOf(hullB));
      if (between.overlapping || between.distance > margin) return false;
      contacts.push({ pointA: between.pointA, pointB: between.pointB, normal: between.normal, depth: -between.distance });
      return true;
    }
    case 'edges': {
      // only while their arcs still cross: else the axis across them separates nothing
      if (!edgesFaceEachOther(hullA, hullB, decision.edgeA, decision.edgeB)) return false;
      const edge = edgeAxisOf(hullA, hullB, decision.edgeA, decision.edgeB);
      if (!edge) return false;
      if (edge.separation <= margin) edgeContact(edge, contacts);
      return true;
    }
  }
}

/** Whether edge `indexA` of A and `indexB` of B make a face of the hulls' Minkowski difference, as the edge search asks: their arcs cross. */
function edgesFaceEachOther(hullA: PlacedHull, hullB: PlacedHull, indexA: number, indexB: number): boolean {
  withEdges(hullA);
  withEdges(hullB);
  const [faceA, otherFaceA] = hullA.hull.edgeFaces[indexA]!;
  const [faceB, otherFaceB] = hullB.hull.edgeFaces[indexB]!;
  const arcA = hullA.edgeArcs[indexA]!;
  const arcB = hullB.edgeArcs[indexB]!;
  const normalBAcrossA = hullB.normals[faceB]!.dot(arcA);
  const otherNormalBAcrossA = hullB.normals[otherFaceB]!.dot(arcA);
  const normalAAcrossB = hullA.normals[faceA]!.dot(arcB);
  const otherNormalAAcrossB = hullA.normals[otherFaceA]!.dot(arcB);
  return normalBAcrossA * otherNormalBAcrossA < 0 && normalAAcrossB * otherNormalAAcrossB < 0 && normalBAcrossA * otherNormalAAcrossB < 0;
}

/** The axis across edge `indexA` of A and `indexB` of B, as the edge search makes it; undefined if they are parallel. */
function edgeAxisOf(hullA: PlacedHull, hullB: PlacedHull, indexA: number, indexB: number): EdgeAxis | undefined {
  withEdges(hullA);
  withEdges(hullB);
  const vectorA = hullA.edgeVectors[indexA]!;
  const vectorB = hullB.edgeVectors[indexB]!;
  const axis = new Vector3().crossVectors(vectorA, vectorB);
  const length = axis.length();
  if (length < 1e-6 * vectorA.length() * vectorB.length()) return undefined;
  axis.divideScalar(length);
  const startA = hullA.edgeStarts[indexA]!;
  const startB = hullB.edgeStarts[indexB]!;
  if (axis.dot(offsetScratch.subVectors(startA, hullA.center)) < 0) axis.negate();
  return { axis, edgeA: [startA.clone(), startA.clone().add(vectorA)], edgeB: [startB.clone(), startB.clone().add(vectorB)], indexA, indexB, separation: axis.dot(offsetScratch.subVectors(startB, startA)) };
}

/** A placed hull as GJK sees it: the vertex furthest along a direction. */
function supportOf(placed: PlacedHull): SupportShape {
  const vertices = placed.vertexData;
  return {
    center: placed.center,
    radius: 0,
    support: (direction, target) => {
      let best = 0;
      let bestReach = -Infinity;
      for (let index = 0; index < vertices.length; index += 3) {
        const reach = vertices[index]! * direction.x + vertices[index + 1]! * direction.y + vertices[index + 2]! * direction.z;
        if (reach > bestReach) {
          bestReach = reach;
          best = index;
        }
      }
      return target.set(vertices[best]!, vertices[best + 1]!, vertices[best + 2]!);
    },
  };
}

/** The distance between two placed hulls, by GJK: 0 when they overlap. */
function hullGap(hullA: PlacedHull, hullB: PlacedHull): number {
  const between = shapeDistance(supportOf(hullA), supportOf(hullB));
  return between.overlapping ? 0 : between.distance;
}

/**
 * The incident face's corners as they are clipped, side plane by side plane, from one pool into
 * the other: a cylinder's end against another's is clipped sixteen times, and nothing in between
 * need be new.
 */
let clipPool: Vector3[] = [];
let clipOtherPool: Vector3[] = [];
const sideNormal = new Vector3();

function faceContacts(reference: PlacedHull, faceIndex: number, incident: PlacedHull, referenceIsA: boolean, contacts: ContactPoint[], margin: number): void {
  const referenceNormal = reference.normals[faceIndex]!;
  const referenceOffset = reference.offsets[faceIndex]!;
  const referenceIndices = reference.hull.faces[faceIndex]!.vertexIndices;

  // The incident face is the one facing most against the reference normal.
  let incidentFace = 0;
  for (let index = 1; index < incident.normals.length; index++) {
    if (incident.normals[index]!.dot(referenceNormal) < incident.normals[incidentFace]!.dot(referenceNormal)) incidentFace = index;
  }
  const incidentIndices = incident.hull.faces[incidentFace]!.vertexIndices;
  // each side plane can add at most one corner
  const room = incidentIndices.length + referenceIndices.length;
  while (clipPool.length < room) clipPool.push(new Vector3());
  while (clipOtherPool.length < room) clipOtherPool.push(new Vector3());
  let polygon = clipPool;
  let other = clipOtherPool;
  let count = incidentIndices.length;
  for (let index = 0; index < count; index++) polygon[index]!.copy(incident.vertices[incidentIndices[index]!]!);

  // Clip it to the side planes through the reference face's edges.
  for (let position = 0; position < referenceIndices.length; position++) {
    const corner = reference.vertices[referenceIndices[position]!]!;
    const next = reference.vertices[referenceIndices[(position + 1) % referenceIndices.length]!]!;
    sideNormal.subVectors(next, corner).cross(referenceNormal).normalize();
    count = clipInto(polygon, count, sideNormal, sideNormal.dot(corner), other);
    [polygon, other] = [other, polygon];
  }

  const normalFromBToA = referenceIsA ? referenceNormal.clone().negate() : referenceNormal.clone();
  const patch: ContactPoint[] = [];
  for (let index = 0; index < count; index++) {
    const point = polygon[index]!;
    const separation = referenceNormal.dot(point) - referenceOffset;
    if (separation > margin) continue;
    const onReference = point.clone().addScaledVector(referenceNormal, -separation);
    patch.push(
      referenceIsA
        ? { pointA: onReference, pointB: point.clone(), normal: normalFromBToA.clone(), depth: -separation }
        : { pointA: point.clone(), pointB: onReference, normal: normalFromBToA.clone(), depth: -separation },
    );
  }
  reduceManifold(patch, FACE_PATCH_POINTS);
  for (const contact of patch) contacts.push(contact);
  // the pools are module-wide, and the polygon may have ended in either
  clipPool = polygon;
  clipOtherPool = other;
}

/** Sutherland–Hodgman, as `clipPolygon` in narrowphase.ts, from the first `count` corners of `polygon` into `target`'s vectors: the number of corners kept. */
function clipInto(polygon: readonly Vector3[], count: number, normal: Vector3, offset: number, target: Vector3[]): number {
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
  hullContacts(place(colliderA, poseA), poseA, place(colliderB, poseB), poseB, contacts, margin);
}

function boxConvex(box: BoxCollider, boxPose: ColliderPose, convex: ConvexCollider, convexPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  hullContacts(place(hullOfBox(box), boxPose), boxPose, place(convex, convexPose), convexPose, contacts, margin);
}

const cornerScratch = new Vector3();

function convexPlane(convex: ConvexCollider, convexPose: ColliderPose, plane: PlaneCollider, planePose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const normal = plane.normal(planePose);
  const planeHeight = normal.dot(planePose.position);
  for (const vertex of convex.vertices) {
    const corner = cornerScratch.copy(vertex).applyMatrix3(convexPose.rotation).add(convexPose.position);
    const height = normal.dot(corner) - planeHeight;
    if (height >= margin) continue;
    contacts.push({ pointA: corner.clone(), pointB: corner.clone().addScaledVector(normal, -height), normal: normal.clone(), depth: -height });
  }
}

export function sphereConvex(sphere: SphereCollider, spherePose: ColliderPose, convex: ConvexCollider, convexPose: ColliderPose, contacts: ContactPoint[], margin: number): void {
  const placed = place(convex, convexPose);
  const { normals, offsets, vertices } = placed;
  const center = spherePose.position;
  let outermost = 0;
  for (let index = 1; index < normals.length; index++) {
    if (normals[index]!.dot(center) - offsets[index]! > normals[outermost]!.dot(center) - offsets[outermost]!) outermost = index;
  }
  const outermostDistance = normals[outermost]!.dot(center) - offsets[outermost]!;

  if (outermostDistance <= 0) {
    // centre inside the hull: push it out through the nearest face
    const normal = normals[outermost]!.clone();
    contacts.push({
      pointA: center.clone().addScaledVector(normal, -sphere.radius),
      pointB: center.clone().addScaledVector(normal, -outermostDistance),
      normal,
      depth: sphere.radius - outermostDistance,
    });
    return;
  }
  // No point of the hull is nearer the centre than the plane of a face the centre is in front of:
  // a sphere further than its radius and the margin from one doesn't touch, as most near a rock don't.
  if (outermostDistance >= sphere.radius + margin) return;

  // centre outside: the nearest point on any face it is in front of, leaving out the faces whose
  // planes alone are further than the nearest point found yet
  let nearestDistance = Infinity;
  const faces = placed.hull.faces;
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const planeDistance = normals[faceIndex]!.dot(center) - offsets[faceIndex]!;
    if (planeDistance <= 0 || planeDistance > nearestDistance) continue;
    const corners = faces[faceIndex]!.vertexIndices;
    const first = vertices[corners[0]!]!;
    for (let corner = 1; corner + 1 < corners.length; corner++) {
      closestPointOnTriangleInto(center, first, vertices[corners[corner]!]!, vertices[corners[corner + 1]!]!, candidatePoint);
      const distance = candidatePoint.distanceTo(center);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPoint.copy(candidatePoint);
      }
    }
  }
  if (nearestDistance === Infinity || nearestDistance >= sphere.radius + margin || nearestDistance < 1e-12) return;
  const normal = new Vector3().subVectors(center, nearestPoint).divideScalar(nearestDistance);
  contacts.push({ pointA: center.clone().addScaledVector(normal, -sphere.radius), pointB: nearestPoint.clone(), normal, depth: sphere.radius - nearestDistance });
}

const candidatePoint = new Vector3();
const nearestPoint = new Vector3();
const edgeFirstSecond = new Vector3();
const edgeFirstThird = new Vector3();
const fromFirst = new Vector3();
const fromSecond = new Vector3();
const fromThird = new Vector3();
const edgeSecondThird = new Vector3();

/** Closest point of triangle (first, second, third) to `point` (Ericson, Real-Time Collision Detection, 5.1.5). */
export function closestPointOnTriangle(point: Vector3, first: Vector3, second: Vector3, third: Vector3): Vector3 {
  return closestPointOnTriangleInto(point, first, second, third, new Vector3());
}

/** `closestPointOnTriangle`, written into `target`. */
function closestPointOnTriangleInto(point: Vector3, first: Vector3, second: Vector3, third: Vector3, target: Vector3): Vector3 {
  edgeFirstSecond.subVectors(second, first);
  edgeFirstThird.subVectors(third, first);
  fromFirst.subVectors(point, first);
  const firstAlongSecond = edgeFirstSecond.dot(fromFirst);
  const firstAlongThird = edgeFirstThird.dot(fromFirst);
  if (firstAlongSecond <= 0 && firstAlongThird <= 0) return target.copy(first);

  fromSecond.subVectors(point, second);
  const secondAlongSecond = edgeFirstSecond.dot(fromSecond);
  const secondAlongThird = edgeFirstThird.dot(fromSecond);
  if (secondAlongSecond >= 0 && secondAlongThird <= secondAlongSecond) return target.copy(second);

  const regionFirstSecond = firstAlongSecond * secondAlongThird - secondAlongSecond * firstAlongThird;
  if (regionFirstSecond <= 0 && firstAlongSecond >= 0 && secondAlongSecond <= 0) {
    return target.copy(first).addScaledVector(edgeFirstSecond, firstAlongSecond / (firstAlongSecond - secondAlongSecond));
  }

  fromThird.subVectors(point, third);
  const thirdAlongSecond = edgeFirstSecond.dot(fromThird);
  const thirdAlongThird = edgeFirstThird.dot(fromThird);
  if (thirdAlongThird >= 0 && thirdAlongSecond <= thirdAlongThird) return target.copy(third);

  const regionFirstThird = thirdAlongSecond * firstAlongThird - firstAlongSecond * thirdAlongThird;
  if (regionFirstThird <= 0 && firstAlongThird >= 0 && thirdAlongThird <= 0) {
    return target.copy(first).addScaledVector(edgeFirstThird, firstAlongThird / (firstAlongThird - thirdAlongThird));
  }

  const regionSecondThird = secondAlongSecond * thirdAlongThird - thirdAlongSecond * secondAlongThird;
  if (regionSecondThird <= 0 && secondAlongThird - secondAlongSecond >= 0 && thirdAlongSecond - thirdAlongThird >= 0) {
    const share = (secondAlongThird - secondAlongSecond) / (secondAlongThird - secondAlongSecond + (thirdAlongSecond - thirdAlongThird));
    return target.copy(second).addScaledVector(edgeSecondThird.subVectors(third, second), share);
  }

  const total = 1 / (regionSecondThird + regionFirstThird + regionFirstSecond);
  return target.copy(first).addScaledVector(edgeFirstSecond, regionFirstThird * total).addScaledVector(edgeFirstThird, regionFirstSecond * total);
}

/** Registers the convex hull collision tests. Called by the collision system; safe to call again. */
export function registerConvexCollisionTests(): void {
  registerCollisionTest('convex', 'convex', convexConvex);
  registerCollisionTest('box', 'convex', boxConvex);
  registerCollisionTest('convex', 'plane', convexPlane);
  registerCollisionTest('sphere', 'convex', sphereConvex);
}
