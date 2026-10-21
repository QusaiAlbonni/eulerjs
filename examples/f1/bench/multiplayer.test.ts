import { Group, Object3D, Quaternion, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import { afterAll, expect, it } from 'vitest';
import { F1Car } from '../src/car/F1Car.js';
import type { Message } from '../src/multiplayer/protocol.js';
import { RemoteCar } from '../src/multiplayer/RemoteCar.js';
import { MOST_PLAYERS, Session } from '../src/multiplayer/Session.js';
import { STATE_BYTES } from '../src/multiplayer/stateCodec.js';
import { LaggyTransport, TabTransport } from '../src/multiplayer/transport.js';
import type { Transport } from '../src/multiplayer/transport.js';
import { Circuit } from '../src/track/Circuit.js';
import { addCircuitBodies } from '../src/track/circuitBodies.js';
import { MONZA } from '../src/track/monza.js';

// Not pass/fail on its timings: a full room, the host and nine players, 120 ms of ping, and what
// the host does for it. The host drives its own car in its own world, has the nine others in it
// as solid cars, and passes each player's states on to the rest. The players here are cars
// following the track in a pack, without worlds of their own: it is the host that is measured.
// Run with `npm run bench`.

const report = (line: string) => process.stdout.write(`${line}\n`);
const circuit = new Circuit(MONZA);
const open: Transport[] = [];
afterAll(() => {
  for (const transport of open.splice(0)) transport.close();
});

/** A transport that counts what passes through it and times what it hands on. */
class CountingTransport implements Transport {
  sent = 0;
  sentBytes = 0;
  broadcasts = 0;
  received = 0;
  handling = 0;
  private readonly inner: Transport;

  constructor(inner: Transport) {
    this.inner = inner;
  }

  get id(): string {
    return this.inner.id;
  }

  send(message: Message): void {
    this.sent++;
    if (message.to === undefined) this.broadcasts++;
    this.sentBytes += JSON.stringify(message).length;
    this.inner.send(message);
  }

  onMessage(handler: (message: Message) => void): void {
    this.inner.onMessage((message) => {
      this.received++;
      const started = performance.now();
      handler(message);
      this.handling += performance.now() - started;
    });
  }

  close(): void {
    this.inner.close();
  }
}

/** A player that is only a car going round in the pack, `place` cars back: its state, and nothing else. */
function packCar(place: number) {
  const samples = circuit.samples;
  const body = { position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), angularVelocity: new Vector3() };
  const car = { body, input: { steer: 0 }, vehicle: { wheels: [0, 1, 2, 3].map(() => ({ compression: 0.03, steerAngle: 0, spinSpeed: 140 })) } };
  const speed = 50;
  const lead = 10 * place;
  return {
    car: car as unknown as F1Car,
    moveTo(seconds: number) {
      // along the centre line, a car's length and more apart, a little to either side
      let left = (speed * seconds + 300 - lead + circuit.length) % circuit.length;
      let index = 0;
      while (left > samples[index]!.position.distanceTo(samples[(index + 1) % samples.length]!.position)) {
        left -= samples[index]!.position.distanceTo(samples[(index + 1) % samples.length]!.position);
        index = (index + 1) % samples.length;
      }
      const sample = samples[index]!;
      const next = samples[(index + 1) % samples.length]!;
      body.position.copy(sample.position).lerp(next.position, left / sample.position.distanceTo(next.position)).addScaledVector(sample.left, place % 2 === 0 ? 2.5 : -2.5);
      body.position.y = 0.28;
      body.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(sample.tangent.x, sample.tangent.z));
      body.velocity.copy(sample.tangent).multiplyScalar(speed);
    },
  };
}

it('reports what a full room costs the host', async () => {
  const room = `full-${Math.random()}`;
  const conditions = { ping: 120, jitter: 10, loss: 0 };
  const world = new World({ timestep: 1 / 120, maxStepsPerFrame: 12 });
  addCircuitBodies(world, circuit);
  const grid = circuit.samples[circuit.samples.length - 8]!;
  const hostCar = new F1Car(world, new Object3D(), grid.position, Math.atan2(grid.tangent.x, grid.tangent.z), (point) => circuit.groundAt(point));
  const hostTransport = new CountingTransport(new LaggyTransport(new TabTransport(room), conditions));
  open.push(hostTransport);
  const remotes = new Map<string, RemoteCar>();
  const host = new Session(hostTransport, true, {
    joined: (id) => {
      if (!remotes.has(id)) remotes.set(id, new RemoteCar(world, { root: new Group(), update: () => {} }));
    },
    left: () => {},
    state: (id, state, sentAt) => remotes.get(id)?.receive(state, sentAt),
    slot: () => {},
    start: () => {},
  });

  // nine players, each hearing the others through the host
  const players = [...Array(MOST_PLAYERS - 1).keys()].map((index) => {
    const pack = packCar(index + 1);
    const heard = new Map<string, number>();
    const slot: { value?: number } = {};
    const transport = new LaggyTransport(new TabTransport(room), conditions);
    open.push(transport);
    const session = new Session(transport, false, {
      joined: () => {},
      left: () => {},
      state: (id) => heard.set(id, performance.now()),
      slot: (value) => (slot.value = value),
      start: () => {},
    });
    return { pack, heard, slot, session };
  });

  const frames: number[] = [];
  const steps: number[] = [];
  const began = performance.now();
  let last = began;
  let countedFrom = { sent: 0, sentBytes: 0, broadcasts: 0, received: 0, handling: 0, at: 0 };
  while (performance.now() - began < 10_000) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    const now = performance.now();
    const frameDelta = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const player of players) {
      player.pack.moveTo((now - began) / 1000);
      player.session.update(player.pack.car);
    }
    // the host's frame: its world, the other cars in it, and its own state sent
    const frameStarted = performance.now();
    hostCar.input.brake = 1;
    world.update(frameDelta);
    const stepped = performance.now();
    for (const remote of remotes.values()) remote.draw(host.hostTimeAt(now / 1000), world, frameDelta);
    host.update(hostCar);
    const frameEnded = performance.now();
    // timed once everyone is in and settled
    if (now - began > 4000) {
      frames.push(frameEnded - frameStarted);
      steps.push(stepped - frameStarted);
    } else countedFrom = { sent: hostTransport.sent, sentBytes: hostTransport.sentBytes, broadcasts: hostTransport.broadcasts, received: hostTransport.received, handling: hostTransport.handling, at: now };
  }
  const seconds = (performance.now() - countedFrom.at) / 1000;
  const perSecond = (count: number, from: number) => (count - from) / seconds;

  // everyone in, each in a slot of their own, each hearing all the others lately
  expect(host.players).toBe(MOST_PLAYERS);
  expect(new Set(players.map((player) => player.slot.value)).size).toBe(MOST_PLAYERS - 1);
  const lately = performance.now() - 500;
  for (const player of players) expect([...player.heard.values()].filter((heardAt) => heardAt > lately).length).toBe(MOST_PLAYERS - 1);

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const worst = (values: number[]) => [...values].sort((first, second) => second - first)[Math.floor(values.length / 100)]!;
  const statesIn = perSecond(hostTransport.received, countedFrom.received);
  const messagesOut = perSecond(hostTransport.sent, countedFrom.sent);
  const bytesOut = perSecond(hostTransport.sentBytes, countedFrom.sentBytes);
  const broadcastsOut = perSecond(hostTransport.broadcasts, countedFrom.broadcasts);
  const handlingPerSecond = perSecond(hostTransport.handling, countedFrom.handling);
  // over WebRTC there is no broadcast: the host sends each of the nine players their own copy
  const uploadBytes = bytesOut + broadcastsOut * (MOST_PLAYERS - 2) * (bytesOut / Math.max(messagesOut, 1));
  const stateBytes = JSON.stringify({ kind: 'state', from: 'abcdefgh', origin: 'abcdefgh', sentAt: 1234.567, state: { position: [1, 2, 3].map(() => Math.random() * 1000), quaternion: [1, 2, 3, 4].map(() => Math.random()), velocity: [1, 2, 3].map(() => Math.random() * 90), angularVelocity: [1, 2, 3].map(() => Math.random()), steer: Math.random(), wheels: [0, 1, 2, 3].map(() => [Math.random() * 0.05, Math.random() * 0.3, Math.random() * 250]) } }).length;
  report(`MULTIPLAYER a full room of ${host.players}, 120 ms ping, the host's side:`);
  report(`  its frame: ${mean(frames).toFixed(2)} ms on average, ${worst(frames).toFixed(2)} ms at the worst 1%, of which its world's step (its car and the nine others) ${mean(steps).toFixed(2)} ms`);
  report(`  messages: ${statesIn.toFixed(0)} a second in, ${messagesOut.toFixed(0)} a second out; handling them ${handlingPerSecond.toFixed(1)} ms a second (${((handlingPerSecond / 1000) * 100).toFixed(2)}% of its time)`);
  report(`  a car's state as JSON: ${stateBytes} bytes; the host's upload over WebRTC, sending each player their own copy: ${((uploadBytes * 8) / 1e6).toFixed(1)} Mbit/s; its download ${((statesIn * stateBytes * 8) / 1e6).toFixed(2)} Mbit/s`);
  // the same states in binary, and the data channel's own headers on each (SCTP, DTLS, UDP, IP: about 60 bytes)
  const overhead = 60;
  const binaryUpload = (uploadBytes / stateBytes) * (STATE_BYTES + overhead);
  report(`  in binary: ${STATE_BYTES} bytes a state; the host's upload ${((binaryUpload * 8) / 1e6).toFixed(2)} Mbit/s with the channel's headers, its download ${((statesIn * (STATE_BYTES + overhead) * 8) / 1e6).toFixed(2)} Mbit/s; each player's upload ${((30 * (STATE_BYTES + overhead) * 8) / 1e6).toFixed(3)} Mbit/s`);
}, 30_000);
