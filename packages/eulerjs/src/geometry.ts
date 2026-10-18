import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { InvalidMeshError } from './errors.js';

export type TriangleVisitor = (first: Vector3, second: Vector3, third: Vector3) => void;

const firstCorner = new Vector3();
const secondCorner = new Vector3();
const thirdCorner = new Vector3();

/**
 * Calls `visit` once per triangle of an indexed or non-indexed geometry. The vectors passed to
 * `visit` are reused between calls, so copy them if they need to outlive the call.
 */
export function forEachTriangle(geometry: BufferGeometry, visit: TriangleVisitor): void {
  const positions = geometry.getAttribute('position');
  if (positions === undefined) {
    throw new InvalidMeshError('Geometry has no position attribute');
  }
  const index = geometry.getIndex();
  const cornerCount = index === null ? positions.count : index.count;
  if (cornerCount % 3 !== 0) {
    throw new InvalidMeshError(`Geometry has ${cornerCount} corners, which is not a whole number of triangles`);
  }
  const vertexAt = (corner: number) => (index === null ? corner : index.getX(corner));

  for (let corner = 0; corner < cornerCount; corner += 3) {
    firstCorner.fromBufferAttribute(positions, vertexAt(corner));
    secondCorner.fromBufferAttribute(positions, vertexAt(corner + 1));
    thirdCorner.fromBufferAttribute(positions, vertexAt(corner + 2));
    visit(firstCorner, secondCorner, thirdCorner);
  }
}

export interface MeshTopology {
  /** Triangles that keep three distinct corners when welded; those that collapse to a line or a point enclose nothing and are left out. */
  triangleCount: number;
  /** Edges used by exactly one triangle: holes in the surface. */
  boundaryEdgeCount: number;
  /** Edges shared by more than two triangles. */
  nonManifoldEdgeCount: number;
  /** True when every edge is shared by exactly two triangles, i.e. the mesh encloses a volume. */
  isClosed: boolean;
}

/**
 * Counts how many triangles share each edge after welding vertices closer than `weldTolerance`.
 * Welding snaps positions to a grid of that size, so two vertices that straddle a grid line can
 * stay unwelded; keep the tolerance well below the mesh's smallest edge. Triangles two of whose
 * corners weld together are left out: they enclose nothing, and older three.js cones have a ring
 * of them at the tip, which would otherwise share each edge there with two more triangles.
 */
export function analyzeTopology(geometry: BufferGeometry, weldTolerance = 1e-5): MeshTopology {
  const vertexIds = new Map<string, number>();
  const weldedId = (point: Vector3): number => {
    const key = `${Math.round(point.x / weldTolerance)},${Math.round(point.y / weldTolerance)},${Math.round(point.z / weldTolerance)}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vertexIds.size;
      vertexIds.set(key, id);
    }
    return id;
  };

  const edgeUseCounts = new Map<string, number>();
  const countEdge = (start: number, end: number) => {
    const key = start < end ? `${start}:${end}` : `${end}:${start}`;
    edgeUseCounts.set(key, (edgeUseCounts.get(key) ?? 0) + 1);
  };

  let triangleCount = 0;
  forEachTriangle(geometry, (first, second, third) => {
    const firstId = weldedId(first);
    const secondId = weldedId(second);
    const thirdId = weldedId(third);
    if (firstId === secondId || secondId === thirdId || thirdId === firstId) return;
    countEdge(firstId, secondId);
    countEdge(secondId, thirdId);
    countEdge(thirdId, firstId);
    triangleCount++;
  });

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const useCount of edgeUseCounts.values()) {
    if (useCount === 1) boundaryEdgeCount++;
    else if (useCount > 2) nonManifoldEdgeCount++;
  }
  return {
    triangleCount,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    isClosed: triangleCount > 0 && boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
  };
}

/**
 * Every mesh under `object` (itself included) as one non-indexed geometry, in the frame of
 * `object`'s world position and orientation. Scale is baked into the vertices, so the result is
 * in world units and can be given to a body, which has no scale. Undefined when there are no meshes.
 */
export function geometryOfObject(object: Object3D): BufferGeometry | undefined {
  object.updateWorldMatrix(true, true);
  const position = new Vector3();
  const orientation = new Quaternion();
  object.matrixWorld.decompose(position, orientation, new Vector3());
  const toObjectFrame = new Matrix4().compose(position, orientation, new Vector3(1, 1, 1)).invert();
  const relativeMatrix = new Matrix4();
  const corners: number[] = [];
  object.traverse((descendant) => {
    if (!(descendant instanceof Mesh) || !(descendant.geometry instanceof BufferGeometry)) return;
    relativeMatrix.multiplyMatrices(toObjectFrame, descendant.matrixWorld);
    forEachTriangle(descendant.geometry, (first, second, third) => {
      for (const corner of [first, second, third]) {
        corner.applyMatrix4(relativeMatrix);
        corners.push(corner.x, corner.y, corner.z);
      }
    });
  });
  if (corners.length === 0) return undefined;
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(corners, 3));
}
