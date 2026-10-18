import { BoxGeometry, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { MassProperties, Voxels } from 'eulerjs';

function reverseWinding(geometry: BoxGeometry): BoxGeometry {
  const index = geometry.getIndex()!;
  const reversed: number[] = [];
  for (let corner = 0; corner < index.count; corner += 3) {
    reversed.push(index.getX(corner), index.getX(corner + 2), index.getX(corner + 1));
  }
  geometry.setIndex(reversed);
  return geometry;
}

describe('Voxels.fromGeometry', () => {
  it('fills a cube with exactly the cells that tile it, centred in each cell', () => {
    const voxels = Voxels.fromGeometry(new BoxGeometry(1, 1, 1), { cellSize: 0.1 });
    expect(voxels.cells).toHaveLength(1000);
    expect(voxels.volume).toBeCloseTo(1, 9);
    const center = voxels.cells.reduce((sum, cell) => sum.add(cell), new Vector3()).divideScalar(voxels.cells.length);
    expect(center.length()).toBeLessThan(1e-9);
    expect(Math.max(...voxels.cells.map((cell) => Math.abs(cell.x)))).toBeCloseTo(0.45, 9);
  });

  it('approximates the volume of a sphere', () => {
    const voxels = Voxels.fromGeometry(new SphereGeometry(1, 48, 24), { cellSize: 0.05 });
    expect(Math.abs(voxels.volume / ((4 / 3) * Math.PI) - 1)).toBeLessThan(0.015);
  });

  it('keeps the hole of a torus empty', () => {
    const voxels = Voxels.fromGeometry(new TorusGeometry(2, 0.5, 24, 64), { cellSize: 0.1 });
    expect(Math.abs(voxels.volume / (2 * Math.PI ** 2 * 2 * 0.5 ** 2) - 1)).toBeLessThan(0.03);
    expect(voxels.cells.some((cell) => cell.length() < 1)).toBe(false);
  });

  it('ignores triangle winding', () => {
    const outward = Voxels.fromGeometry(new BoxGeometry(1, 2, 1), { cellSize: 0.25 });
    const inward = Voxels.fromGeometry(reverseWinding(new BoxGeometry(1, 2, 1)), { cellSize: 0.25 });
    expect(inward.cells.length).toBe(outward.cells.length);
  });

  it('still fills a box with an open top, like a hull with an open deck', () => {
    const openTop = new BoxGeometry(2, 1, 4);
    const index = Array.from(openTop.getIndex()!.array);
    openTop.setIndex([...index.slice(0, 12), ...index.slice(18)]); // drop the +y face
    const closed = Voxels.fromGeometry(new BoxGeometry(2, 1, 4), { cellSize: 0.25 });
    const open = Voxels.fromGeometry(openTop, { cellSize: 0.25 });
    expect(open.cells.length).toBe(closed.cells.length);
  });

  it('works in the frame of the geometry', () => {
    const voxels = Voxels.fromGeometry(new BoxGeometry(1, 1, 1).translate(10, -2, 3), { cellSize: 0.5 });
    const center = voxels.cells.reduce((sum, cell) => sum.add(cell), new Vector3()).divideScalar(voxels.cells.length);
    expect(center.distanceTo(new Vector3(10, -2, 3))).toBeLessThan(1e-9);
  });

  it('gives the mass properties of the filled solid', () => {
    const voxels = Voxels.fromGeometry(new BoxGeometry(1, 2, 3), { cellSize: 0.25 });
    const expected = MassProperties.box(new Vector3(1, 2, 3), 6).inertia.elements;
    voxels.massProperties(6).inertia.elements.forEach((element, index) => expect(element).toBeCloseTo(expected[index]!, 9));
  });

  it('rejects a cell size that is not positive', () => {
    expect(() => Voxels.fromGeometry(new BoxGeometry(), { cellSize: 0 })).toThrow(RangeError);
  });
});
