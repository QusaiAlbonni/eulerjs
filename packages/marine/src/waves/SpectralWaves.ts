import { Vector3 } from 'three';
import { stageCount } from './fft.js';
import { createFields, createFieldScratch, evaluateFields, FIELD_COUNT, HEIGHT_FIELD, RISE_FIELD, SIDEWAYS_X_FIELD, SIDEWAYS_Z_FIELD, slotOf } from './spectralFields.js';
import type { FieldScratch, FieldSource, WavePatch } from './spectralFields.js';
import { wavenumberSpectrumOf } from './spectrum.js';
import type { SpectralPort, SpectralReply, SpectralRequest } from './spectralWorker.js';
import type { WaveSurface } from './WaveSurface.js';

export type { WavePatch } from './spectralFields.js';

export interface SpectralWavesOptions {
  /** Wind speed ten metres up, in m/s. Defaults to 12.5, a strong breeze. */
  windSpeed?: number | undefined;
  /** The way the wind blows, in radians from +x toward +z, as Wind's `angle`. Defaults to 0. */
  windAngle?: number | undefined;
  /** How far the wind has blown over open water, in metres. Defaults to 100 km. */
  fetch?: number | undefined;
  /** JONSWAP's γ: 3.3 for a young sea, 1 for a fully grown one. Defaults to 3.3. */
  peakEnhancement?: number | undefined;
  /** How far the surface's points move sideways toward the crests, sharpening them: 0 for none, 1 for the full Gerstner motion, more to fold the crests over. Defaults to 1.3: sharp crests, folding over at the steepest. */
  choppiness?: number | undefined;
  /**
   * Every wave's height times this: more than 1 for a sea larger and wilder than its wind would
   * raise, as a storm's in a film is. Defaults to 2.05: a sea taller than its wind's, as seas in
   * films are, waves 5.3 m high. `windSpeed` is the way to a rougher sea
   * that is still a real one: from 5 m/s a calm sea, through 10 a fresh breeze's to 20 a gale's.
   */
  heightScale?: number | undefined;
  /** For the random phases and amplitudes of the waves: a different seed, a different sea. Defaults to 1. */
  seed?: number | undefined;
  /**
   * The significant height of a swell running under the wind's sea, in metres: a few long waves,
   * hundreds of metres to kilometres long, that the patches are too small to hold. They are
   * summed where they are, not tiled, so they never repeat, and from afar they break up the
   * patches' repeats. 0 for none. Defaults to 2.
   */
  swellHeight?: number | undefined;
  /**
   * Fades the shortest waves out, the spectrum times e^(-k² ℓ²) for this length ℓ in metres (as
   * Acerola's short waves fade): waves much shorter than 2πℓ are gone, for a smoother, glassier
   * sea. Defaults to 0, none faded.
   */
  shortWaveFade?: number | undefined;
  /** How many long waves the swell is made of. Defaults to 8. */
  swellCount?: number | undefined;
  /** The shortest and longest of the swell's waves, in metres. Defaults to 200 and 1000. */
  swellWavelengths?: readonly [number, number] | undefined;
  /** The way the swell runs, in radians as `windAngle`. Defaults to the wind's way. */
  swellAngle?: number | undefined;
  /** How far, in radians either side, the swell's waves run from `swellAngle`. Defaults to 0.5. */
  swellSpread?: number | undefined;
  /**
   * How much rougher and calmer the sea is from place to place, as the wind gusts: the waves of
   * the patches up to `gustPatches` in size scaled up and down by about this much over stretches a
   * kilometre or two across, in a pattern that never repeats. From afar, the sea's texture then
   * varies as a real one's does, which hides the patches' repeats. 0 for an even sea. Defaults to 0.3.
   */
  gustiness?: number | undefined;
  /** Patches up to this size, in metres, gust. Defaults to 150. */
  gustPatches?: number | undefined;
  /** About how far across the gusts' stretches are, in metres. Defaults to 1500. */
  gustScale?: number | undefined;
  /**
   * Edge lengths of the square patches the sea is made of, in metres, from the largest. Each holds
   * the waves too short for the one before it and long enough for its own, and the patches tile
   * the sea; sizes that don't divide each other keep their repeats from lining up. The smallest
   * sets how fine the water drawn close up gets. Defaults to 512, 113, 25, 5.5 and 1.2 m: waves
   * from half a kilometre long down to a couple of centimetres.
   */
  patchSizes?: readonly number[] | undefined;
  /**
   * Waves across each patch the water mesh draws, a power of two. Each patch holds only the waves
   * from 4 to about 20 across it before the next takes over, so this matters for the smallest
   * only: 128 takes it down to waves 2 cm long, 64 to 4 cm for a sixth less time on the GPU.
   * Defaults to 128.
   */
  resolution?: number | undefined;
  /**
   * Waves across each patch the physics evaluates, a power of two no more than `resolution`: the
   * physics floats on the same waves as the water mesh draws, the longest of them. Defaults to 64.
   */
  physicsResolution?: number | undefined;
  /** How many of the patches, from the largest, the physics evaluates. Defaults to 2. */
  physicsPatches?: number | undefined;
  /** Speeds the sea up (> 1) or slows it down. Defaults to 1. */
  timeScale?: number | undefined;
  /** Added to the time the sea is evaluated at. Defaults to 0. */
  timeOffset?: number | undefined;
  /**
   * The sea repeats exactly every this many seconds, every wave's frequency rounded to a whole
   * number of turns in it (by at most π / loopPeriod rad/s), so that the time the waves are
   * evaluated at can wrap round. The GPU works in single precision, so that keeps its waves to
   * the physics' however long the sea runs: without it they would drift apart by a part in a few
   * thousand within the hour. Infinity for no loop. Defaults to 1000 s.
   */
  loopPeriod?: number | undefined;
  /** Fixed-point steps to find the undisplaced point under a world position. Defaults to 3. */
  inversionIterations?: number | undefined;
  gravity?: number | undefined;
}

/** Each patch's band starts at this many of its own fundamental wavenumbers, 2π / size, below which its waves are too few to look random. */
const BAND_START = 4;

/**
 * An ocean of hundreds of thousands of waves, drawn from the JONSWAP spectrum of a wind sea and
 * summed by inverse FFT (Tessendorf's "Simulating Ocean Water"): linear waves, sharpened at the
 * crests by moving the surface's points sideways toward them.
 *
 * The sea is a few square patches of different sizes, tiled, each holding its own band of
 * wavelengths. The water mesh sums every wave of every patch on the GPU; the physics sums, on
 * the CPU, the longest of them, those of the largest patches up to `physicsResolution` waves
 * across: the waves a hull rides on, the same in both. Its FFT runs once a time step, and a
 * height is then a few lookups in its grids.
 */
export class SpectralWaves implements WaveSurface {
  readonly patches: readonly WavePatch[];
  readonly timeScale: number;
  readonly timeOffset: number;
  readonly loopPeriod: number;
  readonly inversionIterations: number;
  readonly gravity: number;
  readonly physicsResolution: number;
  readonly lastGridPoint = { x: 0, z: 0 };
  /** The swell's long waves, as their amplitude is for the sea's `swellHeight` now. */
  readonly swell: readonly SwellWave[];
  /** Each swell wave's phase at `swellTime`: its own, less how far it has turned by then. */
  private readonly swellPhases: Float64Array;
  private swellTime = Number.NaN;
  private readonly swellAtPoint = { height: 0, sidewaysX: 0, sidewaysZ: 0, rise: 0 };
  /** The gusts' pattern: a few long sines, each (kx, kz, phase), summed. */
  readonly gusts: readonly { readonly waveNumberX: number; readonly waveNumberZ: number; readonly phase: number }[];
  /** Patches as small as this or smaller gust. */
  readonly gustPatches: number;
  /** Evaluations the worker had ready, and those it didn't and the main thread did instead. */
  readonly workerStatistics = { ready: 0, missed: 0 };
  /** Counts the changes `setSea` has made, for those drawing the waves to notice. */
  version = 0;

  private seaSettings: Readonly<SeaSettings>;
  private waveHeight = 0;
  private waveHeightVersion = Number.NaN;
  private readonly seed: number;
  /** What the physics evaluates: its patches at its resolution. */
  private source: FieldSource;
  private readonly scratch: FieldScratch;
  /** The last two evaluations, by simulation time, so physics steps and render frames between them don't redo each other's. */
  private fields: Float64Array;
  private evaluatedAt = Number.NaN;
  private previousFields: Float64Array;
  private previousAt = Number.NaN;
  private readonly displaced = { x: 0, z: 0 };

  private worker: SpectralPort | undefined;
  /** Evaluations the worker has sent back, by simulation time, and those it is still working on. */
  private readonly arrived = new Map<number, Float64Array>();
  private readonly requested = new Set<number>();
  private readonly spareFields: Float64Array[] = [];

  constructor(options: SpectralWavesOptions = {}) {
    this.gravity = options.gravity ?? 9.807;
    this.seaSettings = checkedSea({
      windSpeed: options.windSpeed ?? 12.5,
      windAngle: options.windAngle ?? 0,
      fetch: options.fetch ?? 100_000,
      peakEnhancement: options.peakEnhancement ?? 3.3,
      choppiness: options.choppiness ?? 1.3,
      heightScale: options.heightScale ?? 2.05,
      swellHeight: options.swellHeight ?? 2,
      gustiness: options.gustiness ?? 0.3,
      shortWaveFade: options.shortWaveFade ?? 0,
    });
    this.seed = options.seed ?? 1;
    this.swell = makeSwell(options, this.seed, this.gravity, options.loopPeriod ?? 1000);
    this.swellPhases = new Float64Array(this.swell.length);
    this.gusts = makeGusts(options.gustScale ?? 1500, this.seed);
    this.gustPatches = options.gustPatches ?? 150;
    const resolution = options.resolution ?? 128;
    stageCount(resolution);
    this.physicsResolution = options.physicsResolution ?? 64;
    stageCount(this.physicsResolution);
    if (this.physicsResolution > resolution) throw new RangeError(`physicsResolution (${this.physicsResolution}) can't be more than resolution (${resolution})`);
    this.timeScale = options.timeScale ?? 1;
    this.timeOffset = options.timeOffset ?? 0;
    this.loopPeriod = options.loopPeriod ?? 1000;
    if (!(this.loopPeriod > 0)) throw new RangeError(`loopPeriod must be positive, got ${this.loopPeriod}`);
    this.inversionIterations = options.inversionIterations ?? 3;

    const sizes = options.patchSizes ?? [512, 113, 25, 5.5, 1.2];
    this.patches = sizes.map((size, index) => {
      const lowest = index === 0 ? 0 : (BAND_START * 2 * Math.PI) / size;
      const highest = index + 1 < sizes.length ? (BAND_START * 2 * Math.PI) / sizes[index + 1]! : Infinity;
      return makePatch(size, resolution, lowest, highest, this.gravity, this.loopPeriod);
    });
    this.patches.forEach((patch, index) => fillAmplitudes(patch, this.seaSettings, this.gravity, this.seed + 7919 * index));
    setSwellAmplitudes(this.swell, this.seaSettings.swellHeight);

    const physicsPatches = Math.min(options.physicsPatches ?? 2, this.patches.length);
    this.source = { patches: this.patches.slice(0, physicsPatches), resolution: this.physicsResolution, choppiness: this.seaSettings.choppiness };
    this.scratch = createFieldScratch(this.physicsResolution);
    this.fields = createFields(this.source);
    this.previousFields = createFields(this.source);
  }

  /** The wind and waves the sea is made of now. */
  get sea(): Readonly<SeaSettings> {
    return this.seaSettings;
  }

  get choppiness(): number {
    return this.seaSettings.choppiness;
  }

  /**
   * Changes the wind, or the waves' height or choppiness, while the sea runs. Each wave keeps the
   * random draw it was made with, so the sea changes into the new one smoothly, swell by swell,
   * rather than starting another; the physics, the worker and the water drawn all follow.
   */
  setSea(changes: Partial<SeaSettings>): void {
    this.seaSettings = checkedSea({ ...this.seaSettings, ...changes });
    this.patches.forEach((patch, index) => fillAmplitudes(patch, this.seaSettings, this.gravity, this.seed + 7919 * index));
    setSwellAmplitudes(this.swell, this.seaSettings.swellHeight);
    this.source = { ...this.source, choppiness: this.seaSettings.choppiness };
    this.version++;
    // nothing evaluated before holds
    this.evaluatedAt = this.previousAt = Number.NaN;
    for (const fields of this.arrived.values()) this.spareFields.push(fields);
    this.arrived.clear();
    this.requested.clear();
    if (this.worker) this.sendSetup(this.worker);
  }

  /**
   * The significant wave height, Hs: four times the standard deviation of the surface's height,
   * about the mean height of the highest third of the waves, as a sea state is given in.
   */
  get significantWaveHeight(): number {
    if (this.waveHeightVersion === this.version) return this.waveHeight;
    let variance = 0;
    for (const patch of this.patches) {
      const amplitudes = patch.amplitudes;
      // each wave's own h₀ and its opposite's: E|h(k)|² = |h₀(k)|² + |h₀(-k)|²
      for (let at = 0; at < amplitudes.length; at++) variance += amplitudes[at]! * amplitudes[at]!;
    }
    for (const wave of this.swell) variance += (wave.amplitude * wave.amplitude) / 2;
    this.waveHeight = 4 * Math.sqrt(variance);
    this.waveHeightVersion = this.version;
    return this.waveHeight;
  }

  /** Time the waves are evaluated at for a given simulation time: scaled, offset, and wrapped round the loop period. */
  phaseTime(time: number): number {
    const scaled = time * this.timeScale + this.timeOffset;
    if (!Number.isFinite(this.loopPeriod)) return scaled;
    const wrapped = scaled % this.loopPeriod;
    return wrapped < 0 ? wrapped + this.loopPeriod : wrapped;
  }

  /**
   * Evaluates the physics' waves in a worker from now on, for the times `prefetch` asks for ahead
   * (Buoyancy asks for the next few steps'); any other time, or one the worker hasn't finished,
   * is still evaluated here. `port` is a Worker running `@eulerjs/marine/spectral-worker`.
   */
  useWorker(port: SpectralPort): void {
    this.worker = port;
    this.sendSetup(port);
    port.onmessage = (event: MessageEvent) => {
      const reply = event.data as SpectralReply;
      // evaluated for a sea since changed, or too late: the physics has moved on
      if (reply.version !== this.version || reply.time < this.evaluatedAt) {
        this.spareFields.push(reply.fields);
        return;
      }
      this.requested.delete(reply.time);
      this.arrived.set(reply.time, reply.fields);
    };
  }

  private sendSetup(port: SpectralPort): void {
    const patches = this.source.patches.map(({ size, resolution, amplitudes, angularFrequencies }) => ({ size, resolution, amplitudes, angularFrequencies }));
    const setup: SpectralRequest = { kind: 'setup', source: { patches, resolution: this.source.resolution, choppiness: this.source.choppiness } };
    port.postMessage(setup, []);
  }

  /** Asks the worker, if there is one, to evaluate the waves at `time` before they are needed. */
  prefetch(time: number): void {
    if (!this.worker) return;
    if (time === this.evaluatedAt || time === this.previousAt || this.requested.has(time) || this.arrived.has(time)) return;
    this.requested.add(time);
    const fields = this.spareFields.pop() ?? createFields(this.source);
    const request: SpectralRequest = { kind: 'evaluate', time, phaseTime: this.phaseTime(time), version: this.version, fields };
    this.worker.postMessage(request, [fields.buffer]);
  }

  heightAt(worldX: number, worldZ: number, time: number): number {
    return this.heightFrom(worldX, worldZ, time, worldX, worldZ, this.inversionIterations);
  }

  heightFrom(worldX: number, worldZ: number, time: number, startGridX: number, startGridZ: number, iterations: number): number {
    this.evaluate(time);
    this.turnSwell(time);
    let gridX = startGridX;
    let gridZ = startGridZ;
    for (let iteration = 0; iteration < iterations; iteration++) {
      this.displace(gridX, gridZ);
      gridX += worldX - this.displaced.x;
      gridZ += worldZ - this.displaced.z;
    }
    this.lastGridPoint.x = gridX;
    this.lastGridPoint.z = gridZ;
    this.sampleSwell(gridX, gridZ);
    return this.sample(gridX, gridZ, HEIGHT_FIELD) + this.swellAtPoint.height;
  }

  surfacePoint(gridX: number, gridZ: number, time: number, target = new Vector3()): Vector3 {
    this.evaluate(time);
    this.turnSwell(time);
    this.displace(gridX, gridZ);
    return target.set(this.displaced.x, this.sample(gridX, gridZ, HEIGHT_FIELD) + this.swellAtPoint.height, this.displaced.z);
  }

  riseRate(gridX: number, gridZ: number, time: number): number {
    this.evaluate(time);
    this.turnSwell(time);
    this.sampleSwell(gridX, gridZ);
    // the fields are per unit of the waves' own time
    return (this.sample(gridX, gridZ, RISE_FIELD) + this.swellAtPoint.rise) * this.timeScale;
  }

  /**
   * Each swell wave's phase at `time`, into `target`: its own, less how far it has turned, worked
   * out in double precision and wrapped into a turn, so that it is as exact on the GPU.
   */
  swellPhasesAt(time: number, target: Float64Array): Float64Array {
    const phaseTime = this.phaseTime(time);
    this.swell.forEach((wave, index) => {
      const phase = wave.phase - wave.angularFrequency * phaseTime;
      target[index] = phase - 2 * Math.PI * Math.floor(phase / (2 * Math.PI));
    });
    return target;
  }

  private turnSwell(time: number): void {
    if (time === this.swellTime) return;
    this.swellPhasesAt(time, this.swellPhases);
    this.swellTime = time;
  }

  /**
   * The swell at the undisplaced grid point, into `swellAtPoint`: each wave a cos(k·x + phase),
   * moved sideways -k̂ λ a sin(…) as the patches' waves are, and rising ω a sin(…).
   */
  private sampleSwell(gridX: number, gridZ: number): void {
    const result = this.swellAtPoint;
    result.height = result.sidewaysX = result.sidewaysZ = result.rise = 0;
    const choppiness = this.seaSettings.choppiness;
    this.swell.forEach((wave, index) => {
      if (wave.amplitude === 0) return;
      const angle = wave.waveNumber * (wave.directionX * gridX + wave.directionZ * gridZ) + this.swellPhases[index]!;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      result.height += wave.amplitude * cosine;
      result.sidewaysX -= choppiness * wave.amplitude * wave.directionX * sine;
      result.sidewaysZ -= choppiness * wave.amplitude * wave.directionZ * sine;
      result.rise += wave.angularFrequency * wave.amplitude * sine;
    });
  }

  normalAt(worldX: number, worldZ: number, time: number, target = new Vector3()): Vector3 {
    const step = 0.05;
    const slopeX = (this.heightAt(worldX + step, worldZ, time) - this.heightAt(worldX - step, worldZ, time)) / (2 * step);
    const slopeZ = (this.heightAt(worldX, worldZ + step, time) - this.heightAt(worldX, worldZ - step, time)) / (2 * step);
    return target.set(-slopeX, 1, -slopeZ).normalize();
  }

  /** Makes the physics' fields those at `time`: kept from before, sent back by the worker, or evaluated here. */
  private evaluate(time: number): void {
    if (time === this.evaluatedAt) return;
    if (time === this.previousAt) {
      [this.fields, this.previousFields] = [this.previousFields, this.fields];
      [this.evaluatedAt, this.previousAt] = [this.previousAt, this.evaluatedAt];
      return;
    }
    const ready = this.arrived.get(time);
    if (ready) {
      this.arrived.delete(time);
      this.spareFields.push(this.previousFields);
      this.previousFields = this.fields;
      this.fields = ready;
      this.workerStatistics.ready++;
    } else {
      [this.fields, this.previousFields] = [this.previousFields, this.fields];
      evaluateFields(this.source, this.phaseTime(time), this.fields, this.scratch);
      if (this.requested.has(time)) this.workerStatistics.missed++;
    }
    this.previousAt = this.evaluatedAt;
    this.evaluatedAt = time;
    // the worker's evaluations for times now past are of no more use
    for (const [arrivedAt, fields] of this.arrived) {
      if (arrivedAt < time) {
        this.arrived.delete(arrivedAt);
        this.spareFields.push(fields);
      }
    }
  }

  /** Where the undisplaced grid point (gridX, gridZ) has moved to, into `displaced`. */
  private displace(gridX: number, gridZ: number): void {
    this.sampleSwell(gridX, gridZ);
    this.displaced.x = gridX + this.sample(gridX, gridZ, SIDEWAYS_X_FIELD) + this.swellAtPoint.sidewaysX;
    this.displaced.z = gridZ + this.sample(gridX, gridZ, SIDEWAYS_Z_FIELD) + this.swellAtPoint.sidewaysZ;
  }

  /** One of the evaluated fields at a world position, summed over the physics' patches, each interpolated bilinearly in its tiled grid. */
  private sample(worldX: number, worldZ: number, field: number): number {
    const resolution = this.physicsResolution;
    const cells = resolution * resolution;
    const fields = this.fields;
    const patches = this.source.patches;
    const gust = this.gustAt(worldX, worldZ);
    let total = 0;
    for (let index = 0; index < patches.length; index++) {
      const size = patches[index]!.size;
      const scale = size <= this.gustPatches ? gust : 1;
      const start = (index * FIELD_COUNT + field) * cells;
      const column = (worldX / size) * resolution;
      const row = (worldZ / size) * resolution;
      const firstColumn = Math.floor(column);
      const firstRow = Math.floor(row);
      const alongColumn = column - firstColumn;
      const alongRow = row - firstRow;
      const left = wrap(firstColumn, resolution);
      const right = wrap(firstColumn + 1, resolution);
      const near = start + wrap(firstRow, resolution) * resolution;
      const far = start + wrap(firstRow + 1, resolution) * resolution;
      const nearValue = fields[near + left]! + (fields[near + right]! - fields[near + left]!) * alongColumn;
      const farValue = fields[far + left]! + (fields[far + right]! - fields[far + left]!) * alongColumn;
      total += (nearValue + (farValue - nearValue) * alongRow) * scale;
    }
    return total;
  }

  /**
   * How much the gusting patches' waves are scaled by at the undisplaced grid point: one, plus the
   * gustiness times the gusts' pattern, about as often above as below and seldom past two.
   */
  gustAt(gridX: number, gridZ: number): number {
    const gustiness = this.seaSettings.gustiness;
    if (gustiness === 0) return 1;
    let pattern = 0;
    for (const gust of this.gusts) pattern += Math.sin(gust.waveNumberX * gridX + gust.waveNumberZ * gridZ + gust.phase);
    // a sum of sines' standard deviation is √(count / 2)
    return Math.max(0.05, 1 + (gustiness * pattern) / Math.sqrt(this.gusts.length / 2));
  }
}

/** The gusts' long sines: four, their lengths about the scale and none dividing another, their ways spread round. */
function makeGusts(scale: number, seed: number): { waveNumberX: number; waveNumberZ: number; phase: number }[] {
  let state = (seed * 1103515245 + 12345) % 2147483647 || 1;
  const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
  return [1, 1.37, 1.91, 2.63].map((ratio, index) => {
    const wavelength = (2 * scale) / ratio;
    const direction = (index * 2.39996 + random()) % (2 * Math.PI);
    const waveNumber = (2 * Math.PI) / wavelength;
    return { waveNumberX: waveNumber * Math.cos(direction), waveNumberZ: waveNumber * Math.sin(direction), phase: 2 * Math.PI * random() };
  });
}

function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/**
 * Two standard normal numbers for wavenumber (column, row) of a patch, from a hash of them and the
 * seed: the same wave gets the same amplitude however many waves across the patch is evaluated.
 */
function gaussianPair(column: number, row: number, seed: number): [number, number] {
  let hash = Math.imul(column, 0x27d4eb2d) ^ Math.imul(row, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  const next = () => {
    hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    hash ^= hash >>> 16;
    return ((hash >>> 0) + 0.5) / 4294967296;
  };
  const radius = Math.sqrt(-2 * Math.log(next()));
  const turn = 2 * Math.PI * next();
  return [radius * Math.cos(turn), radius * Math.sin(turn)];
}

/** The wind and waves a SpectralWaves is made of; see SpectralWavesOptions for each. */
export interface SeaSettings {
  windSpeed: number;
  windAngle: number;
  fetch: number;
  peakEnhancement: number;
  choppiness: number;
  heightScale: number;
  swellHeight: number;
  gustiness: number;
  shortWaveFade: number;
}

/** One of the swell's long waves: running along (directionX, directionZ), a unit vector. */
export interface SwellWave {
  readonly directionX: number;
  readonly directionZ: number;
  /** In rad/m. */
  readonly waveNumber: number;
  readonly angularFrequency: number;
  /** Its own phase, at time 0. */
  readonly phase: number;
  /** In metres: set for the sea's swell height. */
  amplitude: number;
}

/**
 * The swell's waves: wavelengths spread evenly in their logarithm between the shortest and the
 * longest, a little off it at random so none divides another; directions spread about the
 * swell's way; frequencies, as the patches' waves', whole turns in the loop period.
 */
function makeSwell(options: SpectralWavesOptions, seed: number, gravity: number, loopPeriod: number): SwellWave[] {
  const count = options.swellCount ?? 8;
  const [shortest, longest] = options.swellWavelengths ?? [200, 1000];
  const angle = options.swellAngle ?? options.windAngle ?? 0;
  const spread = options.swellSpread ?? 0.5;
  const turnRate = (2 * Math.PI) / loopPeriod;
  let state = (seed * 2654435761) % 2147483647 || 1;
  const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
  return Array.from({ length: count }, (_unused, index) => {
    const along = count === 1 ? 0.5 : (index + 0.3 * (random() - 0.5)) / (count - 1);
    const wavelength = shortest * Math.pow(longest / shortest, Math.min(1, Math.max(0, along)));
    const waveNumber = (2 * Math.PI) / wavelength;
    const direction = angle + spread * (2 * random() - 1);
    const angularFrequency = Math.sqrt(gravity * waveNumber);
    return {
      directionX: Math.cos(direction),
      directionZ: Math.sin(direction),
      waveNumber,
      angularFrequency: Number.isFinite(loopPeriod) ? Math.max(1, Math.round(angularFrequency / turnRate)) * turnRate : angularFrequency,
      phase: 2 * Math.PI * random(),
      amplitude: 0,
    };
  });
}

/** Each swell wave an equal share of the swell's variance, (height / 4)²: a cosine's is a² / 2. */
function setSwellAmplitudes(swell: readonly SwellWave[], height: number): void {
  const amplitude = swell.length === 0 ? 0 : (Math.SQRT2 * (height / 4)) / Math.sqrt(swell.length);
  for (const wave of swell) wave.amplitude = amplitude;
}

function checkedSea(sea: SeaSettings): SeaSettings {
  for (const name of ['windSpeed', 'fetch', 'peakEnhancement', 'heightScale'] as const) {
    if (!(sea[name] > 0) || !Number.isFinite(sea[name])) throw new RangeError(`${name} must be a positive number, got ${sea[name]}`);
  }
  if (!(sea.choppiness >= 0)) throw new RangeError(`choppiness can't be negative, got ${sea.choppiness}`);
  if (!(sea.swellHeight >= 0)) throw new RangeError(`swellHeight can't be negative, got ${sea.swellHeight}`);
  if (!(sea.gustiness >= 0)) throw new RangeError(`gustiness can't be negative, got ${sea.gustiness}`);
  if (!(sea.shortWaveFade >= 0)) throw new RangeError(`shortWaveFade can't be negative, got ${sea.shortWaveFade}`);
  return sea;
}

/** A patch's grid and how fast each of its waves turns; its waves' heights are `fillAmplitudes`'. */
function makePatch(size: number, resolution: number, lowest: number, highest: number, gravity: number, loopPeriod: number): WavePatch {
  const step = (2 * Math.PI) / size;
  const angularFrequencies = new Float64Array(resolution * resolution);
  const turnRate = (2 * Math.PI) / loopPeriod;
  const half = resolution / 2;
  for (let row = -half; row < half; row++) {
    for (let column = -half; column < half; column++) {
      const slot = slotOf(row, resolution) * resolution + slotOf(column, resolution);
      const angularFrequency = Math.sqrt(gravity * Math.hypot(column * step, row * step));
      angularFrequencies[slot] = Number.isFinite(loopPeriod) ? Math.round(angularFrequency / turnRate) * turnRate : angularFrequency;
    }
  }
  return { size, resolution, lowestWaveNumber: lowest, highestWaveNumber: highest, amplitudes: new Float32Array(4 * resolution * resolution), angularFrequencies };
}

/**
 * A patch's waves for a sea: h₀(k) = (ξ₁ + i ξ₂) √(P(k) / 2) with P(k) = S(k) Δk² / 2, so that each
 * wave and its opposite together carry the spectrum's share of the variance, S(k) Δk², over their
 * pair; times the height scale. The ξ are drawn from the wave's own place and the seed alone, so a
 * changed wind changes each wave's height but not its phase.
 */
function fillAmplitudes(patch: WavePatch, settings: SeaSettings, gravity: number, seed: number): void {
  const { size, resolution, lowestWaveNumber: lowest, highestWaveNumber: highest, amplitudes } = patch;
  const spectrum = wavenumberSpectrumOf(settings.windAngle, { windSpeed: settings.windSpeed, fetch: settings.fetch, peakEnhancement: settings.peakEnhancement, gravity });
  const step = (2 * Math.PI) / size;
  const half = resolution / 2;
  // each wave's h₀ once, in its slot's first two places, then its partner's conjugate after it
  amplitudes.fill(0);
  // the edge of the grid, whose waves are two samples long and alias, is left out
  const reach = Math.min(half - 1, Math.ceil(highest / step));
  for (let row = -reach; row <= reach; row++) {
    for (let column = -reach; column <= reach; column++) {
      const waveNumber = Math.hypot(column, row) * step;
      if (waveNumber < lowest || waveNumber >= highest || waveNumber === 0) continue;
      // the spectrum faded at the short end by e^(-k² ℓ²): the amplitude, its square root, by half that
    const faded = Math.exp(-0.5 * (waveNumber * settings.shortWaveFade) ** 2);
    const share = settings.heightScale * faded * Math.sqrt((spectrum(column * step, row * step) * step * step) / 4);
      const [real, imaginary] = gaussianPair(column, row, seed);
      const at = 4 * (slotOf(row, resolution) * resolution + slotOf(column, resolution));
      amplitudes[at] = real * share;
      amplitudes[at + 1] = imaginary * share;
    }
  }
  for (let row = -reach; row <= reach; row++) {
    for (let column = -reach; column <= reach; column++) {
      const at = 4 * (slotOf(row, resolution) * resolution + slotOf(column, resolution));
      const partnerAt = 4 * (slotOf(-row, resolution) * resolution + slotOf(-column, resolution));
      amplitudes[at + 2] = amplitudes[partnerAt]!;
      amplitudes[at + 3] = -amplitudes[partnerAt + 1]!;
    }
  }
}
