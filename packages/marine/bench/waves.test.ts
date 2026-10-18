import { BoxGeometry, Vector3 } from 'three';
import { it } from 'vitest';
import { Body, World } from '@eulerjs/core';
import { Buoyancy, Ocean, SpectralWaves, SumOfSines, Voxels } from '@eulerjs/marine';
import type { WaveSurface } from '@eulerjs/marine';
import { benchmarkBackend, timeStep } from '../../core/bench/scenes.js';

// Not pass/fail: prints what the two seas cost the physics. Run with `npm run bench`.

const report = (line: string) => process.stdout.write(`${line}\n`);

it('reports what a height lookup costs on each sea', () => {
  const seas: [string, WaveSurface][] = [
    ['sum of sines', new SumOfSines()],
    ['spectral, 2 patches of 64²', new SpectralWaves()],
  ];
  for (const [name, waves] of seas) {
    let time = 0;
    let total = 0;
    // one evaluation a step, then the lookups of that step: the FFT's cost isn't in these
    const perLookup = timeStep(() => {
      time += 1 / 60;
      for (let lookup = 0; lookup < 1000; lookup++) total += waves.heightAt(lookup * 0.37, lookup * 0.11, time);
    }) / 1000;
    report(`WAVES ${name}: ${(perLookup * 1000).toFixed(2)} µs a heightAt${total === 0 ? ' ' : ''}`);
  }
}, 600_000);

it('reports what evaluating a spectral sea for one step costs', () => {
  for (const physicsResolution of [32, 64, 128]) {
    for (const physicsPatches of [1, 2, 3]) {
      const waves = new SpectralWaves({ physicsResolution, physicsPatches });
      let time = 0;
      const perStep = timeStep(() => {
        time += 1 / 60;
        waves.heightAt(0, 0, time);
      });
      report(`WAVES spectral evaluation, ${physicsPatches} patch${physicsPatches > 1 ? 'es' : ''} of ${physicsResolution}²: ${perStep.toFixed(3)} ms a step`);
    }
  }
}, 600_000);

it('reports what floating crates cost on each sea', () => {
  const makeSeas: [string, () => WaveSurface][] = [
    ['sum of sines', () => new SumOfSines()],
    ['spectral', () => new SpectralWaves()],
  ];
  for (const crateCount of [1, 20]) {
    for (const [name, makeWaves] of makeSeas) {
      const world = new World({ backend: benchmarkBackend() });
      const ocean = new Ocean({ waves: makeWaves() });
      const size = new Vector3(2, 1, 3);
      const voxels = Voxels.fromGeometry(new BoxGeometry(size.x, size.y, size.z), { cellSize: 0.25 });
      for (let index = 0; index < crateCount; index++) {
        const body = world.addBody(new Body({ massProperties: voxels.massProperties(400 * size.x * size.y * size.z), position: new Vector3((index % 5) * 8, 0, Math.floor(index / 5) * 8), canSleep: false }));
        body.addBehavior(new Buoyancy({ ocean, voxels }));
      }
      for (let step = 0; step < 120; step++) world.fixedStep();
      const perStep = timeStep(() => world.fixedStep());
      report(`WAVES ${crateCount} crate${crateCount > 1 ? 's' : ''} afloat on ${name}: ${perStep.toFixed(3)} ms a step`);
    }
  }
}, 600_000);

it('reports what laying the water out around the viewer costs, each way', async () => {
  const { PerspectiveCamera } = await import('three/webgpu');
  const { GpuWaveFields } = await import('../src/webgpu/GpuWaveFields.js');
  const { QuadtreeLod } = await import('../src/webgpu/QuadtreeLod.js');
  const { RingLod } = await import('../src/webgpu/RingLod.js');
  const fields = new GpuWaveFields(new SpectralWaves({ resolution: 16, physicsResolution: 16 }));
  const rings = new RingLod(fields);
  const quadtree = new QuadtreeLod(fields);
  for (const height of [2, 30, 400]) {
    const centre = new Vector3(0, height, 0);
    const camera = new PerspectiveCamera(55, 16 / 9, 0.5, 1e6);
    camera.position.copy(centre);
    camera.lookAt(0, 0, -Math.max(30, 4 * height));
    let moved = 0;
    // the viewer moving, so the layout changes every frame
    const step = () => {
      moved += 0.37;
      centre.x = camera.position.x = moved;
    };
    const ringTime = timeStep(() => {
      step();
      rings.update(centre);
    });
    const quadtreeTime = timeStep(() => {
      step();
      quadtree.update(centre);
    });
    const culledTime = timeStep(() => {
      step();
      quadtree.update(centre, camera);
    });
    report(`WATER LOD from ${height} m: rings ${ringTime.toFixed(3)} ms (${rings.drawCallCount} draw calls, ${rings.triangleCount} triangles), quadtree ${quadtreeTime.toFixed(3)} ms, culled to the view ${culledTime.toFixed(3)} ms (${quadtree.nodeCount} nodes, ${quadtree.triangleCount} triangles)`);
  }
}, 600_000);
