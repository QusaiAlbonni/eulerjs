import { Object3D, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { F1Car } from '../src/car/F1Car.js';
import type { CarState } from '../src/multiplayer/protocol.js';
import { Session } from '../src/multiplayer/Session.js';
import type { SessionEvents } from '../src/multiplayer/Session.js';
import { LaggyTransport, TabTransport } from '../src/multiplayer/transport.js';
import type { Transport } from '../src/multiplayer/transport.js';

// A host and a player in one room, over the channel the tabs use, the network's lag played at
// 120 ms a round trip: the player is given a slot, the clocks are set, each hears the other's
// car, and the race starts for both at the same moment.

const open: Transport[] = [];
afterEach(() => {
  for (const transport of open.splice(0)) transport.close();
});

function player(room: string, isHost: boolean, heard: { slot?: number; states: { id: string; state: CarState }[]; start?: [number, number] }): { session: Session; car: F1Car } {
  const transport = new LaggyTransport(new TabTransport(room), { ping: 120, jitter: 0, loss: 0 });
  open.push(transport);
  const events: SessionEvents = {
    joined: () => {},
    left: () => {},
    state: (id, state) => heard.states.push({ id, state }),
    slot: (slot) => (heard.slot = slot),
    start: (lightsAt, outAt) => (heard.start = [lightsAt, outAt]),
  };
  const car = new F1Car(new World({ timestep: 1 / 120 }), new Object3D(), new Vector3(Math.random() * 100, 0, 0));
  return { session: new Session(transport, isHost, events), car };
}

/** Runs both sessions for `seconds`, as frames would. */
async function run(seconds: number, ...players: { session: Session; car: F1Car }[]): Promise<void> {
  const until = performance.now() + seconds * 1000;
  while (performance.now() < until) {
    for (const { session, car } of players) session.update(car);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('a race between two players', () => {
  it('seats the player, sets their clock by the host, and passes each car to the other', async () => {
    const room = `test-${Math.random()}`;
    const hostHeard: { slot?: number; states: { id: string; state: CarState }[]; start?: [number, number] } = { states: [] };
    const guestHeard: typeof hostHeard = { states: [] };
    const host = player(room, true, hostHeard);
    const guest = player(room, false, guestHeard);
    await run(2.5, host, guest);

    expect(hostHeard.slot).toBe(0);
    expect(guestHeard.slot).toBe(1);
    expect(host.session.players).toBe(2);
    // the round trip as measured, near what is played: 120 ms, and a little for the frames' waits
    expect(guest.session.ping).toBeGreaterThan(110);
    expect(guest.session.ping).toBeLessThan(170);
    // each hears the other's car, where it is
    const hostCar = guestHeard.states.filter(({ id }) => id === host.session.id).at(-1)!.state;
    const guestCar = hostHeard.states.filter(({ id }) => id === guest.session.id).at(-1)!.state;
    expect(hostCar.position[0]).toBeCloseTo(host.car.body.position.x, 3);
    expect(guestCar.position[0]).toBeCloseTo(guest.car.body.position.x, 3);
    // about 30 states a second each way, few lost to the frames' timing
    expect(guestHeard.states.length).toBeGreaterThan(2 * 30 * 0.8);

    // the start: the same moment for both, as each reads the host's clock
    host.session.startRace();
    await run(0.5, host, guest);
    const [hostLights] = hostHeard.start!;
    const [guestLights] = guestHeard.start!;
    expect(guestLights).toBe(hostLights);
    // the guest's idea of the host's clock, within a few milliseconds of it
    expect(Math.abs(guest.session.hostNow() - host.session.hostNow())).toBeLessThan(0.02);
  }, 10_000);
});
