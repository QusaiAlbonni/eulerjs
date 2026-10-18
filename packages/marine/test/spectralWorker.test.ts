import { BoxGeometry, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { Body, World } from '@eulerjs/core';
import { Buoyancy, Ocean, serveSpectralFields, SpectralWaves, Voxels } from '@eulerjs/marine';
import type { SpectralPort } from '@eulerjs/marine';

// The worker's protocol, served on one end of a MessageChannel: the messages go between threads
// just the same, only the evaluating isn't on another one.
const channels: MessageChannel[] = [];
function workerPort(): SpectralPort {
  const channel = new MessageChannel();
  channels.push(channel);
  serveSpectralFields(channel.port2 as unknown as SpectralPort);
  return channel.port1 as unknown as SpectralPort;
}
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

/** Lets the messages in flight be delivered, as they are between a page's frames. */
async function betweenFrames(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function floatingCrate(waves: SpectralWaves): { world: World; body: Body } {
  const size = new Vector3(2, 1, 3);
  const voxels = Voxels.fromGeometry(new BoxGeometry(size.x, size.y, size.z), { cellSize: 0.5 });
  const world = new World({ timestep: 1 / 60 });
  const body = world.addBody(new Body({ massProperties: voxels.massProperties(400 * size.x * size.y * size.z), canSleep: false }));
  body.addBehavior(new Buoyancy({ ocean: new Ocean({ waves }), voxels }));
  return { world, body };
}

describe('spectral sea in a worker', () => {
  it('sends back the very fields the main thread evaluates', async () => {
    const here = new SpectralWaves({ windSpeed: 12 });
    const there = new SpectralWaves({ windSpeed: 12 });
    there.useWorker(workerPort());
    there.prefetch(2.5);
    await betweenFrames();
    for (const [worldX, worldZ] of [[0, 0], [33.3, -71], [-400, 250]] as const) {
      expect(there.heightAt(worldX, worldZ, 2.5)).toBe(here.heightAt(worldX, worldZ, 2.5));
    }
    expect(there.workerStatistics).toEqual({ ready: 1, missed: 0 });
  });

  it('has each step ready ahead, so a floating body moves exactly as without it', async () => {
    const alone = floatingCrate(new SpectralWaves());
    const waves = new SpectralWaves();
    waves.useWorker(workerPort());
    const helped = floatingCrate(waves);
    // frames of one, two and three steps
    for (let frame = 0; frame < 60; frame++) {
      const steps = 1 + (frame % 3);
      for (let step = 0; step < steps; step++) {
        alone.world.fixedStep();
        helped.world.fixedStep();
      }
      await betweenFrames();
    }
    expect(helped.body.position.toArray()).toEqual(alone.body.position.toArray());
    expect(helped.body.quaternion.toArray()).toEqual(alone.body.quaternion.toArray());
    // only the first frame's steps, asked for during it, are evaluated here
    expect(waves.workerStatistics.missed).toBeLessThanOrEqual(1);
    expect(waves.workerStatistics.ready).toBeGreaterThan(110);
  });

  it('keeps the render frame between steps from redoing a step', () => {
    const waves = new SpectralWaves();
    waves.heightAt(0, 0, 1);
    waves.heightAt(0, 0, 1.01);
    const start = performance.now();
    for (let frame = 0; frame < 200; frame++) {
      waves.heightAt(0, 0, 1);
      waves.heightAt(0, 0, 1.01);
    }
    // two evaluations would take a millisecond: 400 of them, nearly half a second
    expect(performance.now() - start).toBeLessThan(20);
  });
});
