import type { F1Car } from '../car/F1Car.js';
import type { CarState, Message, PlayerSlot } from './protocol.js';
import type { Transport } from './transport.js';

/** How often a player says where their car is, a second. */
const STATE_RATE = 30;
/** How often a player sets their clock by the host's, in seconds, and the host says who is in the room. */
const CLOCK_EVERY = 1;
/** How long a player may be silent before they are taken to have left, in seconds. */
const SILENCE = 3;
export const MOST_PLAYERS = 10;

/** What the game does as the session goes: the cars that come and go, this player's place on the grid, the start. */
export interface SessionEvents {
  /** Another player's car, first heard of: a slot for its livery. */
  joined(id: string, slot: number): void;
  left(id: string): void;
  /** A state from another player's car, sent at `sentAt` on the host's clock. */
  state(id: string, state: CarState, sentAt: number): void;
  /** This player's slot, from the host; the host's own is 0. */
  slot(slot: number): void;
  /** The race starts: the lights come on and go out at these times on the host's clock, in seconds. */
  start(lightsAt: number, outAt: number): void;
}

/**
 * One player's side of a race in a room. The host gives out the slots, says who is in the room,
 * passes every car's state on to everyone else, and starts the race; every other player talks
 * only to the host.
 */
export class Session {
  readonly isHost: boolean;
  /** This player's slot, once the host has given it; the host's is 0. */
  slot: number | undefined;
  /** The round trip to the host, in milliseconds, the last time it was measured; 0 for the host. */
  ping = 0;
  private readonly transport: Transport;
  private readonly events: SessionEvents;
  private readonly roster = new Map<string, number>();
  private readonly heard = new Map<string, number>();
  private hostId: string | undefined;
  /** The host's clock against this one, in seconds: least-delayed answer wins. */
  private hostClockAhead = 0;
  private bestRoundTrip = Number.POSITIVE_INFINITY;
  private nextState = 0;
  private nextClock = 0;

  constructor(transport: Transport, isHost: boolean, events: SessionEvents) {
    this.transport = transport;
    this.isHost = isHost;
    this.events = events;
    transport.onMessage((message) => this.receive(message));
    if (isHost) {
      this.hostId = transport.id;
      this.slot = 0;
      this.roster.set(transport.id, 0);
      events.slot(0);
    } else this.send({ kind: 'hello', from: transport.id });
    // the page closing: the others told at once rather than finding out from the silence
    globalThis.addEventListener?.('pagehide', () => this.send({ kind: 'bye', from: transport.id }));
  }

  get id(): string {
    return this.transport.id;
  }

  /** How many are in the room, this player too. */
  get players(): number {
    return Math.max(this.roster.size, 1);
  }

  /** This player's clock, in seconds. */
  now(): number {
    return performance.now() / 1000;
  }

  /** Whether this player has heard the host's time yet; the host has its own. */
  get clockSet(): boolean {
    return this.isHost || Number.isFinite(this.bestRoundTrip);
  }

  /** The host's clock, as well as this player can tell it, in seconds. */
  hostNow(): number {
    return this.hostTimeAt(this.now());
  }

  /** The host's clock when this player's read `localTime`, in seconds. */
  hostTimeAt(localTime: number): number {
    return localTime + this.hostClockAhead;
  }

  /** The host only: starts the race for everyone, the lights coming on in a moment and going out at a time no one can guess. */
  startRace(): void {
    if (!this.isHost) return;
    const lightsAt = this.hostNow() + 1.5;
    const outAt = lightsAt + 5 + 0.4 + Math.random() * 2;
    this.send({ kind: 'start', from: this.id, lightsAt, outAt });
    this.events.start(lightsAt, outAt);
  }

  /** Each frame: says where this player's car is, sets the clock, and lets go of players gone silent. */
  update(car: F1Car): void {
    const now = this.now();
    // a player's states wait for their clock: stamped without it, they would be taken for older or newer than they are
    if (now >= this.nextState && this.slot !== undefined && this.clockSet) {
      this.nextState = Math.max(this.nextState + 1 / STATE_RATE, now);
      const state = stateOf(car);
      // stamped on the host's clock, so that everyone can tell how old it is when it comes; the
      // host's own goes straight to everyone, another player's to the host, to pass on
      const sentAt = this.hostTimeAt(now);
      const slot = this.slot;
      if (this.isHost) this.send({ kind: 'state', from: this.id, slot, sentAt, state });
      else if (this.hostId) this.send({ kind: 'state', from: this.id, to: this.hostId, slot, sentAt, state });
    }
    if (now >= this.nextClock) {
      this.nextClock = now + CLOCK_EVERY;
      if (this.isHost) this.sendRoster();
      else if (this.hostId) this.send({ kind: 'ping', from: this.id, to: this.hostId, sentAt: now });
      else this.send({ kind: 'hello', from: this.id });
    }
    for (const [id, heardAt] of this.heard) {
      if (now - heardAt < SILENCE) continue;
      this.forget(id);
    }
  }

  private receive(message: Message): void {
    const now = this.now();
    if (message.from !== this.id) this.heard.set(message.from, now);
    switch (message.kind) {
      case 'hello':
        if (this.isHost) this.welcome(message.from);
        break;
      case 'welcome':
        this.hostId = message.from;
        this.slot = message.slot;
        this.events.slot(message.slot);
        // the clock set at once, not a second on
        this.nextClock = 0;
        break;
      case 'roster':
        this.hostId = message.from;
        this.syncRoster(message.players);
        break;
      case 'state': {
        if (message.slot === this.slot) break;
        // the host takes from each player only their own car, and passes it on to all the others
        if (this.isHost) {
          if (this.roster.get(message.from) !== message.slot) break;
          this.send({ kind: 'state', from: this.id, slot: message.slot, sentAt: message.sentAt, state: message.state }, message.from);
        }
        const origin = this.idOfSlot(message.slot);
        if (origin === undefined) break;
        this.heard.set(origin, now);
        this.events.state(origin, message.state, message.sentAt);
        break;
      }
      case 'ping':
        if (this.isHost) this.send({ kind: 'pong', from: this.id, to: message.from, sentAt: message.sentAt, hostTime: this.now() });
        break;
      case 'pong': {
        const roundTrip = now - message.sentAt;
        this.ping = roundTrip * 1000;
        // the answer least held up says the most about the host's clock: half the trip each way
        if (roundTrip <= this.bestRoundTrip * 1.2) {
          this.bestRoundTrip = Math.min(this.bestRoundTrip, roundTrip);
          this.hostClockAhead = message.hostTime + roundTrip / 2 - now;
        }
        break;
      }
      case 'start':
        this.events.start(message.lightsAt, message.outAt);
        break;
      case 'bye':
        this.forget(message.from);
        break;
    }
  }

  /** The host: a slot for a newcomer, the lowest free, and the room told. */
  private welcome(id: string): void {
    let slot = this.roster.get(id);
    if (slot === undefined) {
      const taken = new Set(this.roster.values());
      slot = [...Array(MOST_PLAYERS).keys()].find((candidate) => !taken.has(candidate));
      // the room is full: they can watch, but not race
      if (slot === undefined) return;
      this.roster.set(id, slot);
      this.events.joined(id, slot);
    }
    this.send({ kind: 'welcome', from: this.id, to: id, slot });
    this.sendRoster();
  }

  private idOfSlot(slot: number): string | undefined {
    for (const [id, taken] of this.roster) if (taken === slot) return id;
    return undefined;
  }

  private sendRoster(): void {
    this.send({ kind: 'roster', from: this.id, players: [...this.roster].map(([id, slot]) => ({ id, slot })) });
  }

  /** A player: the room as the host says it is, the cars of those who came and went. */
  private syncRoster(players: PlayerSlot[]): void {
    for (const { id, slot } of players) {
      if (this.roster.get(id) === slot) continue;
      this.roster.set(id, slot);
      if (id !== this.id) this.events.joined(id, slot);
    }
    const present = new Set(players.map((player) => player.id));
    for (const id of [...this.roster.keys()]) if (!present.has(id)) this.forget(id);
  }

  private forget(id: string): void {
    this.heard.delete(id);
    if (!this.roster.delete(id)) return;
    this.events.left(id);
    if (this.isHost) this.sendRoster();
  }

  private send(message: Message, except?: string): void {
    this.transport.send(message, except);
  }
}

/** What the other players need of a car, in a form that goes over the network. */
export function stateOf(car: F1Car): CarState {
  const body = car.body;
  return {
    position: body.position.toArray(),
    quaternion: body.quaternion.toArray() as [number, number, number, number],
    velocity: body.velocity.toArray(),
    angularVelocity: body.angularVelocity.toArray(),
    steer: car.input.steer,
    wheels: car.vehicle.wheels.map((wheel) => [wheel.compression, wheel.steerAngle, wheel.spinSpeed]),
  };
}
