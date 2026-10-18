import { BufferGeometry, Float32BufferAttribute } from 'three/webgpu';
import { float, fract } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/**
 * A grid of cells in cell units, x and z from (firstColumn, firstRow), `columns` by `rows` of
 * them, leaving out the cells `skip` says to. Every cell is split along the same diagonal, so
 * that morphing (below) folds four cells exactly onto the coarser cell they make.
 */
export function cellGrid(firstColumn: number, firstRow: number, columns: number, rows: number, skip: (column: number, row: number) => boolean = () => false): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexAt = (column: number, row: number) => row * (columns + 1) + column;
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) positions.push(firstColumn + column, 0, firstRow + row);
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (skip(firstColumn + column, firstRow + row)) continue;
      const nearLeft = vertexAt(column, row);
      const nearRight = vertexAt(column + 1, row);
      const farLeft = vertexAt(column, row + 1);
      const farRight = vertexAt(column + 1, row + 1);
      // facing up (+y): counter-clockwise seen from above
      indices.push(nearLeft, farRight, nearRight, nearLeft, farLeft, farRight);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * A vertex at whole-cell position `cells` (vec2) moved toward the grid of cells twice the size,
 * by `morph` from 0 (where it is) to 1 (on the coarser grid): odd columns and rows slide onto the
 * even ones below them. At 1, the fine grid's triangles lie exactly on the coarse grid's, so a
 * fully morphed edge meets a coarser neighbour without cracks (as in Strugar's CDLOD).
 */
export function morphTowardCoarser(cells: Node, morph: Node): Node {
  return cells.sub(fract(cells.mul(0.5)).mul(float(2)).mul(morph));
}
