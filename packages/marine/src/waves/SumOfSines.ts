import { MathUtils, Vector2, Vector3 } from 'three';

export interface SumOfSinesOptions {
  /** Number of waves. Each is shorter and lower than the one before. */
  waveCount?: number;
  /** Wavelength the series starts from, in metres; the first wave is already one falloff shorter. */
  wavelength?: number;
  /** Amplitude the series starts from, in metres. */
  amplitude?: number;
  /** Each wave's amplitude is this fraction of the previous one's. */
  amplitudeFalloff?: number;
  /** Each wave's wavelength is this fraction of the previous one's. */
  wavelengthFalloff?: number;
  /** Scales the deep-water phase speed sqrt(g λ / 2π) of every wave. */
  speedFactor?: number;
  /** Gravitational acceleration used for the phase speeds, in m/s². */
  gravity?: number;
  /** Angle (radians) the first wave's direction is derived from. */
  directionSeed?: number;
  /** Added to the direction angle after each wave, scattering the waves' directions. */
  directionStep?: number;
  /** Added to every direction before normalising, so waves lean toward it (x, z). */
  directionBias?: Vector2;
  /** How peaked the crests are: each wave is exp(peakSharpness * sin(phase) - peakOffset). */
  peakSharpness?: number;
  peakOffset?: number;
  /** Added to the simulation time before evaluating the waves, so they don't all start in phase. */
  timeOffset?: number;
  /** Speeds up (> 1) or slows down (< 1) the waves. */
  timeScale?: number;
  /**
   * The finest detail the physics resolves, as the spacing of an imaginary sample grid in
   * metres. Waves too short for that grid fade out of the physics surface, matching what the
   * water mesh renders at its finest level of detail.
   */
  sampleSpacing?: number;
  /** A wave fades in from this many grid samples per period... */
  minSamplesPerPeriod?: number;
  /** ...and is fully present from this many. */
  fullSamplesPerPeriod?: number;
  /** Fixed-point iterations used to find the undisplaced point under a world position. */
  inversionIterations?: number;
}

/** One sinusoid of the sum, as uploaded to the shader. */
export interface WaveComponent {
  readonly amplitude: number;
  readonly wavelength: number;
  /** Spatial frequency: phase changes by `frequency` radians per metre along `direction`. */
  readonly frequency: number;
  /** Temporal frequency: phase changes by `angularFrequency` radians per second. */
  readonly angularFrequency: number;
  readonly direction: Vector2;
}

const DEFAULT_OPTIONS: Required<Omit<SumOfSinesOptions, 'directionBias'>> = {
  waveCount: 46,
  wavelength: 90,
  amplitude: 1.1,
  amplitudeFalloff: 0.86,
  wavelengthFalloff: 0.875,
  speedFactor: 0.8,
  gravity: 9.807,
  directionSeed: 187,
  directionStep: -183.215,
  peakSharpness: 2.4,
  peakOffset: 1,
  timeOffset: 600,
  timeScale: 1,
  // the centre vertex spacing of the default water mesh: 150 m chunks with 292 vertices across
  sampleSpacing: 150 / 292,
  minSamplesPerPeriod: 4,
  fullSamplesPerPeriod: 8,
  inversionIterations: 3,
};

/**
 * An ocean surface made of peaked sinusoids (Acerola's "sum of sines" with exponential waves).
 * Each wave's coordinates are pushed sideways by the slope of the waves before it, which
 * sharpens crests and makes the surface move horizontally, like Gerstner waves.
 *
 * The surface is a pure function of position and time, so physics and rendering agree as long
 * as both are given the same time.
 */
export class SumOfSines {
  readonly waves: readonly WaveComponent[];
  readonly peakSharpness: number;
  readonly peakOffset: number;
  readonly timeOffset: number;
  readonly timeScale: number;
  readonly sampleSpacing: number;
  readonly minSamplesPerPeriod: number;
  readonly fullSamplesPerPeriod: number;
  readonly inversionIterations: number;
  /** Average of exp(peakSharpness sin(t) - peakOffset) over a period; subtracted so the mean sea level is 0. */
  readonly waveShapeMean: number;

  // Per-wave constants as typed arrays: the evaluation loop runs for every buoyancy sample.
  private readonly amplitudes: Float64Array;
  private readonly frequencies: Float64Array;
  private readonly angularFrequencies: Float64Array;
  private readonly directionsX: Float64Array;
  private readonly directionsZ: Float64Array;
  private readonly physicsWeights: Float64Array;
  private readonly displaced = { x: 0, z: 0 };
  /** Undisplaced grid point found by the last heightAt or heightFrom call. */
  readonly lastGridPoint = { x: 0, z: 0 };

  constructor(options: SumOfSinesOptions = {}) {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    this.peakSharpness = settings.peakSharpness;
    this.peakOffset = settings.peakOffset;
    this.timeOffset = settings.timeOffset;
    this.timeScale = settings.timeScale;
    this.sampleSpacing = settings.sampleSpacing;
    this.minSamplesPerPeriod = settings.minSamplesPerPeriod;
    this.fullSamplesPerPeriod = settings.fullSamplesPerPeriod;
    this.inversionIterations = settings.inversionIterations;
    this.waveShapeMean = averageWaveShape(settings.peakSharpness, settings.peakOffset);
    this.waves = generateWaves(settings, options.directionBias ?? new Vector2());

    const count = this.waves.length;
    this.amplitudes = new Float64Array(count);
    this.frequencies = new Float64Array(count);
    this.angularFrequencies = new Float64Array(count);
    this.directionsX = new Float64Array(count);
    this.directionsZ = new Float64Array(count);
    this.physicsWeights = new Float64Array(count);
    this.waves.forEach((wave, index) => {
      this.amplitudes[index] = wave.amplitude;
      this.frequencies[index] = wave.frequency;
      this.angularFrequencies[index] = wave.angularFrequency;
      this.directionsX[index] = wave.direction.x;
      this.directionsZ[index] = wave.direction.y;
      this.physicsWeights[index] = this.resolvability(index, this.sampleSpacing);
    });
  }

  /** Time the waves are evaluated at for a given simulation time. */
  phaseTime(time: number): number {
    return time * this.timeScale + this.timeOffset;
  }

  /**
   * How much of wave `index` a grid with this sample spacing can show without aliasing, from 0
   * (fewer than minSamplesPerPeriod samples per period) to 1 (at least fullSamplesPerPeriod).
   */
  resolvability(index: number, spacing: number): number {
    const period = (2 * Math.PI) / this.waves[index]!.frequency;
    return MathUtils.smoothstep(period / spacing, this.minSamplesPerPeriod, this.fullSamplesPerPeriod);
  }

  /**
   * Where the surface point that started at grid position (gridX, gridZ) is at `time`. The
   * returned point is displaced sideways as well as vertically.
   */
  surfacePoint(gridX: number, gridZ: number, time: number, target = new Vector3()): Vector3 {
    const phaseTime = this.phaseTime(time);
    this.displace(gridX, gridZ, phaseTime);
    return target.set(this.displaced.x, this.heightAtGridPoint(gridX, gridZ, phaseTime), this.displaced.z);
  }

  riseRate(gridX: number, gridZ: number, time: number): number {
    // a central difference in the waves' own time: a millisecond either side
    const phaseTime = this.phaseTime(time);
    const step = 1e-3;
    return ((this.heightAtGridPoint(gridX, gridZ, phaseTime + step) - this.heightAtGridPoint(gridX, gridZ, phaseTime - step)) / (2 * step)) * this.timeScale;
  }

  /** Height of the surface directly above or below the world position (worldX, worldZ) at `time`. */
  heightAt(worldX: number, worldZ: number, time: number): number {
    return this.heightFrom(worldX, worldZ, time, worldX, worldZ, this.inversionIterations);
  }

  /**
   * Like heightAt, but starts the search for the undisplaced grid point at (startGridX,
   * startGridZ) and runs `iterations` steps. A good start, such as the answer for the same point
   * a moment ago, needs a single iteration. The grid point found is left in `lastGridPoint`.
   */
  heightFrom(worldX: number, worldZ: number, time: number, startGridX: number, startGridZ: number, iterations: number): number {
    const phaseTime = this.phaseTime(time);
    // The surface moves sideways, so first find the grid point that lands on (worldX, worldZ).
    // The horizontal displacement is small and smooth, so plain fixed-point iteration converges.
    let gridX = startGridX;
    let gridZ = startGridZ;
    for (let iteration = 0; iteration < iterations; iteration++) {
      this.displace(gridX, gridZ, phaseTime);
      gridX += worldX - this.displaced.x;
      gridZ += worldZ - this.displaced.z;
    }
    this.lastGridPoint.x = gridX;
    this.lastGridPoint.z = gridZ;
    return this.heightAtGridPoint(gridX, gridZ, phaseTime);
  }

  /** Upward unit normal of the surface at the world position (worldX, worldZ), by central differences. */
  normalAt(worldX: number, worldZ: number, time: number, target = new Vector3()): Vector3 {
    const step = 0.01;
    const slopeX = (this.heightAt(worldX + step, worldZ, time) - this.heightAt(worldX - step, worldZ, time)) / (2 * step);
    const slopeZ = (this.heightAt(worldX, worldZ + step, time) - this.heightAt(worldX, worldZ - step, time)) / (2 * step);
    return target.set(-slopeX, 1, -slopeZ).normalize();
  }

  /**
   * Where the grid point ends up horizontally, written to `displaced`. Before each wave, the
   * point is pushed along the slope of the previous one (x first, then z with the updated x, as
   * the shader does).
   */
  private displace(gridX: number, gridZ: number, phaseTime: number): void {
    const { directionsX, directionsZ, physicsWeights } = this;
    let displacedX = gridX;
    let displacedZ = gridZ;
    let previousWeight = physicsWeights[0] ?? 0;
    for (let index = 1; index < physicsWeights.length; index++) {
      const weight = physicsWeights[index]!;
      if (weight <= 0 && previousWeight <= 0) break;
      const previous = index - 1;
      displacedX += previousWeight * this.warpSlope(previous, displacedX, displacedZ, phaseTime) * directionsX[previous]!;
      displacedZ += previousWeight * this.warpSlope(previous, displacedX, displacedZ, phaseTime) * directionsZ[previous]!;
      previousWeight = weight;
    }
    this.displaced.x = displacedX;
    this.displaced.z = displacedZ;
  }

  /** Sum of the waves' heights, each evaluated at the undisplaced grid point. */
  private heightAtGridPoint(gridX: number, gridZ: number, phaseTime: number): number {
    const { amplitudes, frequencies, angularFrequencies, directionsX, directionsZ, physicsWeights } = this;
    let height = 0;
    for (let index = 0; index < amplitudes.length; index++) {
      const weight = physicsWeights[index]!;
      if (weight <= 0) break;
      const phase = frequencies[index]! * (directionsX[index]! * gridX + directionsZ[index]! * gridZ) + angularFrequencies[index]! * phaseTime;
      height += weight * amplitudes[index]! * (Math.exp(this.peakSharpness * Math.sin(phase) - this.peakOffset) - this.waveShapeMean);
    }
    return height;
  }

  /**
   * How far wave `index` pushes a point per unit of its direction. This is the wave's slope with
   * the sharpness left out of the exponent, which keeps the warp gentle.
   */
  private warpSlope(index: number, pointX: number, pointZ: number, phaseTime: number): number {
    const frequency = this.frequencies[index]!;
    const phase = frequency * (this.directionsX[index]! * pointX + this.directionsZ[index]! * pointZ) + this.angularFrequencies[index]! * phaseTime;
    return this.peakSharpness * this.amplitudes[index]! * frequency * Math.cos(phase) * Math.exp(Math.sin(phase) - this.peakOffset);
  }
}

function generateWaves(settings: Required<Omit<SumOfSinesOptions, 'directionBias'>>, directionBias: Vector2): WaveComponent[] {
  const waves: WaveComponent[] = [];
  let amplitude = settings.amplitude;
  let wavelength = settings.wavelength;
  let directionAngle = settings.directionSeed;
  for (let index = 0; index < settings.waveCount; index++) {
    amplitude *= settings.amplitudeFalloff;
    wavelength *= settings.wavelengthFalloff;
    const phaseSpeed = Math.sqrt((settings.gravity * wavelength) / (2 * Math.PI)) * settings.speedFactor;
    const frequency = 2 / wavelength;
    const direction = new Vector2(Math.sin(directionAngle), Math.cos(directionAngle)).add(directionBias).normalize();
    waves.push({ amplitude, wavelength, frequency, angularFrequency: phaseSpeed * frequency, direction });
    directionAngle += settings.directionStep;
  }
  return waves;
}

function averageWaveShape(peakSharpness: number, peakOffset: number): number {
  const samples = 256;
  let sum = 0;
  for (let sample = 0; sample < samples; sample++) {
    sum += Math.exp(peakSharpness * Math.sin((2 * Math.PI * sample) / samples) - peakOffset);
  }
  return sum / samples;
}
