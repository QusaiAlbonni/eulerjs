import { BoxGeometry, Vector3 } from 'three';
import { Body, World } from 'eulerjs';
import { Buoyancy, Ocean, SpectralWaves, SumOfSines, Voxels } from '@eulerjs/marine';
import type { WaveSurface } from '@eulerjs/marine';

// What floating crates cost the main thread, frame by frame, on a sum of sines and on a spectral
// sea evaluated on the main thread or in a worker: the worker's answers come back between frames,
// so this has to run in a real page's frame loop to mean anything.

type Sea = 'sum of sines' | 'spectral, main thread' | 'spectral, worker';

interface Run {
  sea: Sea;
  crateCount: number;
  stepsPerSecond: number;
}

interface RunResult extends Run {
  /** Main-thread time in world.step, a frame: median and the 95th percentile, in ms. */
  medianStep: number;
  slowStep: number;
  ready: number;
  missed: number;
}

const WARM_UP_FRAMES = 60;
const MEASURED_FRAMES = 300;
const FRAME_DELTA = 1 / 60;

function makeWaves(sea: Sea): { waves: WaveSurface; worker?: Worker } {
  if (sea === 'sum of sines') return { waves: new SumOfSines() };
  const waves = new SpectralWaves();
  if (sea === 'spectral, main thread') return { waves };
  const worker = new Worker(new URL('../../../packages/marine/src/waves/spectralWorkerEntry.ts', import.meta.url), { type: 'module' });
  waves.useWorker(worker);
  return { waves, worker };
}

function makeWorld(run: Run, waves: WaveSurface): World {
  const world = new World({ timestep: 1 / run.stepsPerSecond });
  const ocean = new Ocean({ waves });
  const size = new Vector3(2, 1, 3);
  const voxels = Voxels.fromGeometry(new BoxGeometry(size.x, size.y, size.z), { cellSize: 0.25 });
  for (let index = 0; index < run.crateCount; index++) {
    const body = world.addBody(new Body({ massProperties: voxels.massProperties(400 * size.x * size.y * size.z), position: new Vector3((index % 5) * 8, 0, Math.floor(index / 5) * 8), canSleep: false }));
    body.addBehavior(new Buoyancy({ ocean, voxels }));
  }
  return world;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

async function measure(run: Run): Promise<RunResult> {
  const { waves, worker } = makeWaves(run.sea);
  const world = makeWorld(run, waves);
  const stepTimes: number[] = [];
  for (let frame = 0; frame < WARM_UP_FRAMES + MEASURED_FRAMES; frame++) {
    await nextFrame();
    const started = performance.now();
    // a fixed frame's worth, so every run steps the same whatever the display's rate
    world.step(FRAME_DELTA);
    if (frame >= WARM_UP_FRAMES) stepTimes.push(performance.now() - started);
  }
  worker?.terminate();
  const statistics = waves instanceof SpectralWaves ? waves.workerStatistics : { ready: 0, missed: 0 };
  return { ...run, medianStep: percentile(stepTimes, 0.5), slowStep: percentile(stepTimes, 0.95), ...statistics };
}

async function main(): Promise<void> {
  const output = document.getElementById('results')!;
  const lines: string[] = [];
  const results: RunResult[] = [];
  const seas: Sea[] = ['sum of sines', 'spectral, main thread', 'spectral, worker'];
  for (const stepsPerSecond of [60, 120]) {
    for (const crateCount of [1, 20]) {
      for (const sea of seas) {
        const result = await measure({ sea, crateCount, stepsPerSecond });
        results.push(result);
        const workerNote = sea === 'spectral, worker' ? `, worker ready ${result.ready}, missed ${result.missed}` : '';
        lines.push(`${stepsPerSecond} Hz, ${crateCount} crate${crateCount > 1 ? 's' : ''}, ${sea}: ${result.medianStep.toFixed(3)} ms a frame (95th percentile ${result.slowStep.toFixed(3)})${workerNote}`);
        output.textContent = `${lines.join('\n')}\nRunning…`;
      }
    }
  }
  output.textContent = lines.join('\n');
  (window as unknown as { benchResults: RunResult[] }).benchResults = results;
}

void main();
