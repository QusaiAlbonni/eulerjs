import { describe, expect, it } from 'vitest';
import { SumOfSines, SurfaceGrid } from '@eulerjs/marine';

describe('SurfaceGrid', () => {
  const waves = new SumOfSines();
  const exact = new SumOfSines({ inversionIterations: 12 });

  it('interpolates the default sea to within millimetres on average while the area drifts', () => {
    const grid = new SurfaceGrid(waves, 0.5);
    let worstError = 0;
    let errorSum = 0;
    let sampleCount = 0;
    for (let step = 0; step < 600; step++) {
      const time = step / 120;
      const centerX = 3 * time;
      const centerZ = -2 * time;
      grid.update(centerX - 4, centerX + 4, centerZ - 2, centerZ + 2, time);
      for (let sample = 0; sample < 20; sample++) {
        const sampleX = centerX - 4 + (sample * 8) / 19;
        const sampleZ = centerZ - 2 + ((sample * 7) % 20) / 5;
        const error = Math.abs(grid.heightAt(sampleX, sampleZ) - exact.heightAt(sampleX, sampleZ, time));
        worstError = Math.max(worstError, error);
        errorSum += error;
        sampleCount++;
      }
    }
    expect(errorSum / sampleCount).toBeLessThan(0.005);
    // the sharp crests are where interpolation cuts corners
    expect(worstError).toBeLessThan(0.03);
  });

  it('matches the waves exactly on its nodes', () => {
    const grid = new SurfaceGrid(waves, 0.5);
    grid.update(-1, 1, -1, 1, 3);
    expect(grid.heightAt(0.5, -0.5)).toBe(waves.heightAt(0.5, -0.5, 3));
  });

  it('covers the requested rectangle with whole cells', () => {
    const grid = new SurfaceGrid(waves, 1);
    grid.update(0.2, 2.7, -0.5, 0.5, 0);
    // columns 0..3 and rows -1..1
    expect(grid.nodeCount).toBe(12);
  });

  it('clamps queries outside the sampled rectangle to its edge', () => {
    const grid = new SurfaceGrid(waves, 1);
    grid.update(0, 1, 0, 1, 0);
    expect(grid.heightAt(-50, 0.5)).toBe(grid.heightAt(0, 0.5));
  });

  it('forgets nodes the area has moved away from', () => {
    const grid = new SurfaceGrid(waves, 1);
    for (let step = 0; step < 50; step++) grid.update(step * 10, step * 10 + 2, 0, 2, step);
    const remembered = (grid as unknown as { nodeStates: Map<number, unknown> }).nodeStates.size;
    expect(remembered).toBeLessThanOrEqual(grid.nodeCount * 2);
  });

  it('rejects a spacing that is not positive', () => {
    expect(() => new SurfaceGrid(waves, 0)).toThrow(RangeError);
  });
});
