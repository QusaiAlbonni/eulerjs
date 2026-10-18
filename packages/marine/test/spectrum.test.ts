import { describe, expect, it } from 'vitest';
import { directionalSpread, jonswap, jonswapParameters, wavenumberSpectrum, wavenumberSpectrumOf } from '../src/waves/spectrum.js';
import type { SeaState } from '../src/waves/spectrum.js';

const sea: SeaState = { windSpeed: 10, fetch: 100_000, peakEnhancement: 3.3, gravity: 9.81 };

/** ∫ f over [from, to] by Simpson's rule on `steps` (even) intervals. */
function integrate(integrand: (value: number) => number, from: number, to: number, steps = 20000): number {
  const width = (to - from) / steps;
  let sum = integrand(from) + integrand(to);
  for (let step = 1; step < steps; step++) sum += (step % 2 === 0 ? 2 : 4) * integrand(from + step * width);
  return (sum * width) / 3;
}

describe('the JONSWAP spectrum', () => {
  it('holds α g² / 5 ωp⁴ of height variance with no peak enhancement, as the Pierson–Moskowitz spectrum does', () => {
    const grown = { ...sea, peakEnhancement: 1 };
    const { peakFrequency, energyScale } = jonswapParameters(grown);
    const variance = integrate((frequency) => jonswap(frequency, grown), 0.01, 40 * peakFrequency, 200000);
    expect(variance / ((energyScale * grown.gravity ** 2) / (5 * peakFrequency ** 4))).toBeCloseTo(1, 4);
  });

  it('peaks at its peak frequency, and is larger there with peak enhancement', () => {
    const { peakFrequency } = jonswapParameters(sea);
    for (const ratio of [0.9, 0.97, 1.03, 1.1]) expect(jonswap(peakFrequency * ratio, sea)).toBeLessThan(jonswap(peakFrequency, sea));
    expect(jonswap(peakFrequency, sea) / jonswap(peakFrequency, { ...sea, peakEnhancement: 1 })).toBeCloseTo(3.3, 6);
  });

  it('spreads every frequency over all directions with a total of one, narrowest at the peak', () => {
    const { peakFrequency } = jonswapParameters(sea);
    for (const ratio of [0.5, 1, 2, 5]) {
      expect(integrate((angle) => directionalSpread(peakFrequency * ratio, angle, sea), -Math.PI, Math.PI)).toBeCloseTo(1, 5);
    }
    const sideways = (ratio: number) => directionalSpread(peakFrequency * ratio, Math.PI / 4, sea) / directionalSpread(peakFrequency * ratio, 0, sea);
    expect(sideways(1)).toBeLessThan(sideways(2));
    expect(sideways(1)).toBeLessThan(sideways(0.6));
  });

  it('holds the same variance over the plane of wavenumbers as over frequency', () => {
    const { peakFrequency } = jonswapParameters(sea);
    const overFrequency = integrate((frequency) => jonswap(frequency, sea), 0.01, 40 * peakFrequency, 200000);
    // over the plane in polar form, k dk dθ, up to the wavenumber of 40 times the peak frequency
    const largestWaveNumber = (40 * peakFrequency) ** 2 / sea.gravity;
    const overPlane = integrate(
      (waveNumber) => waveNumber * integrate((angle) => wavenumberSpectrum(waveNumber * Math.cos(angle), waveNumber * Math.sin(angle), 0.7, sea), -Math.PI, Math.PI, 400),
      1e-6,
      largestWaveNumber,
      20000,
    );
    // to within what 400 directions resolve of the narrow spread at the peak; a wrong change of
    // variables would be out by a factor, not a tenth of a percent
    expect(overPlane / overFrequency).toBeCloseTo(1, 2);
  });

  it('works the same with its constants worked out once, as a grid of waves is filled', () => {
    const sea = { windSpeed: 13, fetch: 40_000, peakEnhancement: 2, gravity: 9.81 };
    const spectrum = wavenumberSpectrumOf(0.4, sea);
    for (const [waveNumberX, waveNumberZ] of [[0.01, 0], [0.05, -0.2], [-1.3, 0.7], [4, 9], [0, 0]] as const) {
      expect(spectrum(waveNumberX, waveNumberZ)).toBeCloseTo(wavenumberSpectrum(waveNumberX, waveNumberZ, 0.4, sea), 12);
    }
  });
});
