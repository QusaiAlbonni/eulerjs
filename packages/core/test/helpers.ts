import type { Vector3 } from 'three';
import { BufferAttribute, BufferGeometry, Matrix3 } from 'three';
import { expect } from 'vitest';

export function expectVectorClose(actual: Vector3, expected: Vector3, tolerance = 1e-9): void {
  const distance = actual.distanceTo(expected);
  expect(distance, `expected ${actual.toArray()} to be within ${tolerance} of ${expected.toArray()}`).toBeLessThanOrEqual(tolerance);
}

/** Compares two matrices element by element, with a tolerance relative to the largest element. */
export function expectMatrixClose(actual: Matrix3, expected: Matrix3, relativeTolerance = 1e-9): void {
  const scale = Math.max(...expected.elements.map(Math.abs), 1e-12);
  actual.elements.forEach((element, index) => {
    const difference = Math.abs(element - expected.elements[index]!);
    expect(difference / scale, `element ${index}: ${element} vs ${expected.elements[index]}`).toBeLessThanOrEqual(relativeTolerance);
  });
}

export function diagonal(xx: number, yy: number, zz: number): Matrix3 {
  return new Matrix3().set(xx, 0, 0, 0, yy, 0, 0, 0, zz);
}

/** R I Rᵀ: the same tensor expressed after rotating the body by `rotation`. */
export function rotateTensor(tensor: Matrix3, rotation: Matrix3): Matrix3 {
  return rotation.clone().multiply(tensor).multiply(rotation.clone().transpose());
}

/** A copy of `geometry` with every triangle's winding reversed, i.e. turned inside out. */
export function reverseWinding(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const positions = flat.getAttribute('position');
  const reversed = new Float32Array(positions.count * 3);
  for (let corner = 0; corner < positions.count; corner += 3) {
    for (const [targetOffset, sourceOffset] of [[0, 0], [1, 2], [2, 1]] as const) {
      reversed[(corner + targetOffset) * 3] = positions.getX(corner + sourceOffset);
      reversed[(corner + targetOffset) * 3 + 1] = positions.getY(corner + sourceOffset);
      reversed[(corner + targetOffset) * 3 + 2] = positions.getZ(corner + sourceOffset);
    }
  }
  const result = new BufferGeometry();
  result.setAttribute('position', new BufferAttribute(reversed, 3));
  return result;
}

/** A geometry built from explicit triangles, each given as three [x, y, z] corners. */
export function geometryFromTriangles(triangles: ReadonlyArray<readonly [number, number, number][]>): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(triangles.flat(2)), 3));
  return geometry;
}
