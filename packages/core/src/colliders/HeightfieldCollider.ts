import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { Box3 } from 'three';
import { isActiveEdge } from '../javascript/collision/triangle.js';
import { Collider } from './Collider.js';
import type { ColliderOptions, ColliderPose } from './Collider.js';

export interface HeightfieldColliderOptions extends ColliderOptions {
  /**
   * Heights of the ground at evenly spaced points, along the collider's y axis: `heights[row][column]`,
   * rows running along z and columns along x. Every row needs the same number of columns, and
   * there must be at least two of each.
   */
  heights: readonly (readonly number[])[];
  /** Distance between neighbouring points, along both x and z. */
  cellSize: number;
  /**
   * How deep below its lowest point the terrain counts as solid, so that whatever sinks into it,
   * however far, is still pushed back out of the top. Defaults to 1 m.
   */
  thickness?: number | undefined;
}

const cornerScratch = new Vector3();

/**
 * Terrain: a grid of heights, centred on the collider's origin, each cell split into two
 * triangles. Solid below the surface, so whatever ends up beneath it is pushed back up. Only for
 * static and kinematic bodies.
 */
export class HeightfieldCollider extends Collider {
  readonly shape = 'heightfield';
  readonly rows: number;
  readonly columns: number;
  readonly cellSize: number;
  readonly thickness: number;
  private readonly heights: Float64Array;
  private readonly lowest: number;
  private readonly highest: number;

  constructor(options: HeightfieldColliderOptions) {
    super(options);
    const rows = options.heights.length;
    const columns = options.heights[0]?.length ?? 0;
    if (rows < 2 || columns < 2) throw new RangeError(`a heightfield needs at least 2 rows and 2 columns, got ${rows} by ${columns}`);
    if (options.heights.some((row) => row.length !== columns)) throw new RangeError('every row of a heightfield needs the same number of columns');
    if (!(options.cellSize > 0)) throw new RangeError(`cellSize must be positive, got ${options.cellSize}`);
    this.rows = rows;
    this.columns = columns;
    this.cellSize = options.cellSize;
    this.thickness = options.thickness ?? 1;
    if (!(this.thickness >= 0)) throw new RangeError(`thickness must not be negative, got ${this.thickness}`);
    this.heights = Float64Array.from(options.heights.flat());
    if (!this.heights.every(Number.isFinite)) throw new RangeError('heights must be finite numbers');
    this.lowest = Math.min(...this.heights);
    this.highest = Math.max(...this.heights);
  }

  /** Width along x, from the first column to the last. */
  get width(): number {
    return (this.columns - 1) * this.cellSize;
  }

  /** Depth along z, from the first row to the last. */
  get depth(): number {
    return (this.rows - 1) * this.cellSize;
  }

  get boundingRadius(): number {
    return Math.hypot(this.width / 2, this.depth / 2, Math.max(Math.abs(this.lowest - this.thickness), Math.abs(this.highest)));
  }

  /** The height stored for a grid point. */
  heightAt(row: number, column: number): number {
    return this.heights[row * this.columns + column]!;
  }

  /** Writes the grid point in the collider's frame. */
  pointAt(row: number, column: number, target: Vector3): Vector3 {
    return target.set(column * this.cellSize - this.width / 2, this.heightAt(row, column), row * this.cellSize - this.depth / 2);
  }

  /** The surface's height above the point (`localX`, `localZ`) of the collider's frame, or undefined off the grid. */
  surfaceHeight(localX: number, localZ: number): number | undefined {
    const column = (localX + this.width / 2) / this.cellSize;
    const row = (localZ + this.depth / 2) / this.cellSize;
    if (column < 0 || row < 0 || column > this.columns - 1 || row > this.rows - 1) return undefined;
    const cellColumn = Math.min(Math.floor(column), this.columns - 2);
    const cellRow = Math.min(Math.floor(row), this.rows - 2);
    const across = column - cellColumn;
    const along = row - cellRow;
    const nearCorner = this.heightAt(cellRow, cellColumn);
    const farCorner = this.heightAt(cellRow + 1, cellColumn + 1);
    // each cell is split along its diagonal from the near corner to the far one
    if (along >= across) return nearCorner + across * (farCorner - this.heightAt(cellRow + 1, cellColumn)) + along * (this.heightAt(cellRow + 1, cellColumn) - nearCorner);
    return nearCorner + across * (this.heightAt(cellRow, cellColumn + 1) - nearCorner) + along * (farCorner - this.heightAt(cellRow, cellColumn + 1));
  }

  /**
   * @internal Calls `visit` with the corners, in the collider's frame and wound anticlockwise seen
   * from above, of every triangle of the cells that a box spanning `minimum` to `maximum` in the
   * collider's frame stands over and reaches down to, with the bit mask of the triangle's edges
   * that may push on their own (see `isActiveEdge`).
   */
  forEachTriangleIn(minimum: Vector3, maximum: Vector3, visit: (first: Vector3, second: Vector3, third: Vector3, activeEdges: number) => void): void {
    if (minimum.y > this.highest) return;
    const firstColumn = Math.max(0, Math.floor((minimum.x + this.width / 2) / this.cellSize));
    const lastColumn = Math.min(this.columns - 2, Math.floor((maximum.x + this.width / 2) / this.cellSize));
    const firstRow = Math.max(0, Math.floor((minimum.z + this.depth / 2) / this.cellSize));
    const lastRow = Math.min(this.rows - 2, Math.floor((maximum.z + this.depth / 2) / this.cellSize));
    const near = new Vector3();
    const across = new Vector3();
    const along = new Vector3();
    const far = new Vector3();
    const normal = new Vector3();
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        this.pointAt(row, column, near);
        this.pointAt(row, column + 1, across);
        this.pointAt(row + 1, column, along);
        this.pointAt(row + 1, column + 1, far);
        if (minimum.y > Math.max(near.y, across.y, along.y, far.y)) continue;
        // each triangle's edges in order, with the far corner of the triangle across each
        triangleNormal(near, along, far, normal);
        visit(
          near,
          along,
          far,
          edgeMask(normal, [near, along, far], [this.optionalPoint(row, column - 1), this.optionalPoint(row + 2, column + 1), this.optionalPoint(row, column + 1)]),
        );
        triangleNormal(near, far, across, normal);
        visit(
          near,
          far,
          across,
          edgeMask(normal, [near, far, across], [this.optionalPoint(row + 1, column), this.optionalPoint(row + 1, column + 2), this.optionalPoint(row - 1, column)]),
        );
      }
    }
  }

  /** The grid point, or undefined off the grid. */
  private optionalPoint(row: number, column: number): Vector3 | undefined {
    if (row < 0 || column < 0 || row >= this.rows || column >= this.columns) return undefined;
    return this.pointAt(row, column, new Vector3());
  }

  /**
   * The surface as triangles in the collider's frame, the same ones it collides as, with normals:
   * to draw the terrain exactly where things roll on it.
   */
  toGeometry(): BufferGeometry {
    const positions = new Float32Array(3 * this.rows * this.columns);
    const point = new Vector3();
    for (let row = 0; row < this.rows; row++) {
      for (let column = 0; column < this.columns; column++) this.pointAt(row, column, point).toArray(positions, 3 * (row * this.columns + column));
    }
    const indices: number[] = [];
    for (let row = 0; row + 1 < this.rows; row++) {
      for (let column = 0; column + 1 < this.columns; column++) {
        const near = row * this.columns + column;
        const across = near + 1;
        const along = near + this.columns;
        const far = along + 1;
        // the two triangles of the cell, split along the same diagonal, wound to face up
        indices.push(near, along, far, near, far, across);
      }
    }
    const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3)).setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    target.makeEmpty();
    for (const cornerX of [-this.width / 2, this.width / 2]) {
      for (const cornerY of [this.lowest - this.thickness, this.highest]) {
        for (const cornerZ of [-this.depth / 2, this.depth / 2]) target.expandByPoint(cornerScratch.set(cornerX, cornerY, cornerZ).applyMatrix3(pose.rotation).add(pose.position));
      }
    }
    return target;
  }

  massProperties(): undefined {
    return undefined;
  }
}

function triangleNormal(first: Vector3, second: Vector3, third: Vector3, target: Vector3): Vector3 {
  return target.subVectors(second, first).cross(cornerScratch.subVectors(third, first)).normalize();
}

/** Bit k set for each edge k (from corner k to the next) that may push on its own, given the far corner of the neighbour across each. */
function edgeMask(normal: Vector3, corners: readonly Vector3[], neighbourCorners: readonly (Vector3 | undefined)[]): number {
  let mask = 0;
  for (let edge = 0; edge < 3; edge++) {
    if (isActiveEdge(normal, corners[edge]!, corners[(edge + 1) % 3]!, neighbourCorners[edge])) mask |= 1 << edge;
  }
  return mask;
}
