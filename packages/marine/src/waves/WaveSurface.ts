import type { Vector3 } from 'three';

/**
 * A moving sea surface, as the physics needs it: a pure function of position and time, whose
 * points also move sideways (so a world position's height takes finding which point of the
 * undisturbed grid has moved there). SumOfSines and SpectralWaves are both one.
 */
export interface WaveSurface {
  /** Height of the surface directly above or below the world position (worldX, worldZ) at `time`. */
  heightAt(worldX: number, worldZ: number, time: number): number;
  /**
   * Like heightAt, but starts the search for the undisplaced grid point at (startGridX,
   * startGridZ) and runs `iterations` steps; a good start needs one. The grid point found is left
   * in `lastGridPoint`.
   */
  heightFrom(worldX: number, worldZ: number, time: number, startGridX: number, startGridZ: number, iterations: number): number;
  /** The undisplaced grid point the last heightAt or heightFrom found. */
  readonly lastGridPoint: { readonly x: number; readonly z: number };
  /** Upward unit normal of the surface at the world position (worldX, worldZ). */
  normalAt(worldX: number, worldZ: number, time: number, target?: Vector3): Vector3;
  /** Where the surface point that started at grid position (gridX, gridZ) is at `time`, displaced sideways as well as up. */
  surfacePoint(gridX: number, gridZ: number, time: number, target?: Vector3): Vector3;
  /**
   * How fast the surface point that started at grid position (gridX, gridZ) rises at `time`, in
   * m/s: the water's own vertical velocity there, which is slower than the surface rises at a
   * fixed place as a steep crest passes it. For floating bodies to move with the water. A surface
   * without it, Buoyancy damps against the surface's rise at the place instead.
   */
  riseRate?(gridX: number, gridZ: number, time: number): number;
  /** A hint that the surface will be asked about at `time` soon, for a surface that can get ready ahead (SpectralWaves in a worker). */
  prefetch?(time: number): void;
}
