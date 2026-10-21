import type { Message } from './protocol.js';

/**
 * How the players' browsers reach one another: one player's messages to another (`to`), or to
 * everyone (no `to`). The tabs of one browser on one machine for now; WebRTC between machines
 * would be another of these.
 */
export interface Transport {
  /** This player's own id, unique in the room. */
  readonly id: string;
  /** `message` to its `to`, or to everyone but `except`. */
  send(message: Message, except?: string): void;
  onMessage(handler: (message: Message) => void): void;
  close(): void;
}

/** The browser's tabs open on the same room: each hears what the others send, and keeps what's for it. */
export class TabTransport implements Transport {
  readonly id = crypto.randomUUID().slice(0, 8);
  private readonly channel: BroadcastChannel;
  private readonly handlers: ((message: Message) => void)[] = [];
  private closed = false;

  constructor(room: string) {
    this.channel = new BroadcastChannel(`eulerjs-formula-car-${room}`);
    this.channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message.to !== undefined && message.to !== this.id) return;
      for (const handler of this.handlers) handler(message);
    };
  }

  send(message: Message): void {
    // a message held on its way may arrive at the door after it shut
    if (!this.closed) this.channel.postMessage(message);
  }

  onMessage(handler: (message: Message) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.closed = true;
    this.channel.close();
  }
}

/** What a network does to a message on its way: delays it, by a ping's half and some jitter either way, and loses some. */
export interface NetworkConditions {
  /** The round trip, in milliseconds: each message is held half of it. */
  ping: number;
  /** How much more or less than that a message may be held, in milliseconds. */
  jitter: number;
  /** The share of messages lost, 0 to 1. Only those that can be: never the ones that set up the race. */
  loss: number;
}

/**
 * A transport as a network would be: each message held a while before it goes, a few never going.
 * Held as they leave, so a message the host passes on is held once on the way to it and again on
 * the way on, as it would be.
 */
export class LaggyTransport implements Transport {
  private readonly inner: Transport;
  private readonly conditions: NetworkConditions;

  constructor(inner: Transport, conditions: NetworkConditions) {
    this.inner = inner;
    this.conditions = conditions;
  }

  get id(): string {
    return this.inner.id;
  }

  send(message: Message, except?: string): void {
    const { ping, jitter, loss } = this.conditions;
    // only the cars' states may be lost: they come again a moment later; the rest would go again, reliably
    if (message.kind === 'state' && Math.random() < loss) return;
    const held = Math.max(ping / 2 + (Math.random() * 2 - 1) * jitter, 0);
    setTimeout(() => this.inner.send(message, except), held);
  }

  onMessage(handler: (message: Message) => void): void {
    this.inner.onMessage(handler);
  }

  close(): void {
    this.inner.close();
  }
}
