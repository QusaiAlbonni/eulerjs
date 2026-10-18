import { Box3, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { forEachTriangle } from './geometry.js';
import { MassProperties } from './MassProperties.js';
import type { MassSpecification } from './MassProperties.js';

export interface VoxelizeOptions {
  /**
   * Edge length of each cubic cell, in the geometry's units. Defaults to a sixteenth of the
   * geometry's longest side.
   */
  cellSize?: number | undefined;
}

/** How many cells fit along the longest side of a geometry when no cell size is given. */
export const DEFAULT_CELLS_ALONG_LONGEST_SIDE = 16;

/**
 * Lines through cell centres are shifted by this fraction of a cell so they never pass exactly
 * through a mesh vertex or edge, where a hit could be counted twice or not at all.
 */
const LINE_OFFSET_FRACTION = 1.234567e-6;

/** The axes perpendicular to each casting axis: casting along x uses (y, z), and so on. */
const PERPENDICULAR_AXES = [
  [1, 2],
  [2, 0],
  [0, 1],
] as const;

/**
 * A solid approximated by equal cubes, in the frame of the geometry it was built from. Used to
 * sample how much of a hull is under water, and to give open meshes mass properties.
 */
export class Voxels {
  readonly cellSize: number;
  /** Centres of the cells inside the solid. */
  readonly cells: readonly Vector3[];

  constructor(cellSize: number, cells: readonly Vector3[]) {
    this.cellSize = cellSize;
    this.cells = cells;
  }

  get cellVolume(): number {
    return this.cellSize ** 3;
  }

  get volume(): number {
    return this.cells.length * this.cellVolume;
  }

  /** Mass properties of the voxelized solid with uniform density, from its total mass or its density. */
  massProperties(specification: number | MassSpecification): MassProperties {
    return MassProperties.fromCells(this.cells, this.cellSize, specification);
  }

  /**
   * Fills a grid of cells over the geometry's bounding box and keeps those inside the surface.
   *
   * A cell is inside when lines through it along at least two of the three axes cross the
   * surface an odd number of times before reaching it. Voting across axes makes the result
   * robust to holes: an open deck fools the vertical lines but not the horizontal ones. Faces
   * count from both sides, so winding and material settings don't matter.
   */
  static fromGeometry(geometry: BufferGeometry, options: VoxelizeOptions = {}): Voxels {
    const triangles = collectTriangles(geometry);
    const bounds = boundsOfTriangles(triangles);
    const size = bounds.getSize(new Vector3());
    const cellSize = options.cellSize ?? Math.max(size.x, size.y, size.z) / DEFAULT_CELLS_ALONG_LONGEST_SIDE;
    if (!(cellSize > 0)) throw new RangeError(`cellSize must be positive, got ${cellSize}`);

    const grid = new CellGrid(bounds, cellSize);
    const insideVotes = new Uint8Array(grid.cellCount);
    for (const axis of [0, 1, 2] as const) {
      castLinesAlongAxis(axis, triangles, grid, insideVotes);
    }

    const cells: Vector3[] = [];
    for (let cellIndex = 0; cellIndex < grid.cellCount; cellIndex++) {
      if (insideVotes[cellIndex]! >= 2) cells.push(grid.cellCenter(cellIndex));
    }
    return new Voxels(cellSize, cells);
  }
}

/** A regular grid of cubes covering a box, centred on it. */
class CellGrid {
  readonly cellSize: number;
  /** Number of cells along x, y and z. */
  readonly counts: [number, number, number];
  /** Corner of the grid with the smallest coordinates. */
  readonly origin: [number, number, number];
  readonly cellCount: number;

  constructor(bounds: Box3, cellSize: number) {
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    this.cellSize = cellSize;
    this.counts = [size.x, size.y, size.z].map((extent) => Math.max(1, Math.ceil(extent / cellSize))) as [number, number, number];
    this.origin = [center.x, center.y, center.z].map((middle, axis) => middle - (this.counts[axis]! * cellSize) / 2) as [
      number,
      number,
      number,
    ];
    this.cellCount = this.counts[0] * this.counts[1] * this.counts[2];
  }

  /** Coordinate along `axis` of the centre of cell number `step` on that axis. */
  coordinate(axis: number, step: number): number {
    return this.origin[axis]! + (step + 0.5) * this.cellSize;
  }

  index(steps: readonly [number, number, number]): number {
    return (steps[0] * this.counts[1] + steps[1]) * this.counts[2] + steps[2];
  }

  cellCenter(cellIndex: number): Vector3 {
    const stepZ = cellIndex % this.counts[2];
    const stepY = Math.floor(cellIndex / this.counts[2]) % this.counts[1];
    const stepX = Math.floor(cellIndex / (this.counts[1] * this.counts[2]));
    return new Vector3(this.coordinate(0, stepX), this.coordinate(1, stepY), this.coordinate(2, stepZ));
  }
}

/** Every triangle's corners as 9 consecutive numbers. */
function collectTriangles(geometry: BufferGeometry): Float64Array {
  const corners: number[] = [];
  forEachTriangle(geometry, (first, second, third) => {
    corners.push(first.x, first.y, first.z, second.x, second.y, second.z, third.x, third.y, third.z);
  });
  return Float64Array.from(corners);
}

function boundsOfTriangles(triangles: Float64Array): Box3 {
  const bounds = new Box3();
  const corner = new Vector3();
  for (let offset = 0; offset < triangles.length; offset += 3) {
    bounds.expandByPoint(corner.set(triangles[offset]!, triangles[offset + 1]!, triangles[offset + 2]!));
  }
  return bounds;
}

/**
 * Casts one line along `axis` through every row of cell centres and adds a vote to each cell
 * the line finds inside. Triangles are first binned by the lines their shadow covers, so each
 * line only tests the triangles it can hit.
 */
function castLinesAlongAxis(axis: 0 | 1 | 2, triangles: Float64Array, grid: CellGrid, insideVotes: Uint8Array): void {
  const [firstAxis, secondAxis] = PERPENDICULAR_AXES[axis];
  const firstCount = grid.counts[firstAxis];
  const secondCount = grid.counts[secondAxis];
  const lineOffset = LINE_OFFSET_FRACTION * grid.cellSize;
  const lineFirst = (step: number) => grid.coordinate(firstAxis, step) + lineOffset;
  const lineSecond = (step: number) => grid.coordinate(secondAxis, step) + lineOffset * 1.618;

  const trianglesByLine = binTrianglesByLine(triangles, grid, firstAxis, secondAxis, lineFirst, lineSecond);
  const crossings: number[] = [];
  const steps: [number, number, number] = [0, 0, 0];

  for (let firstStep = 0; firstStep < firstCount; firstStep++) {
    for (let secondStep = 0; secondStep < secondCount; secondStep++) {
      const candidates = trianglesByLine[firstStep * secondCount + secondStep];
      if (!candidates) continue;
      crossings.length = 0;
      for (const triangle of candidates) {
        const crossing = lineCrossing(triangles, triangle * 9, axis, firstAxis, secondAxis, lineFirst(firstStep), lineSecond(secondStep));
        if (crossing !== null) crossings.push(crossing);
      }
      if (crossings.length === 0) continue;
      crossings.sort((first, second) => first - second);

      steps[firstAxis] = firstStep;
      steps[secondAxis] = secondStep;
      let crossingsBefore = 0;
      for (let step = 0; step < grid.counts[axis]; step++) {
        const center = grid.coordinate(axis, step);
        while (crossingsBefore < crossings.length && crossings[crossingsBefore]! < center) crossingsBefore++;
        if (crossingsBefore % 2 === 1) {
          steps[axis] = step;
          insideVotes[grid.index(steps)]!++;
        }
      }
    }
  }
}

function binTrianglesByLine(
  triangles: Float64Array,
  grid: CellGrid,
  firstAxis: number,
  secondAxis: number,
  lineFirst: (step: number) => number,
  lineSecond: (step: number) => number,
): (number[] | undefined)[] {
  const firstCount = grid.counts[firstAxis]!;
  const secondCount = grid.counts[secondAxis]!;
  const bins: (number[] | undefined)[] = new Array(firstCount * secondCount);
  const stepRange = (minimum: number, maximum: number, axis: number, count: number, line: (step: number) => number) => {
    let first = Math.max(0, Math.floor((minimum - grid.origin[axis]!) / grid.cellSize - 0.5));
    let last = Math.min(count - 1, Math.ceil((maximum - grid.origin[axis]!) / grid.cellSize - 0.5));
    while (first <= last && line(first) < minimum) first++;
    while (last >= first && line(last) > maximum) last--;
    return [first, last] as const;
  };

  const triangleCount = triangles.length / 9;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const base = triangle * 9;
    const firstValues = [triangles[base + firstAxis]!, triangles[base + 3 + firstAxis]!, triangles[base + 6 + firstAxis]!];
    const secondValues = [triangles[base + secondAxis]!, triangles[base + 3 + secondAxis]!, triangles[base + 6 + secondAxis]!];
    const [firstStart, firstEnd] = stepRange(Math.min(...firstValues), Math.max(...firstValues), firstAxis, firstCount, lineFirst);
    const [secondStart, secondEnd] = stepRange(Math.min(...secondValues), Math.max(...secondValues), secondAxis, secondCount, lineSecond);
    for (let firstStep = firstStart; firstStep <= firstEnd; firstStep++) {
      for (let secondStep = secondStart; secondStep <= secondEnd; secondStep++) {
        const binIndex = firstStep * secondCount + secondStep;
        (bins[binIndex] ??= []).push(triangle);
      }
    }
  }
  return bins;
}

/**
 * Where the line through (lineFirst, lineSecond) along `axis` crosses the triangle starting at
 * `base`, as a coordinate on `axis`, or null if it misses. Works on the triangle's shadow in the
 * perpendicular plane, so either winding counts.
 */
function lineCrossing(
  triangles: Float64Array,
  base: number,
  axis: number,
  firstAxis: number,
  secondAxis: number,
  lineFirst: number,
  lineSecond: number,
): number | null {
  const cornerFirst = (corner: number) => triangles[base + corner * 3 + firstAxis]! - lineFirst;
  const cornerSecond = (corner: number) => triangles[base + corner * 3 + secondAxis]! - lineSecond;
  // Twice the signed areas of the sub-triangles the line's point makes with each edge.
  const weightOfCorner0 = cornerFirst(1) * cornerSecond(2) - cornerSecond(1) * cornerFirst(2);
  const weightOfCorner1 = cornerFirst(2) * cornerSecond(0) - cornerSecond(2) * cornerFirst(0);
  const weightOfCorner2 = cornerFirst(0) * cornerSecond(1) - cornerSecond(0) * cornerFirst(1);
  const allPositive = weightOfCorner0 > 0 && weightOfCorner1 > 0 && weightOfCorner2 > 0;
  const allNegative = weightOfCorner0 < 0 && weightOfCorner1 < 0 && weightOfCorner2 < 0;
  if (!allPositive && !allNegative) return null;
  const totalWeight = weightOfCorner0 + weightOfCorner1 + weightOfCorner2;
  return (
    (weightOfCorner0 * triangles[base + axis]! + weightOfCorner1 * triangles[base + 3 + axis]! + weightOfCorner2 * triangles[base + 6 + axis]!) /
    totalWeight
  );
}
