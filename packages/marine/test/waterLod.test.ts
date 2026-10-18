import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { Mesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { SpectralWaves } from '../src/waves/SpectralWaves.js';
import { GpuWaveFields } from '../src/webgpu/GpuWaveFields.js';
import { QuadtreeLod } from '../src/webgpu/QuadtreeLod.js';
import { RingLod } from '../src/webgpu/RingLod.js';

// The water's levels of detail must cover the sea once, with neither holes nor overlaps, and
// without cracks where levels meet, however the centre moves. Their vertices are placed on the GPU;
// here they are placed again the same way, with heights standing in for the waves', and points all
// over the sea are checked to be inside exactly one triangle, and every edge to have the same
// heights along it as the triangle across it.

/** x, z and height of each corner. */
type Triangle = [number, number, number, number, number, number, number, number, number];

/**
 * A height for the vertex at (x, z) sampling the waves `spacing` apart: as the GPU's mipmaps do,
 * the farther apart, the different the waves, so that two vertices in one place agree only if
 * they sample alike.
 */
const heightOf = (worldX: number, worldZ: number, spacing: number) => Math.sin(0.41 * worldX + 0.13 * worldZ) + 0.7 * Math.cos(0.29 * worldZ - 0.17 * worldX) + 0.2 * Math.log2(spacing);

const MORPH_START = 0.7;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const fract = (value: number) => value - Math.floor(value);
const morphed = (cells: number, morph: number) => cells - fract(cells * 0.5) * 2 * morph;

/** The cell-unit x and z of each vertex of a geometry, and its triangles' vertex indices. */
function cellsOf(mesh: Mesh): { positions: ArrayLike<number>; indices: ArrayLike<number> } {
  return { positions: mesh.geometry.getAttribute('position').array, indices: mesh.geometry.getIndex()!.array };
}

/** The rings' pieces in the world, as RingLod's shader places them. */
function ringPieces(lod: RingLod): Piece[] {
  const pieces: Piece[] = [];
  for (const object of lod.children) {
    const mesh = object as Mesh;
    if (!mesh.visible) continue;
    const { centre, spacing, offset, morphReach } = mesh.userData.placement as { centre: { x: number; y: number }; spacing: number; offset: { x: number; y: number }; morphReach: number };
    const { positions, indices } = cellsOf(mesh);
    const vertices: [number, number, number][] = [];
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const column = positions[3 * vertex]! + offset.x;
      const row = positions[3 * vertex + 2]! + offset.y;
      const boxDistance = Math.max(Math.abs(column), Math.abs(row));
      const morph = morphReach > 0 ? clamp01((boxDistance / morphReach - MORPH_START) / (1 - MORPH_START)) : 0;
      const worldX = centre.x + morphed(column, morph) * spacing;
      const worldZ = centre.y + morphed(row, morph) * spacing;
      vertices.push([worldX, worldZ, heightOf(worldX, worldZ, spacing * (1 + morph))]);
    }
    pieces.push({ vertices, indices });
  }
  return pieces;
}

/** The quadtree's nodes in the world, as QuadtreeLod's shader places them. */
function quadtreePieces(lod: QuadtreeLod, centre: Vector3): Piece[] {
  const pieces: Piece[] = [];
  const nodes = lod.geometry.getAttribute('node').array as Float32Array;
  const { positions, indices } = cellsOf(lod);
  for (let node = 0; node < lod.nodeCount; node++) {
    const [cornerX, cornerZ, spacing, morphEnd] = nodes.subarray(4 * node, 4 * node + 4) as unknown as [number, number, number, number];
    const vertices: [number, number, number][] = [];
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const column = positions[3 * vertex]!;
      const row = positions[3 * vertex + 2]!;
      const distance = Math.hypot(cornerX + column * spacing - centre.x, centre.y, cornerZ + row * spacing - centre.z);
      const morph = morphEnd > 0 ? clamp01((distance / morphEnd - MORPH_START) / (1 - MORPH_START)) : 0;
      const worldX = cornerX + morphed(column, morph) * spacing;
      const worldZ = cornerZ + morphed(row, morph) * spacing;
      vertices.push([worldX, worldZ, heightOf(worldX, worldZ, spacing * (1 + morph))]);
    }
    pieces.push({ vertices, indices });
  }
  return pieces;
}

function trianglesOf(pieces: Piece[]): Triangle[] {
  const triangles: Triangle[] = [];
  for (const { vertices, indices } of pieces) {
    for (let at = 0; at < indices.length; at += 3) triangles.push([...vertices[indices[at]!]!, ...vertices[indices[at + 1]!]!, ...vertices[indices[at + 2]!]!]);
  }
  return triangles;
}

/** The triangles over the square of `reach` around (centreX, centreZ), degenerate ones (folded flat by morphing) aside, bucketed for finding which cover a point. */
class Surface {
  private readonly bucketCount = 512;
  private readonly bucketSize: number;
  private readonly buckets = new Map<number, Triangle[]>();
  readonly triangles: Triangle[] = [];

  constructor(
    triangles: Triangle[],
    readonly centreX: number,
    readonly centreZ: number,
    readonly reach: number,
  ) {
    this.bucketSize = (2 * reach) / this.bucketCount;
    for (const triangle of triangles) {
      const [ax, az, , bx, bz, , cx, cz] = triangle;
      if (Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) < 1e-9) continue;
      this.triangles.push(triangle);
      const [firstColumn, firstRow] = this.bucketOf(Math.min(ax, bx, cx), Math.min(az, bz, cz));
      const [lastColumn, lastRow] = this.bucketOf(Math.max(ax, bx, cx), Math.max(az, bz, cz));
      for (let row = Math.max(0, firstRow); row <= Math.min(this.bucketCount - 1, lastRow); row++) {
        for (let column = Math.max(0, firstColumn); column <= Math.min(this.bucketCount - 1, lastColumn); column++) {
          const key = row * this.bucketCount + column;
          let bucket = this.buckets.get(key);
          if (!bucket) this.buckets.set(key, (bucket = []));
          bucket.push(triangle);
        }
      }
    }
  }

  private bucketOf(worldX: number, worldZ: number): [number, number] {
    return [Math.floor((worldX - this.centreX + this.reach) / this.bucketSize), Math.floor((worldZ - this.centreZ + this.reach) / this.bucketSize)];
  }

  /** The triangles strictly around the point (worldX, worldZ). */
  covering(worldX: number, worldZ: number): Triangle[] {
    const [column, row] = this.bucketOf(worldX, worldZ);
    return (this.buckets.get(row * this.bucketCount + column) ?? []).filter(([ax, az, , bx, bz, , cx, cz]) => {
      const first = (bx - ax) * (worldZ - az) - (bz - az) * (worldX - ax);
      const second = (cx - bx) * (worldZ - bz) - (cz - bz) * (worldX - bx);
      const third = (ax - cx) * (worldZ - cz) - (az - cz) * (worldX - cx);
      return (first > 0 && second > 0 && third > 0) || (first < 0 && second < 0 && third < 0);
    });
  }

  /** How many triangles cover each of `count` points spread over every distance from the centre, near and far, as the levels are. */
  coverage(count: number): number[] {
    let seed = 12345;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: count }, () => {
      const distance = this.reach * random() ** 3;
      const angle = 2 * Math.PI * random();
      return this.covering(this.centreX + distance * Math.cos(angle), this.centreZ + distance * Math.sin(angle)).length;
    });
  }
}

/**
 * Each piece of the surface (a ring, a trim, a node), as its vertices placed in the world and its
 * triangles: a piece's own vertices are shared by its triangles, so a piece has no cracks inside.
 */
interface Piece {
  vertices: [number, number, number][];
  indices: ArrayLike<number>;
}

/**
 * The vertices on the edge of a piece (on an edge only one of its triangles has) that no other
 * piece has a vertex at, the same in height as well: where the surface cracks between pieces. The
 * outer edge of the sea, beyond `reach` of the centre, aside.
 */
function unmatchedBorderVertices(pieces: Piece[], centre: Vector3, reach: number): string[] {
  const keyOf = ([worldX, worldZ]: [number, number, number]) => `${worldX},${worldZ}`;
  const vertexPieces = new Map<string, { piece: number; height: number }[]>();
  pieces.forEach(({ vertices }, piece) => {
    for (const vertex of vertices) {
      const key = keyOf(vertex);
      let found = vertexPieces.get(key);
      if (!found) vertexPieces.set(key, (found = []));
      found.push({ piece, height: vertex[2] });
    }
  });
  const unmatched: string[] = [];
  pieces.forEach(({ vertices, indices }, piece) => {
    const edgeUses = new Map<string, number>();
    const edgeKey = (first: number, second: number) => (first < second ? `${first} ${second}` : `${second} ${first}`);
    for (let at = 0; at < indices.length; at += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const key = edgeKey(indices[at + corner]!, indices[at + ((corner + 1) % 3)]!);
        edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
      }
    }
    for (const [key, uses] of edgeUses) {
      if (uses !== 1) continue;
      for (const vertexIndex of key.split(' ').map(Number)) {
        const vertex = vertices[vertexIndex]!;
        if (Math.max(Math.abs(vertex[0] - centre.x), Math.abs(vertex[1] - centre.z)) > reach) continue;
        const others = vertexPieces.get(keyOf(vertex))!.filter((other) => other.piece !== piece);
        if (!others.some((other) => Math.abs(other.height - vertex[2]) < 1e-9)) unmatched.push(`${vertex.join(', ')} in piece ${piece}`);
      }
    }
  });
  return [...new Set(unmatched)].slice(0, 5);
}

const fields = new GpuWaveFields(new SpectralWaves({ resolution: 16, physicsResolution: 16 }));
const centres = [new Vector3(0.1, 2, 0.3), new Vector3(1234.567, 1.5, -89.01), new Vector3(-77.7, 40, 333.3), new Vector3(5, 600, -5)];

describe('the water levels of detail', () => {
  it.each(centres.map((centre) => [centre.toArray().join(', '), centre] as const))('lay rings round (%s) covering the sea once, without cracks', (_label, centre) => {
    const lod = new RingLod(fields, { levelCount: 9 });
    lod.update(centre);
    const surface = new Surface(trianglesOf(ringPieces(lod)), centre.x, centre.z, 0.9 * lod.reach);
    const counts = surface.coverage(40_000);
    const finestDrawn = Math.min(...lod.children.filter((child) => child.visible).map((child) => (child.userData.placement as { spacing: number }).spacing));
    expect(counts.filter((count) => count !== 1)).toEqual([]);
    expect(unmatchedBorderVertices(ringPieces(lod), centre, 0.9 * lod.reach)).toEqual([]);
    // and from high up, the finest levels are left out
    if (centre.y > 100) expect(finestDrawn).toBeGreaterThan(lod.finestSpacing);
  });

  it.each(centres.map((centre) => [centre.toArray().join(', '), centre] as const))('lay quadtree nodes round (%s) covering the sea once, without cracks', (_label, centre) => {
    const lod = new QuadtreeLod(fields, { levelCount: 12 });
    lod.update(centre);
    const surface = new Surface(trianglesOf(quadtreePieces(lod, centre)), centre.x, centre.z, 0.9 * lod.reach);
    expect(surface.coverage(40_000).filter((count) => count !== 1)).toEqual([]);
    expect(unmatchedBorderVertices(quadtreePieces(lod, centre), centre, 0.9 * lod.reach)).toEqual([]);
  });

  it("culls the quadtree's nodes out of the camera's view, keeping those in it", () => {
    const lod = new QuadtreeLod(fields, { levelCount: 12 });
    const centre = new Vector3(0, 3, 0);
    lod.update(centre);
    const everything = lod.nodeCount;
    const camera = new PerspectiveCamera(60, 1.5, 0.5, 1e6);
    camera.position.copy(centre);
    camera.lookAt(0, 0, -50);
    lod.update(centre, camera);
    expect(lod.nodeCount).toBeLessThan(everything * 0.6);
    // what is left still covers the sea straight ahead, near and far
    const ahead = new Surface(trianglesOf(quadtreePieces(lod, centre)), 0, 0, lod.reach);
    for (const distance of [20, 200, 2000]) expect(ahead.covering(0.013, 0.017 - distance)).toHaveLength(1);
  });
});
