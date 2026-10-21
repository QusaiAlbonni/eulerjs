// What the players say to one another. One of them is the host: every other player talks only
// to it, and it passes the cars' states on to everyone, as it would over the internet, where
// the host is the one everyone can reach. Each player drives their own car and says where it is;
// the host gives out the places on the grid and starts the race.

/** A car as its player last saw it, enough to draw it and to bump into it. */
export interface CarState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
  /** The steering, −1 to 1. */
  steer: number;
  /** Each wheel's compression, steer angle and spin speed, front left, front right, rear left, rear right. */
  wheels: [number, number, number][];
}

export interface PlayerSlot {
  id: string;
  /** Its place on the grid and its livery, 0 to 9; the host's is 0. */
  slot: number;
}

export type Message =
  /** A player arriving, to the host. */
  | { kind: 'hello'; from: string; to?: string }
  /** The host's answer: the newcomer's slot. */
  | { kind: 'welcome'; from: string; to?: string; slot: number }
  /** From the host, now and then and whenever it changes: who is in the room. */
  | { kind: 'roster'; from: string; to?: string; players: PlayerSlot[] }
  /** The car in `slot`, `sentAt` on the host's clock in seconds; to the host, and from it to everyone. */
  | { kind: 'state'; from: string; to?: string; slot: number; sentAt: number; state: CarState }
  /** Setting the clocks: a player asks the host the time, `sentAt` on its own clock; the host answers on its. */
  | { kind: 'ping'; from: string; to?: string; sentAt: number }
  | { kind: 'pong'; from: string; to?: string; sentAt: number; hostTime: number }
  /** From the host: the lights come on at `lightsAt` and go out at `outAt`, on its clock in seconds. */
  | { kind: 'start'; from: string; to?: string; lightsAt: number; outAt: number }
  /** A player leaving. */
  | { kind: 'bye'; from: string; to?: string };
