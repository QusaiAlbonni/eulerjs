import { DataUtils, WebGPURenderer } from 'three/webgpu';
import { inverseFft2d, SpectralWaves } from '@eulerjs/marine';
import { GpuWaveFields } from '@eulerjs/marine/webgpu';
import { createFields, createFieldScratch, evaluateFields, FIELD_COUNT } from '../../../packages/marine/src/waves/spectralFields.js';

// The GPU's waves read back and compared with the CPU's: every field, every patch, at a few times.
// On WebGPU if the browser has it, then on WebGPURenderer's WebGL 2 fallback.

const FIELD_NAMES = ['height', 'sideways x', 'sideways z', 'slope x', 'slope z', '∂Dx/∂x', '∂Dz/∂z', '∂Dx/∂z'];

/** The eight fields of one patch on the CPU in double precision, by the same formulas as the GPU's spectrum pass. */
function referenceFields(waves: SpectralWaves, patchIndex: number, phaseTime: number): Float64Array[] {
  const patch = waves.patches[patchIndex]!;
  const resolution = patch.resolution;
  const step = (2 * Math.PI) / patch.size;
  const spectra = Array.from({ length: 8 }, () => new Float64Array(2 * resolution * resolution));
  for (let slot = 0; slot < resolution * resolution; slot++) {
    const row = Math.floor(slot / resolution);
    const column = slot % resolution;
    const waveNumberX = (column < resolution / 2 ? column : column - resolution) * step;
    const waveNumberZ = (row < resolution / 2 ? row : row - resolution) * step;
    const [first, second, third, fourth] = patch.amplitudes.subarray(4 * slot, 4 * slot + 4) as unknown as number[];
    const turn = patch.angularFrequencies[slot]! * phaseTime;
    const real = first! * Math.cos(turn) + second! * Math.sin(turn) + third! * Math.cos(turn) - fourth! * Math.sin(turn);
    const imaginary = -first! * Math.sin(turn) + second! * Math.cos(turn) + third! * Math.sin(turn) + fourth! * Math.cos(turn);
    const waveNumber = Math.max(Math.hypot(waveNumberX, waveNumberZ), 1e-9);
    const towardX = (waveNumberX / waveNumber) * waves.choppiness;
    const towardZ = (waveNumberZ / waveNumber) * waves.choppiness;
    // i·c·h for a real c is c·(-imaginary, real); i·c·(i·d·h) is -c·d·h
    const multipliers: [number, number][] = [
      [1, 0],
      [0, towardX],
      [0, towardZ],
      [0, waveNumberX],
      [0, waveNumberZ],
      [-waveNumberX * towardX, 0],
      [-waveNumberZ * towardZ, 0],
      [-waveNumberZ * towardX, 0],
    ];
    multipliers.forEach(([realPart, imaginaryPart], field) => {
      spectra[field]![2 * slot] = real * realPart - imaginary * imaginaryPart;
      spectra[field]![2 * slot + 1] = real * imaginaryPart + imaginary * realPart;
    });
  }
  return spectra.map((spectrum) => {
    const result = inverseFft2d(spectrum, new Float64Array(spectrum.length), resolution);
    return Float64Array.from({ length: resolution * resolution }, (_unused, cell) => result[2 * cell]!);
  });
}

async function check(forceWebGL: boolean, precision: 'single' | 'half'): Promise<string[]> {
  const renderer = new WebGPURenderer({ forceWebGL });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL 2 fallback';
  const lines = [`${backend}, ${precision} precision:`];
  const waves = new SpectralWaves({ windSpeed: 12, choppiness: 0.9 });
  const fields = new GpuWaveFields(waves, { precision });
  const resolution = fields.resolution;
  const width = waves.patches.length * resolution;
  for (const time of [0, 3.7, 600, 999.9, 18_012.3]) {
    fields.update(renderer, time);
    // half floats come back as their raw 16 bits
    const read = async (index: number) => {
      const pixels = await renderer.readRenderTargetPixelsAsync(fields.atlas, 0, 0, width, resolution, index);
      return pixels instanceof Uint16Array ? Float32Array.from(pixels, (half) => DataUtils.fromHalfFloat(half)) : (pixels as Float32Array);
    };
    const targets = [await read(0), await read(1)];
    const physics = createFields({ patches: waves.patches, resolution, choppiness: waves.choppiness });
    evaluateFields({ patches: waves.patches, resolution, choppiness: waves.choppiness }, waves.phaseTime(time), physics, createFieldScratch(resolution));
    waves.patches.forEach((patch, patchIndex) => {
      const reference = referenceFields(waves, patchIndex, waves.phaseTime(time));
      const summary = FIELD_NAMES.map((name, field) => {
        const target = targets[Math.floor(field / 4)]!;
        const channel = field % 4;
        let largestError = 0;
        let largestValue = 0;
        let largestPhysicsError = 0;
        for (let row = 0; row < resolution; row++) {
          for (let column = 0; column < resolution; column++) {
            // WebGL reads a render target back from its bottom row, where three's (WebGPU's) rows start at the top
            const readRow = backend === 'WebGPU' ? row : resolution - 1 - row;
            const gpu = target[4 * (readRow * width + patchIndex * resolution + column) + channel]!;
            const expected = reference[field]![row * resolution + column]!;
            largestError = Math.max(largestError, Math.abs(gpu - expected));
            largestValue = Math.max(largestValue, Math.abs(expected));
            if (field < 3) largestPhysicsError = Math.max(largestPhysicsError, Math.abs(expected - physics[(patchIndex * FIELD_COUNT + field) * resolution * resolution + row * resolution + column]!));
          }
        }
        const physicsNote = field < 3 ? `, physics off by ${largestPhysicsError.toExponential(1)}` : '';
        return `${name} ${largestValue.toExponential(2)}: off by ${(largestError / largestValue).toExponential(1)} of it${physicsNote}`;
      });
      lines.push(`  t = ${time} s, patch ${patch.size} m: ${summary.join('; ')}`);
    });
  }
  fields.dispose();
  renderer.dispose();
  return lines;
}

async function main(): Promise<void> {
  const output = document.getElementById('results')!;
  const lines: string[] = [];
  for (const [forceWebGL, precision] of [[false, 'single'], [true, 'single'], [false, 'half']] as const) {
    try {
      lines.push(...(await check(forceWebGL, precision)));
    } catch (error) {
      lines.push(`${forceWebGL ? 'WebGL 2' : 'default'}, ${precision}: ${String(error)}`);
    }
    output.textContent = lines.join('\n');
  }
  (window as unknown as { checkDone: boolean }).checkDone = true;
}

void main();
