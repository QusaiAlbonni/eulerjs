import { BoxGeometry, BufferAttribute, BufferGeometry, PlaneGeometry, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { analyzeTopology, forEachTriangle, InvalidMeshError } from '@eulerjs/core';
import { geometryFromTriangles } from './helpers.js';

describe('analyzeTopology', () => {
  it('reports a box as closed even though its faces have separate vertices', () => {
    const topology = analyzeTopology(new BoxGeometry(1, 2, 3));
    expect(topology).toEqual({ triangleCount: 12, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, isClosed: true });
  });

  it('welds the seam and poles of a sphere', () => {
    expect(analyzeTopology(new SphereGeometry(1, 16, 8)).isClosed).toBe(true);
  });

  it('counts the rim of a plane as boundary edges', () => {
    const topology = analyzeTopology(new PlaneGeometry(1, 1, 2, 2));
    expect(topology.boundaryEdgeCount).toBe(8);
    expect(topology.isClosed).toBe(false);
  });

  it('counts an edge shared by three triangles as non-manifold', () => {
    const fin = geometryFromTriangles([
      [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [0, 0, 0], [0, -1, 0]],
      [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    ]);
    expect(analyzeTopology(fin).nonManifoldEdgeCount).toBe(1);
  });

  it('leaves out triangles that collapse when welded, as older three.js cones have at the tip', () => {
    const tetrahedron: [number, number, number][][] = [
      [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
      [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    ];
    // a sliver along an edge, its tip twice: kept, it would share that edge with two more triangles
    const sliver: [number, number, number][] = [[0, 1, 0], [0, 1, 0], [1, 0, 0]];
    const topology = analyzeTopology(geometryFromTriangles([...tetrahedron, sliver]));
    expect(topology).toEqual({ triangleCount: 4, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, isClosed: true });
  });

  it('does not call an empty geometry closed', () => {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    expect(analyzeTopology(empty).isClosed).toBe(false);
  });
});

describe('forEachTriangle', () => {
  it('visits every triangle of indexed and non-indexed geometry', () => {
    let indexedCount = 0;
    let nonIndexedCount = 0;
    forEachTriangle(new BoxGeometry(), () => indexedCount++);
    forEachTriangle(new BoxGeometry().toNonIndexed(), () => nonIndexedCount++);
    expect(indexedCount).toBe(12);
    expect(nonIndexedCount).toBe(12);
  });

  it('rejects geometry without positions', () => {
    expect(() => forEachTriangle(new BufferGeometry(), () => {})).toThrow(InvalidMeshError);
  });

  it('rejects geometry whose corners are not a whole number of triangles', () => {
    const broken = new BufferGeometry();
    broken.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    expect(() => forEachTriangle(broken, () => {})).toThrow(/whole number of triangles/);
  });
});
