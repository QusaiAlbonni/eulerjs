import { BoxGeometry, CylinderGeometry, Euler, Matrix3, Matrix4, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { InvalidMassError, InvalidMeshError, MassProperties } from '@eulerjs/core';
import { diagonal, expectMatrixClose, expectVectorClose, reverseWinding, rotateTensor } from './helpers.js';

describe('MassProperties.fromMesh', () => {
  it('matches the analytic inertia of a solid box', () => {
    const result = MassProperties.fromMesh(new BoxGeometry(2, 4, 6), { mass: 48 });
    expect(result.mass).toBeCloseTo(48, 9);
    expectVectorClose(result.centerOfMass, new Vector3(), 1e-12);
    // m (b² + c²) / 12 and so on
    expectMatrixClose(result.inertia, diagonal(208, 160, 80));
  });

  it('gives the same answer for indexed and non-indexed geometry', () => {
    const indexed = MassProperties.fromMesh(new BoxGeometry(1, 2, 3), { mass: 5 });
    const nonIndexed = MassProperties.fromMesh(new BoxGeometry(1, 2, 3).toNonIndexed(), { mass: 5 });
    expectMatrixClose(nonIndexed.inertia, indexed.inertia);
  });

  it('places the centre of mass where the solid is and leaves the inertia about it unchanged', () => {
    const geometry = new BoxGeometry(2, 4, 6).translate(5, -3, 1);
    const result = MassProperties.fromMesh(geometry, { mass: 48 });
    expectVectorClose(result.centerOfMass, new Vector3(5, -3, 1), 1e-9);
    expectMatrixClose(result.inertia, diagonal(208, 160, 80));
  });

  it('does not modify the geometry it measures', () => {
    const geometry = new BoxGeometry(2, 4, 6).translate(5, 0, 0);
    const positionsBefore = Array.from(geometry.getAttribute('position').array);
    MassProperties.fromMesh(geometry, { mass: 1 });
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(positionsBefore);
  });

  it('rotates the tensor with the mesh, producing products of inertia', () => {
    const rotation = new Matrix4().makeRotationFromEuler(new Euler(0.3, -0.7, 1.1));
    const geometry = new BoxGeometry(2, 4, 6).applyMatrix4(rotation);
    const result = MassProperties.fromMesh(geometry, { mass: 48 });
    const expected = rotateTensor(diagonal(208, 160, 80), new Matrix3().setFromMatrix4(rotation));
    expectMatrixClose(result.inertia, expected, 1e-6);
    expect(Math.abs(result.inertia.elements[1])).toBeGreaterThan(1);
  });

  it('approaches the analytic inertia of a sphere as tessellation gets finer', () => {
    const radius = 1.5;
    const result = MassProperties.fromMesh(new SphereGeometry(radius, 128, 64), { mass: 10 });
    const expectedMoment = 0.4 * 10 * radius ** 2;
    for (const diagonalElement of [0, 4, 8]) {
      expect(Math.abs(result.inertia.elements[diagonalElement]! - expectedMoment) / expectedMoment).toBeLessThan(2e-3);
    }
  });

  it('matches the analytic inertia of a solid cylinder', () => {
    const radius = 0.5;
    const height = 3;
    const mass = 7;
    const result = MassProperties.fromMesh(new CylinderGeometry(radius, radius, height, 256), { mass });
    const axial = 0.5 * mass * radius ** 2;
    const transverse = (mass * (3 * radius ** 2 + height ** 2)) / 12;
    expectMatrixClose(result.inertia, diagonal(transverse, axial, transverse), 1e-3);
  });

  it('derives the mass from a density', () => {
    const result = MassProperties.fromMesh(new BoxGeometry(1, 2, 3), { density: 1000 });
    expect(result.mass).toBeCloseTo(6000, 6);
  });

  it('is independent of where the origin is for a closed mesh', () => {
    const atOrigin = MassProperties.fromMesh(new BoxGeometry(1, 2, 3), { mass: 1 });
    const farAway = MassProperties.fromMesh(new BoxGeometry(1, 2, 3).translate(100, -40, 25), { mass: 1 });
    expectMatrixClose(farAway.inertia, atOrigin.inertia, 1e-6);
  });

  it('rejects an open mesh, whose volume would depend on the origin', () => {
    expect(() => MassProperties.fromMesh(new PlaneGeometry(1, 1), { mass: 1 })).toThrow(InvalidMeshError);
    expect(() => MassProperties.fromMesh(new PlaneGeometry(1, 1), { mass: 1 })).toThrow(/4 boundary edges/);
  });

  it('accepts an open mesh when asked to, as long as it encloses some volume', () => {
    const openBox = new BoxGeometry(1, 1, 1);
    openBox.setIndex(Array.from(openBox.getIndex()!.array).slice(0, 30)); // drop the last face
    expect(() => MassProperties.fromMesh(openBox, { mass: 1 })).toThrow(InvalidMeshError);
    expect(() => MassProperties.fromMesh(openBox, { mass: 1 }, { allowOpenMesh: true })).not.toThrow();
  });

  it('rejects an inside-out mesh instead of returning a negative volume', () => {
    const insideOut = reverseWinding(new BoxGeometry(2, 4, 6));
    expect(() => MassProperties.fromMesh(insideOut, { mass: 48 })).toThrow(/point inward/);
  });
});

describe('MassProperties primitives', () => {
  it('box() matches the mesh integration', () => {
    const fromMesh = MassProperties.fromMesh(new BoxGeometry(1, 2, 3), { mass: 4 });
    const primitive = MassProperties.box(new Vector3(1, 2, 3), 4);
    expectMatrixClose(primitive.inertia, fromMesh.inertia);
  });

  it('sphere() uses 2/5 m r²', () => {
    expectMatrixClose(MassProperties.sphere(2, 5).inertia, diagonal(8, 8, 8));
  });

  it('point() has no inertia of its own', () => {
    const point = MassProperties.point(3, new Vector3(1, 2, 3));
    expectVectorClose(point.centerOfMass, new Vector3(1, 2, 3));
    expect(point.inertia.elements.every((element) => element === 0)).toBe(true);
  });
});

describe('MassProperties.fromCells', () => {
  it('reproduces a box exactly when the cells tile it', () => {
    const cellSize = 0.25;
    const centers: Vector3[] = [];
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 8; row++) {
        for (let layer = 0; layer < 12; layer++) {
          centers.push(new Vector3(column + 0.5, row + 0.5, layer + 0.5).multiplyScalar(cellSize).add(new Vector3(-0.5, -1, -1.5)));
        }
      }
    }
    const result = MassProperties.fromCells(centers, cellSize, 48);
    expectVectorClose(result.centerOfMass, new Vector3(), 1e-12);
    expectMatrixClose(result.inertia, MassProperties.box(new Vector3(1, 2, 3), 48).inertia, 1e-12);
  });

  it('refuses an empty set of cells', () => {
    expect(() => MassProperties.fromCells([], 1, 1)).toThrow(InvalidMassError);
  });
});

describe('MassProperties transformations', () => {
  it('withMass scales the inertia with the mass', () => {
    const heavier = MassProperties.box(new Vector3(2, 4, 6), 48).withMass(480);
    expect(heavier.mass).toBe(480);
    expectMatrixClose(heavier.inertia, diagonal(2080, 1600, 800));
  });

  it('combine joins two halves of a box into the whole box', () => {
    const left = MassProperties.box(new Vector3(1, 2, 3), 6, new Vector3(-0.5, 0, 0));
    const right = MassProperties.box(new Vector3(1, 2, 3), 6, new Vector3(0.5, 0, 0));
    const whole = left.combine(right);
    expect(whole.mass).toBe(12);
    expectVectorClose(whole.centerOfMass, new Vector3(), 1e-12);
    expectMatrixClose(whole.inertia, MassProperties.box(new Vector3(2, 2, 3), 12).inertia, 1e-12);
  });

  it('combine shifts the centre of mass toward added ballast', () => {
    const hull = MassProperties.box(new Vector3(2, 1, 6), 900);
    const ballasted = hull.combine(MassProperties.point(100, new Vector3(0, -2, 0)));
    expectVectorClose(ballasted.centerOfMass, new Vector3(0, -0.2, 0), 1e-12);
  });
});

describe('MassProperties validation', () => {
  it.each([0, -1, Number.NaN, Infinity])('rejects mass %s', (mass) => {
    expect(() => new MassProperties(mass, new Vector3(), diagonal(1, 1, 1))).toThrow(InvalidMassError);
  });

  it('rejects a non-finite centre of mass', () => {
    expect(() => new MassProperties(1, new Vector3(Number.NaN, 0, 0), diagonal(1, 1, 1))).toThrow(/Centre of mass/);
  });

  it('rejects a non-finite, asymmetric or negative inertia tensor', () => {
    expect(() => new MassProperties(1, new Vector3(), diagonal(Infinity, 1, 1))).toThrow(/not finite/);
    expect(() => new MassProperties(1, new Vector3(), new Matrix3().set(1, 0.5, 0, 0, 1, 0, 0, 0, 1))).toThrow(/symmetric/);
    expect(() => new MassProperties(1, new Vector3(), diagonal(-1, 1, 1))).toThrow(/negative/);
  });

  it('keeps its own copies of the vectors it was built from', () => {
    const center = new Vector3(1, 2, 3);
    const properties = new MassProperties(1, center, diagonal(1, 1, 1));
    center.set(0, 0, 0);
    expectVectorClose(properties.centerOfMass, new Vector3(1, 2, 3));
  });
});
