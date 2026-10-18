import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import type { Box3 } from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { InvalidMeshError } from '../errors.js';
import { forEachTriangle } from '../geometry.js';
import { MassProperties } from '../MassProperties.js';
import type { MassSpecification } from '../MassProperties.js';
import { Collider } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';

/** One flat face of a hull: its outward normal, its plane (normal · point = offset) and its corners, counter-clockwise from outside. */
export interface ConvexFace {
  readonly normal: Vector3;
  readonly offset: number;
  readonly vertexIndices: readonly number[];
}

export interface ConvexColliderOptions extends ColliderOptions {
  /** Points to wrap; the collider is their convex hull, in the collider's frame. */
  points: readonly Vector3[];
}

/** Faces whose normals are closer than this (1 - cosine) count as the same plane when merging. */
const COPLANAR_TOLERANCE = 1e-6;

/**
 * The convex hull of a set of points: any convex shape, such as a rock, a bevelled crate or the
 * hull of a model. Coplanar triangles are merged into one polygon face, so a box-shaped hull has
 * six square faces, which is what gives whole contact patches.
 */
export class ConvexCollider extends Collider {
  readonly shape = 'convex';
  readonly vertices: readonly Vector3[];
  readonly faces: readonly ConvexFace[];
  /** Each edge once, as a pair of vertex indices. */
  readonly edges: readonly (readonly [number, number])[];
  /** The two faces either side of each edge, by index into `faces`. */
  readonly edgeFaces: readonly (readonly [number, number])[];
  /** The edges' directions with parallel ones counted once: the edge axes collision tests need. */
  readonly edgeDirections: readonly Vector3[];
  private readonly radius: number;

  constructor(options: ConvexColliderOptions) {
    super(options);
    const hull = buildHull(options.points);
    this.vertices = hull.vertices;
    this.faces = hull.faces;
    this.edges = hull.edges;
    this.edgeFaces = hull.edgeFaces;
    this.edgeDirections = hull.edgeDirections;
    this.radius = Math.max(...this.vertices.map((vertex) => vertex.length()));
  }

  /** The hull of a geometry's vertices, in the geometry's frame. */
  static fromGeometry(geometry: BufferGeometry, options: ColliderOptions = {}): ConvexCollider {
    const points: Vector3[] = [];
    forEachTriangle(geometry, (first, second, third) => points.push(first.clone(), second.clone(), third.clone()));
    return new ConvexCollider({ ...options, points });
  }

  get boundingRadius(): number {
    return this.radius;
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    target.makeEmpty();
    for (const vertex of this.vertices) target.expandByPoint(cornerScratch.copy(vertex).applyMatrix3(pose.rotation).add(pose.position));
    return target;
  }

  /** Exact mass properties of the solid hull, in the body frame. */
  massProperties(specification: MassSpecification): MassProperties {
    const geometry = this.toGeometry().applyMatrix4(new Matrix4().compose(this.offset, this.rotation, new Vector3(1, 1, 1)));
    return MassProperties.fromMesh(geometry, specification);
  }

  /** The hull as triangles in the collider's frame, e.g. to draw it. */
  toGeometry(): BufferGeometry {
    const corners: number[] = [];
    for (const face of this.faces) {
      const [first, ...rest] = face.vertexIndices;
      for (let index = 0; index + 1 < rest.length; index++) {
        for (const vertexIndex of [first!, rest[index]!, rest[index + 1]!]) corners.push(...this.vertices[vertexIndex]!.toArray());
      }
    }
    return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(corners, 3));
  }
}

const cornerScratch = new Vector3();

interface HullData {
  vertices: Vector3[];
  faces: ConvexFace[];
  edges: [number, number][];
  edgeFaces: [number, number][];
  edgeDirections: Vector3[];
}

function buildHull(points: readonly Vector3[]): HullData {
  const hull = new ConvexHull().setFromPoints(points.map((point) => point.clone()));
  if (hull.faces.length < 4) throw new InvalidMeshError('A convex collider needs points that span a volume, not a line or a plane');

  // Number the hull's vertices.
  const vertexIndex = new Map<Vector3, number>();
  const vertices: Vector3[] = [];
  const indexOf = (point: Vector3): number => {
    let index = vertexIndex.get(point);
    if (index === undefined) {
      index = vertices.length;
      vertexIndex.set(point, index);
      vertices.push(point.clone());
    }
    return index;
  };

  // Group the triangles by the plane they lie in.
  type PlaneGroup = { normal: Vector3; offset: number; directedEdges: [number, number][] };
  const extent = Math.max(...points.map((point) => point.length()), 1e-9);
  const groups: PlaneGroup[] = [];
  for (const triangle of hull.faces) {
    const corners = [0, 1, 2].map((corner) => indexOf(triangle.getEdge(corner).head().point));
    const directedEdges = [0, 1, 2].map((corner) => [indexOf(triangle.getEdge(corner).tail().point), corners[corner]!] as [number, number]);
    const group = groups.find(
      (candidate) => 1 - candidate.normal.dot(triangle.normal) < COPLANAR_TOLERANCE && Math.abs(candidate.offset - triangle.constant) < COPLANAR_TOLERANCE * extent,
    );
    if (group) group.directedEdges.push(...directedEdges);
    else groups.push({ normal: triangle.normal.clone(), offset: triangle.constant, directedEdges });
  }

  // Each group's outline (edges whose reverse isn't in the group) is one polygon face.
  const faces: ConvexFace[] = groups.map(({ normal, directedEdges }) => {
    const inGroup = new Set(directedEdges.map(([tail, head]) => `${tail}>${head}`));
    const nextVertex = new Map<number, number>();
    for (const [tail, head] of directedEdges) {
      if (!inGroup.has(`${head}>${tail}`)) nextVertex.set(tail, head);
    }
    const start = nextVertex.keys().next().value!;
    const vertexIndices = [start];
    for (let current = nextVertex.get(start)!; current !== start; current = nextVertex.get(current)!) vertexIndices.push(current);
    return { normal, offset: normal.dot(vertices[start]!), vertexIndices };
  });

  // A flat set of points comes back as a two-sided sheet: no vertex is off the first face's plane.
  const firstFace = faces[0]!;
  const thickness = Math.max(...vertices.map((vertex) => Math.abs(firstFace.normal.dot(vertex) - firstFace.offset)));
  if (thickness < COPLANAR_TOLERANCE * extent) throw new InvalidMeshError('A convex collider needs points that span a volume, not a line or a plane');

  const edgeByKey = new Map<string, number>();
  const edges: [number, number][] = [];
  const edgeFaces: [number, number][] = [];
  const edgeDirections: Vector3[] = [];
  faces.forEach((face, faceIndex) => {
    face.vertexIndices.forEach((tail, position) => {
      const head = face.vertexIndices[(position + 1) % face.vertexIndices.length]!;
      const key = tail < head ? `${tail}:${head}` : `${head}:${tail}`;
      const existing = edgeByKey.get(key);
      if (existing !== undefined) {
        edgeFaces[existing]![1] = faceIndex;
        return;
      }
      edgeByKey.set(key, edges.length);
      edges.push([tail, head]);
      edgeFaces.push([faceIndex, faceIndex]);
      const direction = new Vector3().subVectors(vertices[head]!, vertices[tail]!).normalize();
      if (!edgeDirections.some((existing) => Math.abs(existing.dot(direction)) > 1 - COPLANAR_TOLERANCE)) edgeDirections.push(direction);
    });
  });
  return { vertices, faces, edges, edgeFaces, edgeDirections };
}
