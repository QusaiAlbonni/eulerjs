import { it } from 'vitest';
import { boxStack, runSeconds } from './scenes.js';

// Not a pass/fail test: prints how steady a stack kept awake stays, to compare solver changes.
// Awake, since a stack that falls asleep stops drifting whatever the solver does.
it('reports stack quality', () => {
  for (const substeps of [4, 8]) {
    for (const height of [3, 4, 5, 8]) {
      const { world, top } = boxStack(height, substeps, false);
      let furthest = 0;
      for (let second = 0; second < 60; second++) {
        runSeconds(world, 1);
        furthest = Math.max(furthest, Math.hypot(top.position.x, top.position.z));
      }
      const drift = Math.hypot(top.position.x, top.position.z) * 1000;
      process.stdout.write(
        `QUALITY ${height}-box stack at ${substeps} substeps: top drifted up to ${(furthest * 1000).toFixed(1)} mm in 60 s, ${drift.toFixed(1)} mm at the end, moving at ${(top.velocity.length() * 1000).toFixed(1)} mm/s\n`,
      );
    }
  }
});
