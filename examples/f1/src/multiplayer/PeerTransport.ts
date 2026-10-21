import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import type { Message } from './protocol.js';
import { decodeState, encodeState } from './stateCodec.js';
import type { Transport } from './transport.js';

// The players' browsers, each on its own machine, over WebRTC: the host's browser takes the
// room's code as its name with PeerJS's public server, which only introduces the players to one
// another, and every other player connects to it, straight to it where the network allows and
// through PeerJS's relay where it doesn't. Two channels to each: one that delivers everything,
// in order, for the room's goings-on; and one that sends the cars' states and never sends one
// again, since by the time it would arrive the next is on its way.

/** What the room's code is known by on PeerJS's server: shared with every other site's peers, so made our own. */
const PREFIX = 'eulerjs-formula-car-';
/** The states' channel, set up the same on both ends rather than offered by one of them. */
const STATES_CHANNEL = { negotiated: true, id: 7, ordered: false, maxRetransmits: 0 } as const;
/** How long joining waits for the host before giving up, in milliseconds. */
const JOIN_TIMEOUT = 15_000;
/** The letters a room's code is made of: none that look like another, in any light. */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A new room's code: five letters, about 28 million of them. */
export function roomCode(): string {
  const random = crypto.getRandomValues(new Uint32Array(5));
  return [...random].map((value) => CODE_LETTERS[value % CODE_LETTERS.length]).join('');
}

/** A code as someone typed it: upper case, without the spaces and dashes they put in. */
export function cleanCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Why a room couldn't be made or joined, in words for the player. */
export class RoomError extends Error {}

interface Link {
  control: DataConnection;
  states: RTCDataChannel | undefined;
}

export class PeerTransport implements Transport {
  private readonly peer: Peer;
  private readonly links = new Map<string, Link>();
  private readonly handlers: ((message: Message) => void)[] = [];

  private constructor(peer: Peer) {
    this.peer = peer;
  }

  /** Makes the room `code`, this player its host, once PeerJS's server has given the name. */
  static host(code: string): Promise<PeerTransport> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PREFIX + code);
      const transport = new PeerTransport(peer);
      peer.on('open', () => resolve(transport));
      peer.on('connection', (connection) => connection.on('open', () => transport.link(connection)));
      peer.on('error', (error) => {
        if (error.type === 'unavailable-id') reject(new RoomError(`There is a room ${code} already.`));
        else reject(new RoomError(`Couldn't make the room: ${error.message}`));
      });
    });
  }

  /** Joins the room `code`, once its host's browser has answered. */
  static join(code: string): Promise<PeerTransport> {
    return new Promise((resolve, reject) => {
      const peer = new Peer();
      const transport = new PeerTransport(peer);
      const giveUp = setTimeout(() => {
        peer.destroy();
        reject(new RoomError(`Room ${code} didn't answer.`));
      }, JOIN_TIMEOUT);
      peer.on('open', () => {
        const connection = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        connection.on('open', () => {
          clearTimeout(giveUp);
          transport.link(connection);
          resolve(transport);
        });
      });
      peer.on('error', (error) => {
        clearTimeout(giveUp);
        peer.destroy();
        if (error.type === 'peer-unavailable') reject(new RoomError(`There is no room ${code}.`));
        else reject(new RoomError(`Couldn't join: ${error.message}`));
      });
    });
  }

  get id(): string {
    return this.peer.id;
  }

  send(message: Message, except?: string): void {
    const targets = message.to !== undefined ? [this.links.get(message.to)] : [...this.links].filter(([id]) => id !== except).map(([, link]) => link);
    if (message.kind === 'state') {
      const bytes = encodeState(message.slot, message.sentAt, message.state);
      for (const link of targets) if (link?.states?.readyState === 'open') link.states.send(bytes);
      return;
    }
    for (const link of targets) if (link?.control.open) void link.control.send(message);
  }

  onMessage(handler: (message: Message) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.peer.destroy();
  }

  /** A player connected: their two channels, everything they send said to be from them, whatever it says. */
  private link(connection: DataConnection): void {
    const from = connection.peer;
    const link: Link = { control: connection, states: undefined };
    this.links.set(from, link);
    connection.on('data', (data) => {
      const message = data as Message;
      if (typeof message !== 'object' || message === null || typeof message.kind !== 'string' || message.kind === 'state') return;
      this.deliver({ ...message, from });
    });
    connection.on('close', () => {
      this.links.delete(from);
      this.deliver({ kind: 'bye', from });
    });
    const states = connection.peerConnection.createDataChannel('states', STATES_CHANNEL);
    states.binaryType = 'arraybuffer';
    states.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const decoded = decodeState(event.data);
      if (decoded) this.deliver({ kind: 'state', from, ...decoded });
    };
    link.states = states;
  }

  private deliver(message: Message): void {
    for (const handler of this.handlers) handler(message);
  }
}
