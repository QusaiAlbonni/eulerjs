import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SpectralWaves } from '../src/waves/SpectralWaves.js';
import { SumOfSines } from '../src/waves/SumOfSines.js';
import type { WaveSurface } from '../src/waves/WaveSurface.js';
import { createFields, createFieldScratch, evaluateFields, FIELD_COUNT } from '../src/waves/spectralFields.js';
import { wavenumberSpectrum } from '../src/waves/spectrum.js';

const gravity = 9.807;

/**
 * A sea of one wave: amplitude `amplitude` / 2 at wavenumber (column, 0) of a 64 m patch, its
 * opposite empty, which makes the travelling wave A cos(kx - ωt) along +x.
 */
function oneWave(amplitude: number, column: number, choppiness: number): SpectralWaves {
  const waves = new SpectralWaves({ patchSizes: [64], resolution: 16, physicsResolution: 16, physicsPatches: 1, choppiness, gravity, loopPeriod: Infinity, swellHeight: 0, gustiness: 0 });
  const patch = waves.patches[0]!;
  patch.amplitudes.fill(0);
  const resolution = patch.resolution;
  // h₀(k) at the wave's slot, and h₀*(k) as the partner of the slot of -k
  patch.amplitudes[4 * column] = amplitude / 2;
  patch.amplitudes[4 * (resolution - column) + 2] = amplitude / 2;
  return waves;
}

describe('spectral waves', () => {
  it('makes one wave the Gerstner wave, travelling along its wavenumber at the deep-water phase speed', () => {
    const amplitude = 0.8;
    const choppiness = 0.7;
    const waves = oneWave(amplitude, 2, choppiness);
    const waveNumber = (2 * Math.PI * 2) / 64;
    const angularFrequency = Math.sqrt(gravity * waveNumber);
    // on the grid's points (4 m apart), where no interpolation blurs the cosine
    for (const time of [0, 1.3, 7.9]) {
      for (const gridX of [0, 4, 20, 44, -12]) {
        const phase = waveNumber * gridX - angularFrequency * time;
        const point = waves.surfacePoint(gridX, 8, time);
        expect(point.y).toBeCloseTo(amplitude * Math.cos(phase), 6);
        expect(point.x).toBeCloseTo(gridX - choppiness * amplitude * Math.sin(phase), 6);
        expect(point.z).toBeCloseTo(8, 9);
      }
    }
    // the whole surface has moved on along +x at the phase speed √(g/k): by 8 m, two grid cells, in 8 m / speed
    const speed = Math.sqrt(gravity / waveNumber);
    const later = 8 / speed;
    for (const gridX of [0, 4, 12, 28]) {
      const before = waves.surfacePoint(gridX, 0, 0);
      const after = waves.surfacePoint(gridX + 8, 0, later);
      expect(after.y).toBeCloseTo(before.y, 9);
      expect(after.x - before.x).toBeCloseTo(8, 9);
    }
  });

  it('finds the height under a world position, though the surface has moved there sideways', () => {
    const waves = new SpectralWaves({ windSpeed: 14, choppiness: 1 });
    for (const [gridX, gridZ] of [[3, 7], [-120, 44], [801.5, -33.25]] as const) {
      const point = waves.surfacePoint(gridX, gridZ, 12.5);
      expect(waves.heightAt(point.x, point.z, 12.5)).toBeCloseTo(point.y, 3);
    }
  });

  it('holds the height variance of the spectrum it is drawn from, over the waves it holds', () => {
    // one patch evaluated in full, so the grid holds every wave it was given
    const size = 300;
    const resolution = 128;
    const windAngle = 0.5;
    const waves = new SpectralWaves({ patchSizes: [size], resolution, physicsResolution: resolution, physicsPatches: 1, windSpeed: 9, windAngle, gravity, heightScale: 1, swellHeight: 0 });
    const step = (2 * Math.PI) / size;
    let expected = 0;
    for (let row = -resolution / 2 + 1; row < resolution / 2; row++) {
      for (let column = -resolution / 2 + 1; column < resolution / 2; column++) expected += wavenumberSpectrum(column * step, row * step, windAngle, { windSpeed: 9, fetch: 100_000, peakEnhancement: 3.3, gravity }) * step * step;
    }
    let sum = 0;
    let sumOfSquares = 0;
    const samples = resolution;
    for (let row = 0; row < samples; row++) {
      for (let column = 0; column < samples; column++) {
        const height = waves.surfacePoint((column * size) / samples, (row * size) / samples, 4).y;
        sum += height;
        sumOfSquares += height * height;
      }
    }
    const count = samples * samples;
    // the mean level is the still water's, and the variance one random sea's sampling of the spectrum's
    expect(Math.abs(sum / count)).toBeLessThan(1e-9);
    expect(sumOfSquares / count / expected).toBeGreaterThan(0.85);
    expect(sumOfSquares / count / expected).toBeLessThan(1.15);
  });

  it('keeps the field real: the sideways motion packed with the heights comes out as its own wave', () => {
    // with no choppiness there is no sideways motion: anything there would be leaked height
    const waves = new SpectralWaves({ choppiness: 0 });
    for (const [gridX, gridZ] of [[0, 0], [17, -230], [400, 90]] as const) {
      const point = waves.surfacePoint(gridX, gridZ, 3);
      expect(point.x).toBeCloseTo(gridX, 9);
      expect(point.z).toBeCloseTo(gridZ, 9);
    }
  });

  it('tiles: each patch repeats every patch size', () => {
    const waves = new SpectralWaves({ patchSizes: [512], physicsPatches: 1, swellHeight: 0 });
    expect(waves.surfacePoint(10, 20, 5).y).toBeCloseTo(waves.surfacePoint(10 + 512, 20 - 1024, 5).y, 9);
  });

  it('turns its normal up and toward the slope', () => {
    const waves = oneWave(1, 1, 0);
    // on the rising side of the wave the surface tilts back
    const normal = waves.normalAt(-8, 0, 0, new Vector3());
    expect(normal.y).toBeGreaterThan(0.9);
    expect(normal.x).toBeLessThan(0);
  });

  it('packs two patches into one transform as if each had its own', () => {
    const waves = new SpectralWaves({ patchSizes: [512, 97, 19], physicsResolution: 32, choppiness: 0.9 });
    const resolution = 32;
    const together = { patches: waves.patches, resolution, choppiness: 0.9 };
    const fields = createFields(together);
    evaluateFields(together, 6.5, fields, createFieldScratch(resolution));
    const fieldLength = FIELD_COUNT * resolution * resolution;
    waves.patches.forEach((patch, index) => {
      const alone = { patches: [patch], resolution, choppiness: 0.9 };
      const ownFields = createFields(alone);
      evaluateFields(alone, 6.5, ownFields, createFieldScratch(resolution));
      const packed = fields.subarray(index * fieldLength, (index + 1) * fieldLength);
      let largest = 0;
      ownFields.forEach((value, at) => (largest = Math.max(largest, Math.abs(value - packed[at]!))));
      expect(largest).toBeLessThan(1e-12);
      // and there is sideways z, and rising, to get wrong
      expect(Math.max(...ownFields.subarray(2 * resolution * resolution, 3 * resolution * resolution).map(Math.abs))).toBeGreaterThan(0.01);
      expect(Math.max(...ownFields.subarray(3 * resolution * resolution).map(Math.abs))).toBeGreaterThan(0.01);
    });
  });

  it('repeats exactly every loop period, its frequencies rounded to whole turns in it', () => {
    const waves = new SpectralWaves({ loopPeriod: 600 });
    for (const [gridX, gridZ] of [[3, 4], [-250, 81]] as const) {
      expect(waves.surfacePoint(gridX, gridZ, 17.25 + 600).y).toBeCloseTo(waves.surfacePoint(gridX, gridZ, 17.25).y, 12);
    }
    const turnRate = (2 * Math.PI) / 600;
    const patch = waves.patches[1]!;
    const step = (2 * Math.PI) / patch.size;
    for (const slot of [5, 300, 4000]) {
      // slots past the middle are the negative wavenumbers
      const unwrap = (index: number) => (index < patch.resolution / 2 ? index : index - patch.resolution);
      const column = unwrap(slot % patch.resolution);
      const row = unwrap(Math.floor(slot / patch.resolution));
      const exact = Math.sqrt(9.807 * step * Math.hypot(column, row));
      const rounded = patch.angularFrequencies[slot]!;
      expect(Math.abs(rounded - exact)).toBeLessThanOrEqual(turnRate / 2 + 1e-12);
      expect(rounded / turnRate).toBeCloseTo(Math.round(rounded / turnRate), 9);
    }
  });

  it('scales every wave by the height scale: the height variance by its square', () => {
    const plain = new SpectralWaves({ heightScale: 1, swellHeight: 0 });
    const taller = new SpectralWaves({ heightScale: 1.5, swellHeight: 0 });
    expect(taller.significantWaveHeight / plain.significantWaveHeight).toBeCloseTo(1.5, 6);
    expect(taller.surfacePoint(12, -40, 3).y).toBeCloseTo(1.5 * plain.surfacePoint(12, -40, 3).y, 5);
  });

  it.each([
    ['a spectral sea', () => new SpectralWaves({ timeScale: 1.3 })],
    ['a sum of sines', () => new SumOfSines({ timeScale: 1.3 })],
  ] as const)("says how fast the water at the surface rises, as its point's height changes in time, on %s", (_name, makeWaves) => {
    const waves: WaveSurface = makeWaves();
    const step = 1e-4;
    for (const [gridX, gridZ, time] of [[3, 7, 2], [-120, 44, 17.5], [301.5, -33.25, 60]] as const) {
      const rising = (waves.surfacePoint(gridX, gridZ, time + step).y - waves.surfacePoint(gridX, gridZ, time - step).y) / (2 * step);
      expect(waves.riseRate!(gridX, gridZ, time)).toBeCloseTo(rising, 2);
    }
  });

  it('runs a swell under the patches that never repeats as they do, of the height asked for', () => {
    const calm = { windSpeed: 3, heightScale: 1, patchSizes: [512] };
    const swell = new SpectralWaves({ ...calm, swellHeight: 2 });
    const none = new SpectralWaves({ ...calm, swellHeight: 0 });
    // the swell alone: the sea's with it less the sea's without, at the same undisplaced points
    const swellAt = (gridX: number, gridZ: number, time: number) => swell.surfacePoint(gridX, gridZ, time).y - none.surfacePoint(gridX, gridZ, time).y;
    expect(Math.abs(swellAt(30, 40, 5) - swellAt(30 + 512, 40, 5))).toBeGreaterThan(0.05);
    // and its height: four times the standard deviation, over a wide stretch of sea
    let sumOfSquares = 0;
    const count = 4000;
    for (let sample = 0; sample < count; sample++) sumOfSquares += swellAt((sample * 977.3) % 20_000, (sample * 613.7) % 20_000, 3) ** 2;
    expect(4 * Math.sqrt(sumOfSquares / count)).toBeGreaterThan(1.7);
    expect(4 * Math.sqrt(sumOfSquares / count)).toBeLessThan(2.3);
    // it repeats with the rest of the sea, every loop period
    expect(swell.surfacePoint(30, 40, 5 + 1000).y).toBeCloseTo(swell.surfacePoint(30, 40, 5).y, 9);
    // and can be calmed as the sea runs
    swell.setSea({ swellHeight: 0 });
    expect(swell.surfacePoint(30, 40, 5).y).toBeCloseTo(none.surfacePoint(30, 40, 5).y, 12);
  });

  it('gusts: its shorter waves rougher in some stretches, calmer in others, never in a repeating pattern', () => {
    const waves = new SpectralWaves({ gustiness: 0.3 });
    const gusts = Array.from({ length: 2000 }, (_unused, sample) => waves.gustAt((sample * 977.3) % 30_000, (sample * 613.7) % 30_000));
    expect(Math.min(...gusts)).toBeLessThan(0.75);
    expect(Math.max(...gusts)).toBeGreaterThan(1.25);
    expect(Math.min(...gusts)).toBeGreaterThan(0);
    // over the shortest stretch it changes little: the waves see it as even
    expect(Math.abs(waves.gustAt(100, 100) - waves.gustAt(101, 100))).toBeLessThan(0.005);
    expect(waves.gustAt(100, 100)).not.toBeCloseTo(waves.gustAt(100 + 512, 100), 2);
    waves.setSea({ gustiness: 0 });
    expect(waves.gustAt(100, 100)).toBe(1);
  });

  it('fades its shortest waves out as asked, and leaves the long ones be', () => {
    const plain = new SpectralWaves({ swellHeight: 0 });
    const faded = new SpectralWaves({ swellHeight: 0, shortWaveFade: 1 });
    // the 1.2 m patch's waves, all much shorter than 2π m, are all but gone; the 512 m patch's hardly touched
    const energy = (waves: SpectralWaves, patch: number) => waves.patches[patch]!.amplitudes.reduce((sum, amplitude) => sum + amplitude * amplitude, 0);
    expect(energy(faded, 4) / energy(plain, 4)).toBeLessThan(1e-6);
    expect(energy(faded, 0) / energy(plain, 0)).toBeGreaterThan(0.97);
  });
});
