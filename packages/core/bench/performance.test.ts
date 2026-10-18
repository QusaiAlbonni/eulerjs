import { it } from 'vitest';
import type { World } from '@eulerjs/core';
import { boxPile, rockPile, runSeconds, sphereField, timeStep } from './scenes.js';

// Not pass/fail: prints the cost of a step, to compare changes. Run with `npm run bench`.
it('reports step cost', () => {
  const scenes: [string, World, number][] = [
    ['125 boxes falling into a pile', boxPile(5, false), 0.5],
    ['125 boxes in a pile, never sleeping', boxPile(5, false), 3],
    ['125 boxes in a pile, settled and asleep', boxPile(5), 6],
    ['400 spheres spread out, never sleeping', sphereField(20, false), 1],
    ['400 spheres spread out, asleep', sphereField(20), 2],
    ['64 rocks (42-corner hulls) in a heap, never sleeping', rockPile(4, false), 3],
  ];
  for (const [label, world, settleSeconds] of scenes) {
    runSeconds(world, settleSeconds);
    const stepTime = timeStep(() => world.fixedStep());
    process.stdout.write(`PERFORMANCE ${label}: ${stepTime.toFixed(2)} ms per step, ${(stepTime / world.timestep).toFixed(0)} ms per simulated second\n`);
  }
}, 600_000);
