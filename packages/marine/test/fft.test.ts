import { describe, expect, it } from 'vitest';
import { inverseFft2d } from '../src/waves/fft.js';

/** The inverse transform summed directly, v(x) = Σ_k V(k) e^(2πi k·x / size): slow, and plainly right. */
function directInverse(values: Float64Array, size: number): Float64Array {
  const result = new Float64Array(values.length);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let real = 0;
      let imaginary = 0;
      for (let frequencyRow = 0; frequencyRow < size; frequencyRow++) {
        for (let frequencyColumn = 0; frequencyColumn < size; frequencyColumn++) {
          const angle = (2 * Math.PI * (frequencyColumn * column + frequencyRow * row)) / size;
          const at = 2 * (frequencyRow * size + frequencyColumn);
          real += values[at]! * Math.cos(angle) - values[at + 1]! * Math.sin(angle);
          imaginary += values[at]! * Math.sin(angle) + values[at + 1]! * Math.cos(angle);
        }
      }
      result[2 * (row * size + column)] = real;
      result[2 * (row * size + column) + 1] = imaginary;
    }
  }
  return result;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

describe('the inverse FFT', () => {
  it.each([2, 4, 8, 16])('matches the inverse transform summed directly, %i by %i', (size) => {
    const random = seeded(size);
    const values = new Float64Array(2 * size * size).map(() => random());
    const expected = directInverse(values, size);
    const result = inverseFft2d(values.slice(), new Float64Array(values.length), size);
    for (let index = 0; index < expected.length; index++) expect(result[index]).toBeCloseTo(expected[index]!, 9);
  });

  it('turns a single frequency into a wave across the grid', () => {
    const size = 32;
    const values = new Float64Array(2 * size * size);
    // three cycles across, one down, amplitude 1
    values[2 * (1 * size + 3)] = 1;
    const result = inverseFft2d(values, new Float64Array(values.length), size);
    for (const [row, column] of [[0, 0], [5, 7], [31, 30]] as const) {
      const angle = (2 * Math.PI * (3 * column + row)) / size;
      expect(result[2 * (row * size + column)]).toBeCloseTo(Math.cos(angle), 12);
      expect(result[2 * (row * size + column) + 1]).toBeCloseTo(Math.sin(angle), 12);
    }
  });

  it('refuses a size that is not a power of two', () => {
    expect(() => inverseFft2d(new Float64Array(2 * 36), new Float64Array(2 * 36), 6)).toThrow(RangeError);
  });
});
