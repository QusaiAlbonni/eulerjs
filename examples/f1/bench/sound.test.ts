import { it } from 'vitest';
import { QUIET } from '../src/sound/dsp.js';
import { EngineSound } from '../src/sound/EngineSound.js';
import { GroundSound } from '../src/sound/GroundSound.js';
import { HybridSound } from '../src/sound/HybridSound.js';

// Not pass/fail: prints what the car's sound costs. The engine's simulation runs in a worker, and
// must keep ahead of the audio; the tyres and the ground run on the audio thread, which has a
// block of 128 samples to fill every 2.9 ms at 44.1 kHz. Run with `npm run bench`.

const report = (line: string) => process.stdout.write(`${line}\n`);
const SAMPLE_RATE = 44_100;

function costPerBlock(render: (block: Float32Array) => void, seconds: number): number {
  const block = new Float32Array(128);
  const blocks = Math.round((seconds * SAMPLE_RATE) / block.length);
  for (let warm = 0; warm < blocks / 4; warm++) render(block);
  const started = performance.now();
  for (let index = 0; index < blocks; index++) render(block);
  return ((performance.now() - started) * 1000) / blocks;
}

it('reports what the car’s sound costs', () => {
  const budget = (128 / SAMPLE_RATE) * 1e6;
  const engine = new EngineSound(SAMPLE_RATE, 1);
  engine.set({ ...QUIET, rpm: 11_000, throttle: 1 });
  const engineCost = costPerBlock((block) => engine.render(block), 5);
  report(`SOUND the F1 engine, engine-sim's simulation flat out: ${engineCost.toFixed(0)} µs per 128-sample block, ${((100 * engineCost) / budget).toFixed(0)}% of a worker's time`);
  const ground = new GroundSound(SAMPLE_RATE, 1);
  ground.set({ ...QUIET, speed: 80, squeal: 1, kerb: 0.5, rough: 0.5 });
  const groundCost = costPerBlock((block) => ground.render(block), 10);
  report(`SOUND the tyres, the ground and the wind, all at once: ${groundCost.toFixed(1)} µs per 128-sample block, ${((100 * groundCost) / budget).toFixed(1)}% of the audio thread's time`);
  const hybrid = new HybridSound(SAMPLE_RATE);
  hybrid.set({ ...QUIET, rpm: 11_000, throttle: 1, speed: 60 });
  const hybridCost = costPerBlock((block) => hybrid.render(block), 10);
  report(`SOUND the hybrid's whine, the MGU-K and the turbo: ${hybridCost.toFixed(1)} µs per 128-sample block, ${((100 * hybridCost) / budget).toFixed(1)}% of the audio thread's time`);
}, 120_000);
