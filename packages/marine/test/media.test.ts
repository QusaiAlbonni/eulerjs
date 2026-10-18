import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ocean, SumOfSines, Wind } from '@eulerjs/marine';

describe('Ocean', () => {
  const waves = new SumOfSines();
  const ocean = new Ocean({ waves });

  it('defaults to seawater and reads its surface from the waves', () => {
    expect(ocean.density).toBe(1029);
    expect(ocean.surfaceHeight(3, 4, 2)).toBe(waves.heightAt(3, 4, 2));
    expect(ocean.surfaceNormal(3, 4, 2).distanceTo(waves.normalAt(3, 4, 2))).toBe(0);
  });

  it('holds still water under the moving surface', () => {
    expect(ocean.velocityAt(new Vector3(1, -2, 3), 5, new Vector3(9, 9, 9)).length()).toBe(0);
  });
});

describe('Wind', () => {
  it('blows toward its angle, measured from +x toward +z', () => {
    const wind = new Wind({ speed: 10, angle: Math.PI / 2 });
    const velocity = wind.velocityAt(new Vector3(), 0, new Vector3());
    expect(velocity.distanceTo(new Vector3(0, 0, 10))).toBeLessThan(1e-12);
  });

  it('defaults to the three-sails wind in sea-level air', () => {
    const wind = new Wind();
    expect([wind.speed, wind.angle, wind.density]).toEqual([13, 1.3, 1.293]);
  });
});
