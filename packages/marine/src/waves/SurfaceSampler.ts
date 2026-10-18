import type { WaveSurface } from './WaveSurface.js';

/**
 * Surface heights under a fixed set of points that move a little between calls, such as the
 * cells of a floating hull. Each point remembers how far its undisplaced grid point was from it
 * last time and starts from there, so a single iteration finds the displaced surface.
 */
export class SurfaceSampler {
  readonly waves: WaveSurface;
  /** Iterations per call once a point has a remembered offset. */
  readonly warmIterations: number;
  // Grid point minus world point for each point; NaN until the point is first sampled.
  private readonly offsetsX: Float64Array;
  private readonly offsetsZ: Float64Array;

  constructor(waves: WaveSurface, pointCount: number, warmIterations = 1) {
    this.waves = waves;
    this.warmIterations = warmIterations;
    this.offsetsX = new Float64Array(pointCount).fill(Number.NaN);
    this.offsetsZ = new Float64Array(pointCount).fill(Number.NaN);
  }

  get pointCount(): number {
    return this.offsetsX.length;
  }

  heightAt(pointIndex: number, worldX: number, worldZ: number, time: number): number {
    const offsetX = this.offsetsX[pointIndex]!;
    const isWarm = !Number.isNaN(offsetX);
    const height = isWarm
      ? this.waves.heightFrom(worldX, worldZ, time, worldX + offsetX, worldZ + this.offsetsZ[pointIndex]!, this.warmIterations)
      : this.waves.heightAt(worldX, worldZ, time);
    this.offsetsX[pointIndex] = this.waves.lastGridPoint.x - worldX;
    this.offsetsZ[pointIndex] = this.waves.lastGridPoint.z - worldZ;
    return height;
  }

  /** Forgets every remembered offset, e.g. after teleporting the points. */
  reset(): void {
    this.offsetsX.fill(Number.NaN);
    this.offsetsZ.fill(Number.NaN);
  }
}
