import { Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '@eulerjs/core';
import { Autopilot } from '../src/car/Autopilot.js';
import { F1Car } from '../src/car/F1Car.js';
import { addCircuitBodies } from '../src/track/circuitBodies.js';
import { Circuit, SURFACES } from '../src/track/Circuit.js';
import type { Surface } from '../src/track/Circuit.js';
import { MONZA } from '../src/track/monza.js';

// The car, the track, its surfaces and its walls together: driven round Monza by the autopilot,
// the car keeps to the track and comes round in a time near a Formula 1 car's. A pole lap there
// is about 1:20; the autopilot uses about four fifths of the grip, so it is some seconds slower.

describe('the walls of Monza', () => {
  it('stop a car driven into them, which never gets through', () => {
    const circuit = new Circuit(MONZA);
    const world = new World({ timestep: 1 / 120 });
    addCircuitBodies(world, circuit);
    // halfway along the longest stretch of wall on the right, turned to face it, at 100 km/h
    const [first, last] = circuit.wallRuns(1).reduce((longest, run) => (run[1] - run[0] > longest[1] - longest[0] ? run : longest));
    const sample = circuit.samples[Math.floor((first + last) / 2) % circuit.samples.length]!;
    const wall = sample.sides[1].barrier;
    const towardWall = sample.left.clone().negate();
    const car = new F1Car(world, new Object3D(), sample.position, Math.atan2(towardWall.x, towardWall.z));
    car.body.velocity.copy(towardWall).multiplyScalar(100 / 3.6);
    for (const wheel of car.vehicle.wheels) wheel.spinSpeed = 100 / 3.6 / wheel.radius;
    let furthest = 0;
    for (let step = 0; step < 360; step++) {
      world.fixedStep();
      furthest = Math.max(furthest, car.body.position.clone().sub(sample.position).dot(towardWall));
    }
    // stopped at the wall, short of its line by about half the car's length
    expect(furthest).toBeLessThan(wall);
    expect(furthest).toBeGreaterThan(wall - 4);
    expect(car.body.velocity.length()).toBeLessThan(5);
  });
});

describe('a lap of Monza', () => {
  it('is driven on the track and the kerbs, in under 1:50', () => {
    const circuit = new Circuit(MONZA);
    const world = new World({ timestep: 1 / 120 });
    addCircuitBodies(world, circuit);
    const grid = circuit.samples[circuit.samples.length - 8]!;
    const onSurface = new Map<Surface, number>();
    const car = new F1Car(world, new Object3D(), grid.position, circuit.startHeading, (point) => {
      const surface = circuit.surfaceAt(point);
      onSurface.set(surface, (onSurface.get(surface) ?? 0) + 1);
      return SURFACES[surface];
    });
    const autopilot = new Autopilot(circuit);

    let lastProgress = circuit.progressAt(car.body.position);
    let covered = 0;
    let lapTime: number | undefined;
    let crossedAt: number | undefined;
    for (let step = 0; step < 120 * 240 && lapTime === undefined; step++) {
      autopilot.drive(car);
      world.fixedStep();
      const progress = circuit.progressAt(car.body.position);
      let moved = progress - lastProgress;
      if (moved < -circuit.length / 2) moved += circuit.length;
      covered += moved;
      // timed from the first crossing of the line, a flying lap, to the next
      if (progress < lastProgress - circuit.length / 2) {
        const now = step * world.timestep;
        if (crossedAt === undefined) {
          crossedAt = now;
          covered = 0;
        } else if (covered > circuit.length * 0.9) {
          lapTime = now - crossedAt;
        }
      }
      lastProgress = progress;
    }
    const wheelSteps = [...onSurface.values()].reduce((sum, count) => sum + count, 0);
    const offTrack = ((onSurface.get('grass') ?? 0) + (onSurface.get('gravel') ?? 0)) / wheelSteps;
    process.stdout.write(`Monza: lap ${lapTime === undefined ? 'not finished' : `${Math.floor(lapTime / 60)}:${(lapTime % 60).toFixed(2).padStart(5, '0')}`}, ${(offTrack * 100).toFixed(2)}% of wheel-steps on grass or gravel\n`);
    expect(lapTime).toBeDefined();
    expect(lapTime!).toBeLessThan(110);
    expect(offTrack).toBeLessThan(0.02);
  }, 120_000);
});
