import { Group, Object3D } from 'three';
import { World } from '@eulerjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Autopilot } from '../src/car/Autopilot.js';
import { F1Car } from '../src/car/F1Car.js';
import { RemoteCar } from '../src/multiplayer/RemoteCar.js';
import { Session } from '../src/multiplayer/Session.js';
import { LaggyTransport, TabTransport } from '../src/multiplayer/transport.js';
import type { Transport } from '../src/multiplayer/transport.js';
import { Circuit } from '../src/track/Circuit.js';
import { addCircuitBodies } from '../src/track/circuitBodies.js';
import { MONZA } from '../src/track/monza.js';

// Two players, each in a world of their own as they would be on their own machines, 120 ms of
// ping between them: one parked on the straight, the other driven into the back of them. Each
// world has the other's car as a solid car of its mass, where its player has it now. A car
// running into one standing still, the two the same mass, both should come out of it moving: the
// one hit pushed on, the one hitting slowed, neither as if it had met a wall.

const circuit = new Circuit(MONZA);
const open: Transport[] = [];
afterEach(() => {
  for (const transport of open.splice(0)) transport.close();
});

interface Player {
  world: World;
  car: F1Car;
  session: Session;
  others: Map<string, RemoteCar>;
}

function player(room: string, isHost: boolean, sampleIndex: number): Player {
  const world = new World({ timestep: 1 / 120, maxStepsPerFrame: 12 });
  addCircuitBodies(world, circuit);
  const sample = circuit.samples[sampleIndex]!;
  const car = new F1Car(world, new Object3D(), sample.position, Math.atan2(sample.tangent.x, sample.tangent.z), (point) => circuit.groundAt(point));
  const transport = new LaggyTransport(new TabTransport(room), { ping: 120, jitter: 0, loss: 0 });
  open.push(transport);
  const others = new Map<string, RemoteCar>();
  const session = new Session(transport, isHost, {
    joined: (id) => {
      if (!others.has(id)) others.set(id, new RemoteCar(world, { root: new Group(), update: () => {} }));
    },
    left: () => {},
    state: (id, state, sentAt) => others.get(id)?.receive(state, sentAt),
    slot: () => {},
    start: () => {},
  });
  return { world, car, session, others };
}

describe('two players colliding over the network', () => {
  it('push each other as two cars of a mass do, each in their own world', async () => {
    const room = `collision-${Math.random()}`;
    const start = circuit.samples.length - 200;
    const parked = player(room, true, start + 40);
    const driving = player(room, false, start);
    const autopilot = new Autopilot(circuit);
    const record: { time: number; drivingSpeed: number; parkedSpeed: number; apart: number; drivingSeenOff: number; parkedSeenOff: number }[] = [];
    const began = performance.now();
    let last = began;
    let going = false;
    while (performance.now() - began < 9000) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      const now = performance.now();
      const frameDelta = Math.min((now - last) / 1000, 0.05);
      last = now;
      // a second to settle in, the clocks set, then off
      going ||= now - began > 1500;
      parked.car.input.brake = 1;
      if (going) autopilot.drive(driving.car);
      else driving.car.input.brake = 1;
      for (const { world, car, session, others } of [parked, driving]) {
        world.update(frameDelta);
        for (const other of others.values()) other.draw(session.hostTimeAt(now / 1000), world, frameDelta);
        session.update(car);
      }
      const drivingAsParkedSees = [...parked.others.values()][0];
      const parkedAsDrivingSees = [...driving.others.values()][0];
      record.push({
        time: (now - began) / 1000,
        drivingSpeed: driving.car.body.velocity.length(),
        parkedSpeed: parked.car.body.velocity.length(),
        apart: driving.car.body.position.distanceTo(parked.car.body.position),
        drivingSeenOff: drivingAsParkedSees ? drivingAsParkedSees.body.position.distanceTo(driving.car.body.position) : Number.NaN,
        parkedSeenOff: parkedAsDrivingSees ? parkedAsDrivingSees.body.position.distanceTo(parked.car.body.position) : Number.NaN,
      });
    }

    const impact = record.findIndex((entry) => entry.apart < 5.5);
    expect(impact, 'the cars met').toBeGreaterThan(0);
    const before = record[impact - 1]!;
    const after = record.find((entry) => entry.time > before.time + 1)!;
    const report = `hit at ${(before.drivingSpeed * 3.6).toFixed(0)} km/h; a second on, the one hit at ${(after.parkedSpeed * 3.6).toFixed(0)} km/h, the one hitting at ${(after.drivingSpeed * 3.6).toFixed(0)} km/h; the moving car seen ${before.drivingSeenOff.toFixed(2)} m from where it was`;
    process.stdout.write(`${report}\n`);
    // each saw the other where it was as they met: the moving one carried on to now, not a ping behind
    expect(before.drivingSeenOff).toBeLessThan(1);
    expect(before.parkedSeenOff).toBeLessThan(0.5);
    // the one hit pushed on, the one hitting slowed, both of them: not a wall, and nothing gained
    expect(after.parkedSpeed).toBeGreaterThan(before.drivingSpeed * 0.25);
    expect(after.drivingSpeed).toBeGreaterThan(before.drivingSpeed * 0.15);
    expect(after.parkedSpeed + after.drivingSpeed).toBeLessThan(before.drivingSpeed * 1.2);
  }, 20_000);
});
