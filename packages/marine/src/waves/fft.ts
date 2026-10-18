/**
 * The fast Fourier transform the spectral ocean is built on, in the Stockham form: each stage
 * reads one buffer and writes the next, and the result comes out in order, with no bit reversal.
 * Stages are radix 4, merging four sub-transforms at once, with one of radix 2 first when log₂ N
 * is odd: half the passes over the data that radix 2 alone takes. That is how the GPU does it
 * too, one render pass per stage (see `webgpu/GpuWaveFields.ts`), so the two can be checked
 * against each other value for value.
 *
 * Complex numbers are stored as interleaved pairs: real at 2i, imaginary at 2i + 1.
 */

/**
 * One stage of the inverse transform of `count` complex values, from `source` to `target`, each
 * `stride` pairs apart from `offset`: merges pairs of sub-transforms of m = `merged` values into
 * ones of 2m. Butterfly (block, k) reads inputs j = block·m + k and j + count/2, and
 * writes a + w b and a - w b to positions k and k + m of output block `block`, with the twiddle
 * w = e^(2πi k / 2m).
 */
function stage(source: Float64Array, target: Float64Array, offset: number, stride: number, count: number, merged: number, twiddles: Float64Array): void {
  const half = count / 2;
  // the twiddle e^(πi k / m) is e^(2πi j / count) for j = k count / 2m, from the table
  const twiddleStep = 2 * (half / merged);
  const pairStride = 2 * stride;
  // each butterfly makes both outputs at once, a + w b at `within` = k and a - w b at k + m
  for (let block = 0; block < half / merged; block++) {
    for (let position = 0; position < merged; position++) {
      const first = block * merged + position;
      const twiddleAt = position * twiddleStep;
      const twiddleReal = twiddles[twiddleAt]!;
      const twiddleImaginary = twiddles[twiddleAt + 1]!;
      const firstAt = 2 * offset + first * pairStride;
      const secondAt = firstAt + half * pairStride;
      const secondReal = source[secondAt]! * twiddleReal - source[secondAt + 1]! * twiddleImaginary;
      const secondImaginary = source[secondAt]! * twiddleImaginary + source[secondAt + 1]! * twiddleReal;
      const firstReal = source[firstAt]!;
      const firstImaginary = source[firstAt + 1]!;
      const sumAt = 2 * offset + (block * 2 * merged + position) * pairStride;
      const differenceAt = sumAt + merged * pairStride;
      target[sumAt] = firstReal + secondReal;
      target[sumAt + 1] = firstImaginary + secondImaginary;
      target[differenceAt] = firstReal - secondReal;
      target[differenceAt + 1] = firstImaginary - secondImaginary;
    }
  }
}

/**
 * One radix-4 stage, merging sub-transforms of `merged` values into ones of 4 · merged: butterfly
 * (block, k) reads the inputs j + q · count/4, q = 0..3, with j = block · merged + k, turns each by
 * the twiddle e^(2πi q k / 4m), and writes their four-point inverse transform, Σ_q y_q i^(pq), to
 * positions k + p · m of output block `block`.
 */
function stage4(source: Float64Array, target: Float64Array, offset: number, stride: number, count: number, merged: number, twiddles: Float64Array): void {
  const quarter = count / 4;
  const pairStride = 2 * stride;
  const twiddleStep = count / (4 * merged);
  for (let block = 0; block < quarter / merged; block++) {
    for (let position = 0; position < merged; position++) {
      const inputAt = 2 * offset + (block * merged + position) * pairStride;
      const apart = quarter * pairStride;
      // y_q = x_q e^(2πi q k / 4m)
      const firstReal = source[inputAt]!;
      const firstImaginary = source[inputAt + 1]!;
      let at = 2 * position * twiddleStep;
      let real = source[inputAt + apart]!;
      let imaginary = source[inputAt + apart + 1]!;
      const secondReal = real * twiddles[at]! - imaginary * twiddles[at + 1]!;
      const secondImaginary = real * twiddles[at + 1]! + imaginary * twiddles[at]!;
      at = 4 * position * twiddleStep;
      real = source[inputAt + 2 * apart]!;
      imaginary = source[inputAt + 2 * apart + 1]!;
      const thirdReal = real * twiddles[at]! - imaginary * twiddles[at + 1]!;
      const thirdImaginary = real * twiddles[at + 1]! + imaginary * twiddles[at]!;
      at = 6 * position * twiddleStep;
      real = source[inputAt + 3 * apart]!;
      imaginary = source[inputAt + 3 * apart + 1]!;
      const fourthReal = real * twiddles[at]! - imaginary * twiddles[at + 1]!;
      const fourthImaginary = real * twiddles[at + 1]! + imaginary * twiddles[at]!;
      // the four-point transform: out_p = y₀ + i^p y₁ + (-1)^p y₂ + (-i)^p y₃
      const evenSumReal = firstReal + thirdReal;
      const evenSumImaginary = firstImaginary + thirdImaginary;
      const evenDifferenceReal = firstReal - thirdReal;
      const evenDifferenceImaginary = firstImaginary - thirdImaginary;
      const oddSumReal = secondReal + fourthReal;
      const oddSumImaginary = secondImaginary + fourthImaginary;
      const oddDifferenceReal = secondReal - fourthReal;
      const oddDifferenceImaginary = secondImaginary - fourthImaginary;
      const outputAt = 2 * offset + (block * 4 * merged + position) * pairStride;
      const outputApart = merged * pairStride;
      target[outputAt] = evenSumReal + oddSumReal;
      target[outputAt + 1] = evenSumImaginary + oddSumImaginary;
      // + i (y₁ - y₃)
      target[outputAt + outputApart] = evenDifferenceReal - oddDifferenceImaginary;
      target[outputAt + outputApart + 1] = evenDifferenceImaginary + oddDifferenceReal;
      target[outputAt + 2 * outputApart] = evenSumReal - oddSumReal;
      target[outputAt + 2 * outputApart + 1] = evenSumImaginary - oddSumImaginary;
      // - i (y₁ - y₃)
      target[outputAt + 3 * outputApart] = evenDifferenceReal + oddDifferenceImaginary;
      target[outputAt + 3 * outputApart + 1] = evenDifferenceImaginary - oddDifferenceReal;
    }
  }
}

/** A transform's stages, in order: each its radix and the size of the sub-transforms it merges. */
export function transformStages(count: number): { radix: 2 | 4; merged: number }[] {
  const stages: { radix: 2 | 4; merged: number }[] = [];
  let merged = 1;
  if (stageCount(count) % 2 === 1) {
    stages.push({ radix: 2, merged });
    merged = 2;
  }
  for (; merged < count; merged *= 4) stages.push({ radix: 4, merged });
  return stages;
}

const twiddleTables = new Map<number, Float64Array>();

/** e^(2πi j / count) for every j up to count, as interleaved pairs, made once for each size. */
function twiddlesFor(count: number): Float64Array {
  let table = twiddleTables.get(count);
  if (!table) {
    table = new Float64Array(2 * count);
    for (let index = 0; index < count; index++) {
      table[2 * index] = Math.cos((2 * Math.PI * index) / count);
      table[2 * index + 1] = Math.sin((2 * Math.PI * index) / count);
    }
    twiddleTables.set(count, table);
  }
  return table;
}

/** Log₂ of `count`, which must be a power of two. */
export function stageCount(count: number): number {
  const stages = Math.log2(count);
  if (!Number.isInteger(stages) || stages < 1) throw new RangeError(`The transform's size must be a power of two, got ${count}`);
  return stages;
}

/**
 * The inverse transform, unscaled, of a `size` by `size` grid of complex values held row by row in
 * `values`: v(x) = Σ_k V(k) e^(+2πi k·x / size). Every row, then every column. `scratch` is a buffer
 * of the same length. Returns whichever of the two holds the result.
 */
export function inverseFft2d(values: Float64Array, scratch: Float64Array, size: number): Float64Array {
  const stages = transformStages(size);
  const twiddles = twiddlesFor(size);
  let source = values;
  let target = scratch;
  for (const along of ['rows', 'columns'] as const) {
    for (const { radix, merged } of stages) {
      const run = radix === 4 ? stage4 : stage;
      for (let line = 0; line < size; line++) {
        if (along === 'rows') run(source, target, line * size, 1, size, merged, twiddles);
        else run(source, target, line, size, size, merged, twiddles);
      }
      [source, target] = [target, source];
    }
  }
  return source;
}
