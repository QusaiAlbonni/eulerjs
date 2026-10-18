import { BatchedMesh, BoxGeometry, Mesh, Object3D, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Body, MassProperties, World } from '@eulerjs/core';
import { Buoyancy, Ocean, SpectralWaves, SumOfSines, Voxels, WaterMesh } from '@eulerjs/marine';

const calmSea = () => new Ocean({ waves: new SumOfSines({ waveCount: 0 }), density: 1000 });

describe('Buoyancy without explicit voxels', () => {
  it("uses the voxels of a body added with shape: 'voxels'", () => {
    const world = new World();
    const body = world.addBody(new Mesh(new BoxGeometry(1, 1, 1)), { shape: 'voxels', cellSize: 0.1, density: 150 });
    const buoyancy = body.addBehavior(new Buoyancy({ ocean: calmSea() }));
    expect(buoyancy.voxels).toBe(body.voxels);
  });

  it("voxelizes the body's meshes when the body has no voxels of its own, and floats it", () => {
    const world = new World();
    const body = world.addBody(new Mesh(new BoxGeometry(1, 1, 1)), { density: 150 });
    const buoyancy = body.addBehavior(new Buoyancy({ ocean: calmSea(), cellSize: 0.1 }));
    expect(buoyancy.voxels.cells).toHaveLength(1000);
    for (let step = 0; step < 30 * 120; step++) world.fixedStep();
    expect(0.5 - body.position.y).toBeCloseTo(0.15, 3);
  });

  it('explains what it needs when there is nothing to voxelize', () => {
    const body = new Body({ massProperties: MassProperties.sphere(1, 1) });
    expect(() => body.addBehavior(new Buoyancy({ ocean: calmSea() }))).toThrow(/needs voxels/);
    expect(() => new Buoyancy({ ocean: calmSea() }).voxels).toThrow(/until it is added/);
  });

  it('still takes voxels directly', () => {
    const voxels = Voxels.fromGeometry(new BoxGeometry(1, 1, 1), { cellSize: 0.5 });
    const body = new Body({ massProperties: voxels.massProperties(100) });
    expect(body.addBehavior(new Buoyancy({ ocean: calmSea(), voxels })).voxels).toBe(voxels);
  });
});

describe('Ocean defaults', () => {
  it('comes with the standard sea, a spectral one', () => {
    const ocean = new Ocean();
    expect(ocean.waves).toBeInstanceOf(SpectralWaves);
    expect(ocean.surfaceHeight(3, 4, 5)).toBe(new SpectralWaves().heightAt(3, 4, 5));
  });
});

describe('WaterMesh conveniences', () => {
  it("renders an Ocean's waves", () => {
    const ocean = new Ocean({ waves: new SumOfSines() });
    expect(new WaterMesh(ocean, { chunkCount: 2 }).waves).toBe(ocean.waves);
  });

  it('says what to do with a sea it can\'t draw', () => {
    expect(() => new WaterMesh(new Ocean() as unknown as Ocean<SumOfSines>)).toThrow(/SpectralWater/);
  });

  it("animates itself before each render at the world's render time, and keeps BatchedMesh's own hook", () => {
    const ocean = new Ocean({ waves: new SumOfSines() });
    const world = new World({ timestep: 0.5 });
    const follow = new Object3D();
    follow.position.set(40, 0, 0);
    const water = new WaterMesh(ocean, { chunkCount: 2, world, follow });
    world.step(0.75);

    const batchedHook = vi.spyOn(BatchedMesh.prototype, 'onBeforeRender').mockImplementation(() => {});
    const renderArguments = [{}, {}, {}, {}, {}, {}] as unknown as Parameters<BatchedMesh['onBeforeRender']>;
    water.onBeforeRender(...renderArguments);
    expect(water.uniforms.waveTime.value).toBeCloseTo(ocean.waves.phaseTime(world.renderTime), 12);
    expect(water.position.x).toBeCloseTo(Math.round(40 / water.lod.snapStep) * water.lod.snapStep, 9);
    expect(water.matrixWorld.elements[12]).toBeCloseTo(water.position.x, 9);
    expect(batchedHook).toHaveBeenCalledWith(...renderArguments);
    batchedHook.mockRestore();
  });

  it('leaves the time alone before rendering when it has no world', () => {
    const water = new WaterMesh(new SumOfSines(), { chunkCount: 2 });
    water.update(7);
    const batchedHook = vi.spyOn(BatchedMesh.prototype, 'onBeforeRender').mockImplementation(() => {});
    water.onBeforeRender(...([{}, {}, {}, {}, {}, {}] as unknown as Parameters<BatchedMesh['onBeforeRender']>));
    expect(water.uniforms.waveTime.value).toBeCloseTo(water.waves.phaseTime(7), 12);
    expect(batchedHook).toHaveBeenCalledOnce();
    batchedHook.mockRestore();
  });
});

describe('Voxels re-export', () => {
  it('is the core class', async () => {
    const core = await import('@eulerjs/core');
    expect(Voxels).toBe(core.Voxels);
    expect(new Vector3()).toBeDefined();
  });
});
