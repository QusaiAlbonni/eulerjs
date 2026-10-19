import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/track/Circuit.js';
import { MONZA } from '../src/track/monza.js';

describe('Monza, from OpenStreetMap', () => {
  const circuit = new Circuit(MONZA);

  it('is as long as the real circuit, 5.793 km', () => {
    expect(Math.abs(circuit.length / 5801 - 1)).toBeLessThan(0.01);
    expect(Math.abs(circuit.length / 5793 - 1)).toBeLessThan(0.02);
  });

  it('runs clockwise, turning once round over the lap', () => {
    const turning = circuit.samples.reduce((sum, sample, index) => {
      const next = circuit.samples[(index + 1) % circuit.samples.length]!;
      const step = next.distance > sample.distance ? next.distance - sample.distance : circuit.length - sample.distance;
      return sum + sample.curvature * step;
    }, 0);
    expect(turning).toBeCloseTo(-2 * Math.PI, 1);
  });

  it('starts on the main straight, heading north, at its width', () => {
    const start = circuit.startLine;
    // north is −z
    expect(start.tangent.z).toBeLessThan(-0.9);
    expect(start.halfWidth).toBe(7.5);
    expect(start.kerbs).toBe(false);
    expect(circuit.surfaceAt(start.position)).toBe('asphalt');
  });

  it('has kerbs and gravel through the corners, grass along the straights', () => {
    const kerbed = circuit.samples.filter((sample) => sample.kerbs);
    expect(kerbed.length).toBeGreaterThan(50);
    expect(kerbed.length).toBeLessThan(circuit.samples.length / 2);
    const gravel = circuit.samples.filter((sample) => sample.sides.some((side) => side.runOff === 'gravel'));
    expect(gravel.length).toBeGreaterThan(30);
    // the gravel is outside the corner: right of a left turn, left of a right one
    for (const sample of gravel) {
      if (Math.abs(sample.curvature) > 1 / 100) {
        const outside = sample.sides[sample.curvature > 0 ? 1 : 0];
        expect(outside.runOff).toBe('gravel');
      }
    }
    const tightest = circuit.samples.reduce((tight, sample) => (Math.abs(sample.curvature) > Math.abs(tight.curvature) ? sample : tight));
    const outward = tightest.curvature > 0 ? -1 : 1;
    const onKerb = tightest.position.clone().addScaledVector(tightest.left, outward * (tightest.halfWidth + 0.5));
    expect(circuit.surfaceAt(onKerb)).toBe('kerb');
    const inGravel = tightest.position.clone().addScaledVector(tightest.left, outward * (tightest.halfWidth + 15));
    expect(['gravel', 'asphalt']).toContain(circuit.surfaceAt(inGravel));
  });

  it('keeps its barriers off every other part of the track', () => {
    const point = new Vector3();
    for (const sample of circuit.samples) {
      sample.sides.forEach((side, index) => {
        expect(side.barrier).toBeGreaterThanOrEqual(sample.halfWidth + 1.5);
        point.copy(sample.position).addScaledVector(sample.left, (index === 0 ? 1 : -1) * side.barrier);
        const there = circuit.locate(point);
        expect(Math.abs(there.across)).toBeGreaterThan(there.sample.halfWidth);
      });
    }
  });

  it('measures how far round the lap any point is', () => {
    for (const sample of circuit.samples.filter((_sample, index) => index % 50 === 0)) {
      expect(circuit.progressAt(sample.position)).toBe(sample.distance);
    }
  });
});
