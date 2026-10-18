import { Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SumOfSines } from '@eulerjs/marine';
import fixture from './fixtures/three-sails-waves.json' with { type: 'json' };

describe('SumOfSines', () => {
  it('reproduces the three-sails wave heights exactly', () => {
    const waves = new SumOfSines({ sampleSpacing: fixture.sampleSpacing });
    for (const sample of fixture.samples) {
      const point = waves.surfacePoint(sample.gridX, sample.gridZ, sample.time);
      expect(point.y).toBeCloseTo(sample.height, 9);
    }
  });

  it('reproduces the three-sails horizontal displacement to within half a millimetre', () => {
    // three-sails also warped by a near-zero placeholder wave, which is gone
    const waves = new SumOfSines({ sampleSpacing: fixture.sampleSpacing });
    for (const sample of fixture.samples) {
      const point = waves.surfacePoint(sample.gridX, sample.gridZ, sample.time);
      expect(Math.hypot(point.x - sample.warpedX, point.z - sample.warpedZ)).toBeLessThan(5e-4);
    }
  });

  it('returns the height of the displaced surface that is actually drawn at a world position', () => {
    const waves = new SumOfSines();
    const point = new Vector3();
    let worstError = 0;
    for (let sample = 0; sample < 200; sample++) {
      waves.surfacePoint((sample % 20) * 3.7 - 37, Math.floor(sample / 20) * 4.1 - 20, sample * 0.13, point);
      worstError = Math.max(worstError, Math.abs(waves.heightAt(point.x, point.z, sample * 0.13) - point.y));
    }
    expect(worstError).toBeLessThan(1e-3);
  });

  it('keeps the mean sea level at zero, apart from a small bias from the sideways motion', () => {
    // The longest wave's period is about 250 m, so average over several kilometres and moments.
    const waves = new SumOfSines();
    let gridSum = 0;
    let worldSum = 0;
    let count = 0;
    for (let moment = 0; moment < 10; moment++) {
      for (let row = 0; row < 50; row++) {
        for (let column = 0; column < 50; column++) {
          const sampleX = (row + 0.37) * 40;
          const sampleZ = (column + 0.61) * 40;
          gridSum += waves.surfacePoint(sampleX, sampleZ, moment * 7.7).y;
          worldSum += waves.heightAt(sampleX, sampleZ, moment * 7.7);
          count++;
        }
      }
    }
    expect(Math.abs(gridSum / count)).toBeLessThan(0.005);
    // Crests bunch up and troughs spread out, as with Gerstner waves, which lowers the mean a little.
    expect(Math.abs(worldSum / count)).toBeLessThan(0.03);
  });

  it('is a pure function of position and time', () => {
    const waves = new SumOfSines();
    const first = waves.heightAt(12.5, -3.25, 4);
    waves.heightAt(100, 100, 50);
    expect(waves.heightAt(12.5, -3.25, 4)).toBe(first);
    expect(new SumOfSines().heightAt(12.5, -3.25, 4)).toBe(first);
  });

  it('gives a unit normal perpendicular to the surface slope', () => {
    const waves = new SumOfSines();
    const normal = waves.normalAt(3, 4, 1);
    expect(normal.length()).toBeCloseTo(1, 12);
    const step = 1e-3;
    const slopeX = (waves.heightAt(3 + step, 4, 1) - waves.heightAt(3 - step, 4, 1)) / (2 * step);
    const slopeZ = (waves.heightAt(3, 4 + step, 1) - waves.heightAt(3, 4 - step, 1)) / (2 * step);
    const finer = new Vector3(-slopeX, 1, -slopeZ).normalize();
    expect(normal.angleTo(finer)).toBeLessThan(1e-3);
  });

  it('fades out waves too short for the sample spacing', () => {
    const waves = new SumOfSines();
    expect(waves.resolvability(0, waves.sampleSpacing)).toBe(1);
    expect(waves.resolvability(waves.waves.length - 1, waves.sampleSpacing)).toBe(0);
    const coarse = new SumOfSines({ sampleSpacing: 5 });
    expect(coarse.heightAt(1, 1, 0)).not.toBeCloseTo(waves.heightAt(1, 1, 0), 3);
  });

  it('generates deep-water waves: each shorter, lower and slower than the last', () => {
    const waves = new SumOfSines({ speedFactor: 1, gravity: 9.81 });
    waves.waves.forEach((wave, index) => {
      const phaseSpeed = wave.angularFrequency / wave.frequency;
      expect(phaseSpeed).toBeCloseTo(Math.sqrt((9.81 * wave.wavelength) / (2 * Math.PI)), 9);
      expect(wave.direction.length()).toBeCloseTo(1, 12);
      const previous = waves.waves[index - 1];
      if (previous) {
        expect(wave.wavelength).toBeLessThan(previous.wavelength);
        expect(wave.amplitude).toBeLessThan(previous.amplitude);
      }
    });
  });

  it('leans wave directions toward the bias', () => {
    const plain = new SumOfSines();
    const biased = new SumOfSines({ directionBias: new Vector2(5, 0) });
    const averageX = (waves: SumOfSines) => waves.waves.reduce((sum, wave) => sum + wave.direction.x, 0) / waves.waves.length;
    expect(averageX(biased)).toBeGreaterThan(averageX(plain) + 0.5);
  });

  it('maps simulation time through timeScale and timeOffset', () => {
    const doubleSpeed = new SumOfSines({ timeScale: 2, timeOffset: 0 });
    const normal = new SumOfSines({ timeOffset: 0 });
    expect(doubleSpeed.heightAt(4, 5, 1.5)).toBeCloseTo(normal.heightAt(4, 5, 3), 12);
  });
});
