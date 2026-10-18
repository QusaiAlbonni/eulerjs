import { Scene, Vector3 } from 'three';
import { World } from 'eulerjs';
import type { Body } from 'eulerjs';
import { test } from 'vitest';
import { createCarPhysics } from '../src/car/createCarPhysics.js';
import { BLOCK_PITCH, createCity } from '../src/city/createCity.js';
import { Crowd } from '../src/people/Crowd.js';
import { benchmarkBackend } from '../../../packages/eulerjs/bench/scenes.js';
import { Autopilot } from './Autopilot.js';

/**
 * A realistic mix of sleeping and awake bodies: the city example's towers, lamp posts, trees,
 * crates, cones and barrels, a car driven round it, and a crowd of ragdoll pedestrians walking
 * the pavements. The car's lap cuts across the plaza, through its crates and over its walkways,
 * so props get knocked about and people knocked down as a player would.
 */

const CROWD_SIZES = [0, 25, 50, 100];
const WARM_UP_SECONDS = 3;
const MEASURED_SECONDS = 60;

const half = BLOCK_PITCH / 2;
/** Round the streets, and once across the plaza block from west to east. */
const LAP = [
  new Vector3(0, 0, -BLOCK_PITCH),
  new Vector3(0, 0, half),
  new Vector3(BLOCK_PITCH, 0, half),
  new Vector3(BLOCK_PITCH, 0, 2 * BLOCK_PITCH),
  new Vector3(-BLOCK_PITCH, 0, 2 * BLOCK_PITCH),
  new Vector3(-BLOCK_PITCH, 0, -BLOCK_PITCH),
];

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

interface Scenario {
  readonly world: World;
  readonly crowd: Crowd;
  readonly autopilot: Autopilot;
  readonly props: readonly Body[];
}

function cityScenario(crowdSize: number): Scenario {
  const world = new World({ backend: benchmarkBackend() });
  const city = createCity(world, new Scene());
  const { body, vehicle } = createCarPhysics({ world, position: LAP.at(-1)!.clone() });
  const crowd = world.use(new Crowd(world, { count: crowdSize, blocks: city.blocks, random: seededRandom(17) }));
  return { world, crowd, autopilot: new Autopilot(body, vehicle, LAP), props: city.props };
}

/** Times `count` calls of a method of `owner` into `timings[label]`. */
function timeMethod(owner: object, method: string, label: string, timings: Record<string, number>): void {
  const target = owner as Record<string, (...args: unknown[]) => unknown>;
  const original = target[method]!.bind(owner);
  timings[label] = 0;
  target[method] = (...args: unknown[]) => {
    const started = performance.now();
    const result = original(...args);
    timings[label]! += performance.now() - started;
    return result;
  };
}

const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;

test('the city with traffic and a crowd', () => {
  for (const crowdSize of CROWD_SIZES) {
    const { world, crowd, autopilot, props } = cityScenario(crowdSize);
    const timings: Record<string, number> = {};
    const backend = world.backend as unknown as { collisions: object };
    timeMethod(world.backend, 'step', 'backend', timings);
    timeMethod(backend.collisions, 'findCandidatePairs', 'pairs', timings);
    timeMethod(backend.collisions, 'detectContacts', 'contacts', timings);
    timeMethod(crowd, 'applyForces', 'crowd', timings);
    for (let step = 0; step < Math.round(WARM_UP_SECONDS / world.timestep); step++) {
      autopilot.drive();
      world.fixedStep();
    }
    for (const label of Object.keys(timings)) timings[label] = 0;

    const dynamicBodies = world.bodies.filter((body) => body.type === 'dynamic');
    const staticCount = world.bodies.length - dynamicBodies.length;
    const stepTimes: number[] = [];
    let awakeTotal = 0;
    let awakePropsTotal = 0;
    let walkingTotal = 0;
    let knockedDown = 0;
    let mostAwake = 0;
    const steps = Math.round(MEASURED_SECONDS / world.timestep);
    for (let step = 0; step < steps; step++) {
      autopilot.drive();
      const walkingBefore = crowd.counts.walking;
      const started = performance.now();
      world.fixedStep();
      stepTimes.push(performance.now() - started);
      const awake = dynamicBodies.filter((body) => !body.isSleeping).length;
      awakeTotal += awake;
      mostAwake = Math.max(mostAwake, awake);
      awakePropsTotal += props.filter((prop) => !prop.isSleeping).length;
      walkingTotal += crowd.counts.walking;
      knockedDown += Math.max(0, walkingBefore - crowd.counts.walking);
    }

    const totalTime = stepTimes.reduce((sum, time) => sum + time, 0);
    stepTimes.sort((first, second) => first - second);
    const perSecond = (time: number) => (time / MEASURED_SECONDS).toFixed(0);
    process.stdout.write(
      [
        `CITY ${crowdSize} people: ${world.bodies.length} bodies (${staticCount} static, ${dynamicBodies.length} dynamic), ${world.joints.length} joints`,
        `     awake on average ${(awakeTotal / steps).toFixed(0)} of ${dynamicBodies.length} dynamic (${((100 * awakeTotal) / steps / dynamicBodies.length).toFixed(0)}%, at most ${mostAwake}); ` +
          `${(walkingTotal / steps).toFixed(1)} people walking, ${(awakePropsTotal / steps).toFixed(1)} of ${props.length} props awake; ${knockedDown} people knocked down in ${autopilot.laps} laps`,
        `     ${perSecond(totalTime)} ms per simulated second; step median ${percentile(stepTimes, 0.5).toFixed(2)} ms, 95th percentile ${percentile(stepTimes, 0.95).toFixed(2)} ms, worst ${stepTimes.at(-1)!.toFixed(2)} ms`,
        `     per simulated second: crowd ${perSecond(timings.crowd!)} ms, engine ${perSecond(timings.backend!)} ms (pair search ${perSecond(timings.pairs!)}, contact detection ${perSecond(timings.contacts!)}, solver and integration ${perSecond(timings.backend! - timings.pairs! - timings.contacts!)}), syncing with the world ${perSecond(totalTime - timings.backend! - timings.crowd!)} ms`,
        '',
      ].join('\n'),
    );
  }
});
