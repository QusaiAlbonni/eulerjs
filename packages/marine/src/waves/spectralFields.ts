import { inverseFft2d } from './fft.js';

/**
 * The waves of one patch: for each wavenumber on its grid, the initial amplitude h₀(k) and its
 * partner's conjugate h₀*(-k), and how fast the wave turns, ω = √(g|k|). Zero outside the patch's
 * band of wavenumbers.
 */
export interface WavePatch {
  readonly size: number;
  readonly resolution: number;
  /** The band of |k| the patch holds, in rad/m: from `lowestWaveNumber` up to, not including, `highestWaveNumber`. */
  readonly lowestWaveNumber: number;
  readonly highestWaveNumber: number;
  /** Four numbers a wavenumber, row by row: h₀(k) real and imaginary, then h₀*(-k)'s. */
  readonly amplitudes: Float32Array;
  /** Each a whole number of turns in the sea's loop period, if it has one, so the sea repeats exactly. */
  readonly angularFrequencies: Float64Array;
}

/** The fields evaluated for each patch, in this order, each a grid of `resolution`² values. */
export const FIELD_COUNT = 4;
export const HEIGHT_FIELD = 0;
export const SIDEWAYS_X_FIELD = 1;
export const SIDEWAYS_Z_FIELD = 2;
/** How fast the surface's point rises, m/s: the water's own vertical velocity at the surface. */
export const RISE_FIELD = 3;

/** What evaluating the fields takes besides the time: the same on the main thread and in a worker. */
export interface FieldSource {
  readonly patches: readonly Pick<WavePatch, 'size' | 'resolution' | 'amplitudes' | 'angularFrequencies'>[];
  /** Waves across each patch evaluated, a power of two no more than the patches' own. */
  readonly resolution: number;
  readonly choppiness: number;
}

/** Room for every patch's fields: patch after patch, each its height, sideways x then sideways z. */
export function createFields(source: FieldSource): Float64Array {
  return new Float64Array(source.patches.length * FIELD_COUNT * source.resolution * source.resolution);
}

/** Buffers `evaluateFields` works in, made once. */
export interface FieldScratch {
  readonly first: Float64Array;
  readonly second: Float64Array;
  readonly spare: Float64Array;
}

export function createFieldScratch(resolution: number): FieldScratch {
  const length = 2 * resolution * resolution;
  return { first: new Float64Array(length), second: new Float64Array(length), spare: new Float64Array(length) };
}

/**
 * Every patch's fields at `phaseTime`, into `fields`: each patch's spectrum turned on to then and
 * transformed back to the grid. Every field is real, so two go in each complex transform: a
 * patch's height and sideways x in one, its sideways z and how fast its surface rises in another.
 */
export function evaluateFields(source: FieldSource, phaseTime: number, fields: Float64Array, scratch: FieldScratch): void {
  const resolution = source.resolution;
  const cells = resolution * resolution;
  const { patches, choppiness } = source;
  const copyOut = (packed: Float64Array, realStart: number, imaginaryStart: number) => {
    for (let cell = 0; cell < cells; cell++) {
      fields[realStart + cell] = packed[2 * cell]!;
      fields[imaginaryStart + cell] = packed[2 * cell + 1]!;
    }
  };
  patches.forEach((patch, patchIndex) => {
    const fieldAt = (field: number) => (patchIndex * FIELD_COUNT + field) * cells;
    fillSpectrum(patch, resolution, phaseTime, choppiness, scratch.first, scratch.second);
    copyOut(inverseFft2d(scratch.first, scratch.spare, resolution), fieldAt(HEIGHT_FIELD), fieldAt(SIDEWAYS_X_FIELD));
    // the first result has been copied out, so its buffers are free again
    copyOut(inverseFft2d(scratch.second, scratch.spare, resolution), fieldAt(SIDEWAYS_Z_FIELD), fieldAt(RISE_FIELD));
  });
}

/**
 * The grid index of wavenumber index `index` (from -count/2 to count/2 - 1) in a grid of `count`,
 * where the inverse FFT expects it: negative ones wrap round to the end.
 */
export function slotOf(index: number, count: number): number {
  return index < 0 ? index + count : index;
}

/**
 * Fills the spectra of a patch at `phaseTime`, `size` waves across (taking the patch's own waves
 * nearest zero): `first` with h(k) + i Dx(k), `second` with Dz(k) + i ∂h/∂t(k), each an interleaved
 * complex grid. h(k, t) = h₀(k) e^(-iωt) + h₀*(-k) e^(iωt), so that each wave runs along its k; its
 * sideways motion D(k) = i (k / |k|) h(k) times the choppiness; and ∂h/∂t = -iω h₀ e^(-iωt) +
 * iω h₀*(-k) e^(iωt), how fast the surface point rises, the water's own vertical velocity.
 */
export function fillSpectrum(patch: FieldSource['patches'][number], size: number, phaseTime: number, choppiness: number, first: Float64Array, second: Float64Array): void {
  const half = size / 2;
  for (let row = -half; row < half; row++) {
    for (let column = -half; column < half; column++) {
      const to = 2 * (slotOf(row, size) * size + slotOf(column, size));
      // the grid's edge has no partner on the grid to keep the field real: left out, as the patch leaves out its own
      if (row === -half || column === -half) {
        first[to] = first[to + 1] = second[to] = second[to + 1] = 0;
        continue;
      }
      const from = slotOf(row, patch.resolution) * patch.resolution + slotOf(column, patch.resolution);
      const amplitude = 4 * from;
      const values = patch.amplitudes;
      // most of a patch's grid is outside its band: no wave there to turn
      if (values[amplitude] === 0 && values[amplitude + 1] === 0 && values[amplitude + 2] === 0 && values[amplitude + 3] === 0) {
        first[to] = first[to + 1] = second[to] = second[to + 1] = 0;
        continue;
      }
      const turn = patch.angularFrequencies[from]! * phaseTime;
      const cosine = Math.cos(turn);
      const sine = Math.sin(turn);
      // h₀ e^(-iωt) and h₀*(-k) e^(iωt), added up: so each wave runs along its own k
      const leavingReal = values[amplitude]! * cosine + values[amplitude + 1]! * sine;
      const leavingImaginary = -values[amplitude]! * sine + values[amplitude + 1]! * cosine;
      const comingReal = values[amplitude + 2]! * cosine - values[amplitude + 3]! * sine;
      const comingImaginary = values[amplitude + 2]! * sine + values[amplitude + 3]! * cosine;
      const real = leavingReal + comingReal;
      const imaginary = leavingImaginary + comingImaginary;
      // ∂h/∂t = ω (-i leaving + i coming); -i (x + i y) is y - i x
      const frequency = patch.angularFrequencies[from]!;
      const riseReal = frequency * (leavingImaginary - comingImaginary);
      const riseImaginary = frequency * (comingReal - leavingReal);
      // the unit vector along k, times the choppiness (k = 0 has no wave, so never gets here)
      const across = choppiness / Math.sqrt(column * column + row * row);
      const towardX = column * across;
      const towardZ = row * across;
      // D = i (k / |k|) h: i times (real + i imaginary) is (-imaginary + i real)
      const sidewaysXReal = -imaginary * towardX;
      const sidewaysXImaginary = real * towardX;
      // h + i Dx
      first[to] = real - sidewaysXImaginary;
      first[to + 1] = imaginary + sidewaysXReal;
      // Dz + i ∂h/∂t
      second[to] = -imaginary * towardZ - riseImaginary;
      second[to + 1] = real * towardZ + riseReal;
    }
  }
}
