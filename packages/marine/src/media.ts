import { Vector3 } from 'three';
import { SpectralWaves } from './waves/SpectralWaves.js';
import { SurfaceSampler } from './waves/SurfaceSampler.js';
import type { WaveSurface } from './waves/WaveSurface.js';

/** A fluid a foil can move through: its density and how it flows. */
export interface FluidMedium {
  /** In kg/m³. */
  readonly density: number;
  /** Velocity of the fluid at `point` and `time`, in m/s, written into `target`. */
  velocityAt(point: Vector3, time: number, target: Vector3): Vector3;
}

export interface OceanOptions<Waves extends WaveSurface = SpectralWaves> {
  /**
   * A SpectralWaves or a SumOfSines. Defaults to `new SpectralWaves()`, a fresh breeze's sea,
   * which SpectralWater draws with WebGPURenderer; for WebGLRenderer's WaterMesh, give a SumOfSines.
   */
  waves?: Waves | undefined;
  /** Defaults to seawater, 1029 kg/m³. */
  density?: number | undefined;
}

/** Water with a wavy surface. The water itself is still; only the surface moves. */
export class Ocean<Waves extends WaveSurface = SpectralWaves> implements FluidMedium {
  readonly waves: Waves;
  density: number;

  constructor(options: OceanOptions<Waves> = {}) {
    // with no waves given, Waves is its default, SpectralWaves
    this.waves = options.waves ?? (new SpectralWaves() as WaveSurface as Waves);
    this.density = options.density ?? 1029;
  }

  surfaceHeight(worldX: number, worldZ: number, time: number): number {
    return this.waves.heightAt(worldX, worldZ, time);
  }

  /** A faster way to sample the surface under a fixed set of moving points, e.g. a hull's cells. */
  createSurfaceSampler(pointCount: number): SurfaceSampler {
    return new SurfaceSampler(this.waves, pointCount);
  }

  surfaceNormal(worldX: number, worldZ: number, time: number, target = new Vector3()): Vector3 {
    return this.waves.normalAt(worldX, worldZ, time, target);
  }

  velocityAt(_point: Vector3, _time: number, target: Vector3): Vector3 {
    return target.set(0, 0, 0);
  }
}

export interface WindOptions {
  /** In m/s. Defaults to 13. */
  speed?: number | undefined;
  /** Direction the wind blows toward, in radians from +x toward +z. Defaults to 1.3. */
  angle?: number | undefined;
  /** Defaults to air at sea level, 1.293 kg/m³. */
  density?: number | undefined;
}

/** A steady, uniform wind. */
export class Wind implements FluidMedium {
  speed: number;
  angle: number;
  density: number;

  constructor(options: WindOptions = {}) {
    this.speed = options.speed ?? 13;
    this.angle = options.angle ?? 1.3;
    this.density = options.density ?? 1.293;
  }

  velocityAt(_point: Vector3, _time: number, target: Vector3): Vector3 {
    return target.set(Math.cos(this.angle), 0, Math.sin(this.angle)).multiplyScalar(this.speed);
  }
}
