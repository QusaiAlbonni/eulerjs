import { describe, expect, it } from 'vitest';
import { Ocean, SumOfSines, SurfaceSampler } from '@eulerjs/marine';

describe('SurfaceSampler', () => {
  const waves = new SumOfSines();
  const converged = new SumOfSines({ inversionIterations: 12 });

  it('tracks moving points with one iteration per call to within a millimetre of the converged surface', () => {
    const sampler = new SurfaceSampler(waves, 2);
    let worstError = 0;
    for (let step = 0; step < 1200; step++) {
      const time = step / 120;
      // a point sailing at 4 m/s and one circling
      const points = [
        [4 * time, 1.5 * time],
        [10 + 3 * Math.cos(time), -5 + 3 * Math.sin(time)],
      ] as const;
      points.forEach(([pointX, pointZ], index) => {
        const error = Math.abs(sampler.heightAt(index, pointX, pointZ, time) - converged.heightAt(pointX, pointZ, time));
        worstError = Math.max(worstError, error);
      });
    }
    expect(worstError).toBeLessThan(1e-3);
  });

  it('starts cold with the full iteration count and can be reset', () => {
    const sampler = new SurfaceSampler(waves, 1);
    expect(sampler.heightAt(0, 3, 4, 2)).toBe(waves.heightAt(3, 4, 2));
    sampler.reset();
    expect(sampler.heightAt(0, 30, -4, 2)).toBe(waves.heightAt(30, -4, 2));
    expect(sampler.pointCount).toBe(1);
  });

  it('is what an ocean hands out', () => {
    const ocean = new Ocean({ waves });
    const sampler = ocean.createSurfaceSampler(3);
    expect(sampler.pointCount).toBe(3);
    expect(sampler.waves).toBe(waves);
  });

  it('agrees with the cold three-iteration query', () => {
    let worstDifference = 0;
    for (let sample = 0; sample < 100; sample++) {
      const pointX = sample * 1.7 - 80;
      const pointZ = sample * 0.9 - 40;
      worstDifference = Math.max(worstDifference, Math.abs(waves.heightAt(pointX, pointZ, 5) - converged.heightAt(pointX, pointZ, 5)));
    }
    expect(worstDifference).toBeLessThan(1e-3);
  });
});
