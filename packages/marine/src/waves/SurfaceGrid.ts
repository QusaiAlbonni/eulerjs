import { MathUtils } from 'three';
import type { WaveSurface } from './WaveSurface.js';

/** Remembered state of one grid node: where its undisplaced grid point was, relative to it. */
interface NodeState {
  offsetX: number;
  offsetZ: number;
  lastUpdate: number;
}

/** Packs integer node coordinates (|column|, |row| < 2²⁰) into one map key. */
const KEY_RANGE = 2 ** 21;
const KEY_OFFSET = 2 ** 20;

/**
 * The surface sampled on a horizontal grid fixed in the world, then interpolated bilinearly.
 * Buoyancy uses it so its cost depends on the area under a hull, not on how finely the hull is
 * voxelized. Nodes keep their grid-point offset between updates, so one inversion iteration
 * per node is enough while the area moves slowly.
 *
 * Interpolation rounds off the sharp wave crests: on the default sea, 0.5 m spacing is off by
 * 3 mm on average and up to about 2 cm at the sharpest crests; the error shrinks with the
 * square of the spacing.
 */
export class SurfaceGrid {
  readonly waves: WaveSurface;
  readonly spacing: number;

  private readonly nodeStates = new Map<number, NodeState>();
  private heights = new Float64Array(0);
  /** How fast each node's surface rises, where the waves say: the water's own vertical velocity. */
  private rises = new Float64Array(0);
  private firstColumn = 0;
  private firstRow = 0;
  private columnCount = 0;
  private rowCount = 0;
  private updateCount = 0;

  constructor(waves: WaveSurface, spacing = 0.5) {
    if (!(spacing > 0)) throw new RangeError(`spacing must be positive, got ${spacing}`);
    this.waves = waves;
    this.spacing = spacing;
  }

  /** Number of nodes sampled by the last update. */
  get nodeCount(): number {
    return this.columnCount * this.rowCount;
  }

  /** Samples every node needed to interpolate inside the given world rectangle at `time`. */
  update(minimumX: number, maximumX: number, minimumZ: number, maximumZ: number, time: number): void {
    this.updateCount++;
    this.firstColumn = Math.floor(minimumX / this.spacing);
    this.firstRow = Math.floor(minimumZ / this.spacing);
    this.columnCount = Math.floor(maximumX / this.spacing) - this.firstColumn + 2;
    this.rowCount = Math.floor(maximumZ / this.spacing) - this.firstRow + 2;
    if (this.heights.length < this.nodeCount) {
      this.heights = new Float64Array(this.nodeCount * 2);
      this.rises = new Float64Array(this.nodeCount * 2);
    }

    for (let row = 0; row < this.rowCount; row++) {
      for (let column = 0; column < this.columnCount; column++) {
        const node = row * this.columnCount + column;
        this.heights[node] = this.sampleNode(this.firstColumn + column, this.firstRow + row, time);
        // the water rising at the surface point found there
        if (this.waves.riseRate) this.rises[node] = this.waves.riseRate(this.waves.lastGridPoint.x, this.waves.lastGridPoint.z, time);
      }
    }
    this.forgetNodesOutside();
  }

  /** Whether the waves say how fast the water at the surface rises: if not, `riseRateAt` is no use. */
  get knowsRiseRate(): boolean {
    return this.waves.riseRate !== undefined;
  }

  /** Interpolated surface height; positions outside the last updated rectangle use its edge. */
  heightAt(worldX: number, worldZ: number): number {
    return this.interpolate(this.heights, worldX, worldZ);
  }

  /** Interpolated speed the water at the surface rises, m/s, where the waves say (`knowsRiseRate`). */
  riseRateAt(worldX: number, worldZ: number): number {
    return this.interpolate(this.rises, worldX, worldZ);
  }

  private interpolate(values: Float64Array, worldX: number, worldZ: number): number {
    const columnPosition = MathUtils.clamp(worldX / this.spacing - this.firstColumn, 0, this.columnCount - 1);
    const rowPosition = MathUtils.clamp(worldZ / this.spacing - this.firstRow, 0, this.rowCount - 1);
    const column = Math.min(Math.floor(columnPosition), this.columnCount - 2);
    const row = Math.min(Math.floor(rowPosition), this.rowCount - 2);
    const alongColumn = columnPosition - column;
    const alongRow = rowPosition - row;
    const corner = row * this.columnCount + column;
    const nearRow = MathUtils.lerp(values[corner]!, values[corner + 1]!, alongColumn);
    const farRow = MathUtils.lerp(values[corner + this.columnCount]!, values[corner + this.columnCount + 1]!, alongColumn);
    return MathUtils.lerp(nearRow, farRow, alongRow);
  }

  private sampleNode(column: number, row: number, time: number): number {
    const nodeX = column * this.spacing;
    const nodeZ = row * this.spacing;
    const key = (column + KEY_OFFSET) * KEY_RANGE + (row + KEY_OFFSET);
    const state = this.nodeStates.get(key);
    const height = state
      ? this.waves.heightFrom(nodeX, nodeZ, time, nodeX + state.offsetX, nodeZ + state.offsetZ, 1)
      : this.waves.heightAt(nodeX, nodeZ, time);
    const offsetX = this.waves.lastGridPoint.x - nodeX;
    const offsetZ = this.waves.lastGridPoint.z - nodeZ;
    if (state) {
      state.offsetX = offsetX;
      state.offsetZ = offsetZ;
      state.lastUpdate = this.updateCount;
    } else {
      this.nodeStates.set(key, { offsetX, offsetZ, lastUpdate: this.updateCount });
    }
    return height;
  }

  private forgetNodesOutside(): void {
    if (this.nodeStates.size <= this.nodeCount * 2) return;
    for (const [key, state] of this.nodeStates) {
      if (state.lastUpdate !== this.updateCount) this.nodeStates.delete(key);
    }
  }
}
