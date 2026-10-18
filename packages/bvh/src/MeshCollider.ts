import { Box3, DoubleSide, Matrix3, Ray, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { Collider } from 'eulerjs';
import type { ColliderOptions, ColliderPose } from 'eulerjs';
import { registerRayTest, registerTriangleShape } from 'eulerjs/extend';
import type { SweepHit, TriangleVisitor } from 'eulerjs/extend';

export interface MeshColliderOptions extends ColliderOptions {
  /** The triangles, in the collider's frame. Copied, so later changes to it don't reach the collider. */
  geometry: BufferGeometry;
}

/** Neighbouring triangles closer to flat than this, as the cosine of the angle between their normals, share an edge that never pushes on its own. */
const FLAT_EDGE_COSINE = Math.cos((5 * Math.PI) / 180);

/**
 * Any triangle mesh as a collider, such as a level, a building or a rock face, found quickly with
 * a bounding volume tree (three-mesh-bvh). Both sides of every triangle are solid, so it needn't
 * be closed. Only for static and kinematic bodies: it has no volume to give a mass.
 */
export class MeshCollider extends Collider {
  readonly shape = 'mesh';
  readonly geometry: BufferGeometry;
  readonly bvh: MeshBVH;
  /** For each triangle, by the tree's numbering, bit k set when its edge from corner k to the next may push on its own. */
  readonly activeEdges: Uint8Array;
  private readonly localBounds = new Box3();
  private readonly radius: number;

  constructor(options: MeshColliderOptions) {
    super(options);
    registerMeshShape();
    this.geometry = options.geometry.clone();
    if (!this.geometry.getAttribute('position')) throw new RangeError('A mesh collider needs a geometry with positions');
    this.bvh = new MeshBVH(this.geometry);
    this.bvh.getBoundingBox(this.localBounds);
    const positions = this.geometry.getAttribute('position');
    let radius = 0;
    for (let index = 0; index < positions.count; index++) radius = Math.max(radius, Math.hypot(positions.getX(index), positions.getY(index), positions.getZ(index)));
    this.radius = radius;
    this.activeEdges = findActiveEdges(this.geometry);
  }

  get boundingRadius(): number {
    return this.radius;
  }

  get triangleCount(): number {
    return this.activeEdges.length;
  }

  /** The triangles in the collider's frame, e.g. to draw it: a copy of its geometry. */
  toGeometry(): BufferGeometry {
    return this.geometry.clone();
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    target.makeEmpty();
    for (const cornerX of [this.localBounds.min.x, this.localBounds.max.x]) {
      for (const cornerY of [this.localBounds.min.y, this.localBounds.max.y]) {
        for (const cornerZ of [this.localBounds.min.z, this.localBounds.max.z]) target.expandByPoint(corner.set(cornerX, cornerY, cornerZ).applyMatrix3(pose.rotation).add(pose.position));
      }
    }
    return target;
  }

  massProperties(): undefined {
    return undefined;
  }
}

const corner = new Vector3();
const localRegion = new Box3();
const inverseRotation = new Matrix3();
const worldCorners = [new Vector3(), new Vector3(), new Vector3()] as const;
const localRay = new Ray();

let registered = false;

/** Teaches the engine meshes, the first time one is made. */
function registerMeshShape(): void {
  if (registered) return;
  registered = true;
  registerTriangleShape<MeshCollider>('mesh', { forEachTriangle, oneSided: false });
  registerRayTest<MeshCollider>('mesh', castRay);
}

/** The triangles in a region of world space, through the tree. */
function forEachTriangle(mesh: MeshCollider, pose: ColliderPose, region: Box3, visit: TriangleVisitor): void {
  inverseRotation.copy(pose.rotation).transpose();
  localRegion.makeEmpty();
  for (const cornerX of [region.min.x, region.max.x]) {
    for (const cornerY of [region.min.y, region.max.y]) {
      for (const cornerZ of [region.min.z, region.max.z]) localRegion.expandByPoint(corner.set(cornerX, cornerY, cornerZ).sub(pose.position).applyMatrix3(inverseRotation));
    }
  }
  mesh.bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(localRegion),
    intersectsTriangle: (triangle, triangleIndex) => {
      const [first, second, third] = worldCorners;
      first.copy(triangle.a).applyMatrix3(pose.rotation).add(pose.position);
      second.copy(triangle.b).applyMatrix3(pose.rotation).add(pose.position);
      third.copy(triangle.c).applyMatrix3(pose.rotation).add(pose.position);
      visit(first, second, third, mesh.activeEdges[triangleIndex]!);
      return false;
    },
  });
}

/** A ray against the tree, in the mesh's frame, where distances are the same as in the world's. */
function castRay(mesh: MeshCollider, pose: ColliderPose, origin: Vector3, direction: Vector3, maxDistance: number): SweepHit | undefined {
  inverseRotation.copy(pose.rotation).transpose();
  localRay.origin.copy(origin).sub(pose.position).applyMatrix3(inverseRotation);
  localRay.direction.copy(direction).applyMatrix3(inverseRotation);
  const hit = mesh.bvh.raycastFirst(localRay, DoubleSide, 0, maxDistance);
  if (!hit?.face) return undefined;
  const normal = hit.face.normal.clone().applyMatrix3(pose.rotation);
  if (normal.dot(direction) > 0) normal.negate();
  return { distance: hit.distance, point: origin.clone().addScaledVector(direction, hit.distance), normal };
}

/**
 * Which edges of each triangle may push on their own: those on the mesh's border or between
 * triangles at an angle. An edge between two nearly flat neighbours is covered by their faces,
 * and a contact on it would only be a ghost catching whatever slides across.
 */
function findActiveEdges(geometry: BufferGeometry): Uint8Array {
  const positions = geometry.getAttribute('position');
  const index = geometry.index;
  const triangleCount = (index ? index.count : positions.count) / 3;
  const cornerOf = (triangle: number, corner: number) => (index ? index.getX(3 * triangle + corner) : 3 * triangle + corner);
  // weld corners by position, since a mesh often repeats a vertex for each normal or texture seam
  const size = new Box3().setFromBufferAttribute(positions as never).getSize(new Vector3()).length() || 1;
  const quantum = size * 1e-6;
  const weldedIds = new Map<string, number>();
  const welded = new Int32Array(positions.count);
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const key = `${Math.round(positions.getX(vertex) / quantum)},${Math.round(positions.getY(vertex) / quantum)},${Math.round(positions.getZ(vertex) / quantum)}`;
    let id = weldedIds.get(key);
    if (id === undefined) weldedIds.set(key, (id = weldedIds.size));
    welded[vertex] = id;
  }
  const normals: Vector3[] = [];
  const edgeTriangles = new Map<string, number[]>();
  const point = (vertex: number) => new Vector3(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex));
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const [first, second, third] = [0, 1, 2].map((corner) => point(cornerOf(triangle, corner)));
    normals.push(new Vector3().subVectors(second!, first!).cross(new Vector3().subVectors(third!, first!)).normalize());
    for (let edge = 0; edge < 3; edge++) {
      const start = welded[cornerOf(triangle, edge)]!;
      const end = welded[cornerOf(triangle, (edge + 1) % 3)]!;
      const key = start < end ? `${start}:${end}` : `${end}:${start}`;
      const list = edgeTriangles.get(key);
      if (list) list.push(triangle);
      else edgeTriangles.set(key, [triangle]);
    }
  }
  const active = new Uint8Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    let mask = 0;
    for (let edge = 0; edge < 3; edge++) {
      const start = welded[cornerOf(triangle, edge)]!;
      const end = welded[cornerOf(triangle, (edge + 1) % 3)]!;
      const sharing = edgeTriangles.get(start < end ? `${start}:${end}` : `${end}:${start}`)!;
      const neighbours = sharing.filter((other) => other !== triangle);
      // both sides of a mesh are solid, so only flat folds are covered by the faces either side, whichever way they are wound
      const flat = neighbours.length === 1 && Math.abs(normals[triangle]!.dot(normals[neighbours[0]!]!)) > FLAT_EDGE_COSINE;
      if (!flat) mask |= 1 << edge;
    }
    active[triangle] = mask;
  }
  return active;
}
