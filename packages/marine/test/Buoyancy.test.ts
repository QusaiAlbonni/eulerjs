import { BoxGeometry, Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, World } from 'eulerjs';
import { Buoyancy, Ocean, SpectralWaves, SumOfSines, Voxels } from '@eulerjs/marine';
import type { WaveSurface } from '@eulerjs/marine';

const TIMESTEP = 1 / 120;
const calmSea = () => new Ocean({ waves: new SumOfSines({ waveCount: 0 }), density: 1000 });

interface FloatingBox {
  world: World;
  body: Body;
  buoyancy: Buoyancy;
}

function floatingBox(size: Vector3, density: number, options: { ocean?: Ocean<WaveSurface>; cellSize?: number; quaternion?: Quaternion; height?: number } = {}): FloatingBox {
  const voxels = Voxels.fromGeometry(new BoxGeometry(size.x, size.y, size.z), { cellSize: options.cellSize ?? 0.1 });
  const world = new World({ timestep: TIMESTEP });
  const body = world.addBody(
    new Body({
      massProperties: voxels.massProperties(density * size.x * size.y * size.z),
      position: new Vector3(0, options.height ?? 0, 0),
      quaternion: options.quaternion ?? new Quaternion(),
    }),
  );
  const buoyancy = body.addBehavior(new Buoyancy({ ocean: options.ocean ?? calmSea(), voxels }));
  return { world, body, buoyancy };
}

function settle(world: World, seconds: number): void {
  for (let step = 0; step < seconds / TIMESTEP; step++) world.fixedStep();
}

function tiltFromUpright(body: Body): number {
  return new Vector3(0, 1, 0).applyQuaternion(body.quaternion).angleTo(new Vector3(0, 1, 0));
}

describe('Buoyancy', () => {
  // A floating cube is only stable upright below ~0.21 or above ~0.79 relative density.
  it.each([0.15, 0.9])('floats a cube of relative density %s upright, at a draft of that fraction of its height', (relativeDensity) => {
    const { world, body } = floatingBox(new Vector3(1, 1, 1), 1000 * relativeDensity);
    settle(world, 30);
    expect(tiltFromUpright(body)).toBeLessThan(1e-6);
    const draft = 0.5 - body.position.y;
    expect(draft).toBeCloseTo(relativeDensity, 3);
  });

  it('keeps a body denser than half the water afloat (the three-sails formula sank it)', () => {
    const { world, body, buoyancy } = floatingBox(new Vector3(1, 1, 1), 900);
    settle(world, 30);
    expect(body.position.y).toBeGreaterThan(-0.5);
    expect(buoyancy.submergedFraction).toBeCloseTo(0.9, 3);
  });

  it('sinks a body denser than water', () => {
    const { world, body } = floatingBox(new Vector3(1, 1, 1), 1200);
    settle(world, 10);
    expect(body.position.y).toBeLessThan(-3);
  });

  it.each([0.25, 0.5])('rolls a cube of relative density %s off upright, keeping that fraction under water', (relativeDensity) => {
    const { world, body, buoyancy } = floatingBox(new Vector3(1, 1, 1), 1000 * relativeDensity, {
      quaternion: new Quaternion().setFromEuler(new Euler(0.05, 0, 0.03)),
    });
    settle(world, 40);
    expect(buoyancy.submergedFraction).toBeCloseTo(relativeDensity, 2);
    expect(tiltFromUpright(body)).toBeGreaterThan(0.3);
  });

  it('rights a wide raft that starts tilted', () => {
    const { world, body } = floatingBox(new Vector3(4, 0.5, 4), 500, {
      cellSize: 0.25,
      quaternion: new Quaternion().setFromEuler(new Euler(0.35, 0, 0)),
    });
    settle(world, 30);
    expect(tiltFromUpright(body)).toBeLessThan(0.01);
  });

  it('damps heave so a dropped body comes to rest', () => {
    const { world, body } = floatingBox(new Vector3(1, 1, 1), 150, { height: 1.5 });
    settle(world, 30);
    expect(body.velocity.length()).toBeLessThan(1e-3);
    expect(body.angularVelocity.length()).toBeLessThan(1e-3);
  });

  it('does nothing to a body completely out of the water except the minimum drag', () => {
    const { world, body, buoyancy } = floatingBox(new Vector3(1, 1, 1), 500, { height: 10 });
    world.fixedStep();
    expect(buoyancy.submergedFraction).toBe(0);
    expect(buoyancy.lastForce.length()).toBe(0);
    expect(body.velocity.y).toBeCloseTo(-9.81 * TIMESTEP, 9);
  });

  it('does nothing without gravity', () => {
    const { world, body } = floatingBox(new Vector3(1, 1, 1), 500);
    world.gravity.set(0, 0, 0);
    world.fixedStep();
    expect(body.velocity.length()).toBe(0);
  });

  it('pushes with the weight of the displaced water', () => {
    const { world, buoyancy } = floatingBox(new Vector3(1, 1, 1), 500, { height: -0.25 });
    world.fixedStep();
    // 3/4 of a cubic metre under water; the damping term is zero on the first step
    expect(buoyancy.lastForce.y).toBeCloseTo(0.75 * 1000 * 9.81, 6);
    expect(buoyancy.submergedFraction).toBeCloseTo(0.75, 12);
  });

  // how far from the surface the box may get: for waves about 2 m high, or a third of the default spectral sea's height
  it.each([
    ['a sum of sines', () => new SumOfSines(), 1.5],
    ['a spectral sea', () => new SpectralWaves(), new SpectralWaves().significantWaveHeight / 3],
  ])('rides the waves of %s without drifting away or blowing up', (_name, makeWaves, largestGap) => {
    const ocean = new Ocean({ waves: makeWaves() });
    const { world, body } = floatingBox(new Vector3(2, 1, 4), 400, { ocean, cellSize: 0.5 });
    let worstGap = 0;
    for (let step = 0; step < 30 / TIMESTEP; step++) {
      world.fixedStep();
      const surface = ocean.surfaceHeight(body.worldCenterOfMass.x, body.worldCenterOfMass.z, world.time);
      if (step > 10 / TIMESTEP) worstGap = Math.max(worstGap, Math.abs(body.worldCenterOfMass.y - surface));
    }
    expect(body.position.toArray().every(Number.isFinite)).toBe(true);
    expect(worstGap).toBeLessThan(largestGap);
  });
});
