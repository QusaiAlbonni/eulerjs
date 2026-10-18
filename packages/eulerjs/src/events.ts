import type { Contact, SensorOverlap } from './backend.js';
import type { Body } from './Body.js';
import type { Collider } from './colliders/Collider.js';
import type { Joint } from './joints/Joint.js';

/** Two colliders that started or stopped touching. */
export interface ContactEvent {
  readonly bodyA: Body;
  readonly bodyB: Body;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
  /** For `contactBegin`, the points where they touch on the step they began to; empty for `contactEnd`. */
  readonly contacts: readonly Contact[];
}

/** Something that came into, or left, a sensor. */
export interface SensorEvent {
  readonly sensor: Collider;
  readonly sensorBody: Body;
  /** The collider that came in or left, on `body`. */
  readonly collider: Collider;
  readonly body: Body;
}

/** A joint that broke, having carried more than its `breakForce` or `breakTorque`; the world has removed it. */
export interface JointBreakEvent {
  readonly joint: Joint;
  /** The force and torque it carried on the step it broke, in N and N·m. */
  readonly force: number;
  readonly torque: number;
}

/** The events a world sends, after each step, by name. */
export interface WorldEvents {
  /** Two colliders began to push on each other. */
  contactBegin: ContactEvent;
  /** Two colliders stopped touching, or one of their bodies was removed. Touching bodies that fall asleep together still count as touching. */
  contactEnd: ContactEvent;
  /** Something began to overlap a sensor. */
  sensorEnter: SensorEvent;
  /** Something stopped overlapping a sensor, or was removed. A body asleep inside one is still in it. */
  sensorExit: SensorEvent;
  jointBreak: JointBreakEvent;
}

export type WorldEventName = keyof WorldEvents;
export type WorldEventListener<Name extends WorldEventName> = (event: WorldEvents[Name]) => void;

/** A pair of colliders being watched, in a set order so that each pair has one key. */
interface WatchedPair {
  readonly bodyA: Body;
  readonly bodyB: Body;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
}

const colliderIds = new WeakMap<Collider, number>();
let nextColliderId = 0;

function idOf(collider: Collider): number {
  let id = colliderIds.get(collider);
  if (id === undefined) colliderIds.set(collider, (id = nextColliderId++));
  return id;
}

/** The pair in a set order, and its key. */
function ordered(pair: WatchedPair): { key: string; pair: WatchedPair } {
  const idA = idOf(pair.colliderA);
  const idB = idOf(pair.colliderB);
  if (idA <= idB) return { key: `${idA}:${idB}`, pair };
  return { key: `${idB}:${idA}`, pair: { bodyA: pair.bodyB, bodyB: pair.bodyA, colliderA: pair.colliderB, colliderB: pair.colliderA } };
}

/** Whether the simulation moves the body: an awake body that isn't static. */
function isMoving(body: Body): boolean {
  return body.type !== 'static' && !body.isSleeping;
}

/** Whether the pair's colliders are still on their bodies, in a world. */
function stillThere(pair: WatchedPair): boolean {
  return pair.bodyA.world !== undefined && pair.bodyB.world !== undefined && pair.bodyA.colliders.includes(pair.colliderA) && pair.bodyB.colliders.includes(pair.colliderB);
}

/** A watched pair, and where its bodies were when it was last seen. */
interface Sighting {
  readonly pair: WatchedPair;
  readonly poses: readonly number[];
}

/** The two bodies' positions and quaternions, as numbers to compare. */
function posesOf(pair: WatchedPair): number[] {
  return [...pair.bodyA.position.toArray(), ...pair.bodyA.quaternion.toArray(), ...pair.bodyB.position.toArray(), ...pair.bodyB.quaternion.toArray()];
}

/**
 * Which pairs of colliders are touching, or overlapping a sensor, from one step to the next. A
 * pair missing from a step is kept while neither body moves, by the simulation or by hand: bodies
 * asleep together aren't tested against each other, but haven't parted either.
 */
export class PairWatcher {
  private watched = new Map<string, Sighting>();

  /** Compares this step's pairs with the last's: calls `began` for the new ones and `ended` for those gone. */
  update(current: Iterable<WatchedPair>, began: (pair: WatchedPair, key: string) => void, ended: (pair: WatchedPair) => void): void {
    const now = new Map<string, Sighting>();
    for (const found of current) {
      const { key, pair } = ordered(found);
      if (now.has(key)) continue;
      now.set(key, { pair, poses: posesOf(pair) });
      if (!this.watched.has(key)) began(pair, key);
    }
    for (const [key, sighting] of this.watched) {
      if (now.has(key)) continue;
      const { pair } = sighting;
      const resting = stillThere(pair) && !isMoving(pair.bodyA) && !isMoving(pair.bodyB) && posesOf(pair).every((value, index) => value === sighting.poses[index]);
      if (resting) now.set(key, sighting);
      else ended(pair);
    }
    this.watched = now;
  }

  /** The pairs being watched that have `collider` in them. */
  pairsWith(collider: Collider): WatchedPair[] {
    const pairs: WatchedPair[] = [];
    for (const { pair } of this.watched.values()) if (pair.colliderA === collider || pair.colliderB === collider) pairs.push(pair);
    return pairs;
  }

  /** Ends every pair with a body that is being removed. */
  removeBody(body: Body, ended: (pair: WatchedPair) => void): void {
    for (const [key, { pair }] of this.watched) {
      if (pair.bodyA !== body && pair.bodyB !== body) continue;
      this.watched.delete(key);
      ended(pair);
    }
  }

  clear(): void {
    this.watched.clear();
  }
}

/** Sends a world's events to its listeners. */
export class EventHub {
  private readonly listeners = new Map<WorldEventName, Set<(event: never) => void>>();
  private readonly contactPairs = new PairWatcher();
  private readonly sensorPairs = new PairWatcher();

  on<Name extends WorldEventName>(name: Name, listener: WorldEventListener<Name>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener as (event: never) => void);
    return () => this.off(name, listener);
  }

  off<Name extends WorldEventName>(name: Name, listener: WorldEventListener<Name>): void {
    this.listeners.get(name)?.delete(listener as (event: never) => void);
  }

  emit<Name extends WorldEventName>(name: Name, event: WorldEvents[Name]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const listener of [...set]) (listener as WorldEventListener<Name>)(event);
  }

  wants(...names: WorldEventName[]): boolean {
    return names.some((name) => (this.listeners.get(name)?.size ?? 0) > 0);
  }

  /** After a step: compares the contacts and sensor overlaps with the last step's and sends the differences. */
  afterStep(contacts: () => readonly Contact[], overlaps: () => readonly SensorOverlap[]): void {
    if (this.wants('contactBegin', 'contactEnd')) {
      const touching = contacts();
      const byPair = new Map<string, Contact[]>();
      for (const contact of touching) {
        const { key } = ordered(contact);
        const list = byPair.get(key);
        if (list) list.push(contact);
        else byPair.set(key, [contact]);
      }
      this.contactPairs.update(
        touching,
        (pair, key) => this.emit('contactBegin', { ...pair, contacts: byPair.get(key) ?? [] }),
        (pair) => this.emit('contactEnd', { ...pair, contacts: [] }),
      );
    } else {
      this.contactPairs.clear();
    }
    // sensors are watched whether or not anyone listens, so that `inSensor` can say what is in one
    this.sensorPairs.update(
      overlaps(),
      (pair) => this.sendSensor('sensorEnter', pair),
      (pair) => this.sendSensor('sensorExit', pair),
    );
  }

  /** Everything overlapping `sensor` as of the last step, including bodies asleep in it. */
  inSensor(sensor: Collider): { body: Body; collider: Collider }[] {
    return this.sensorPairs.pairsWith(sensor).map((pair) => (pair.colliderA === sensor ? { body: pair.bodyB, collider: pair.colliderB } : { body: pair.bodyA, collider: pair.colliderA }));
  }

  /** Ends the pairs of a body that is being removed. */
  removeBody(body: Body): void {
    this.contactPairs.removeBody(body, (pair) => this.emit('contactEnd', { ...pair, contacts: [] }));
    this.sensorPairs.removeBody(body, (pair) => this.sendSensor('sensorExit', pair));
  }

  /** One event for each sensor of the pair, as seen from it. */
  private sendSensor(name: 'sensorEnter' | 'sensorExit', pair: WatchedPair): void {
    if (pair.colliderA.sensor) this.emit(name, { sensor: pair.colliderA, sensorBody: pair.bodyA, collider: pair.colliderB, body: pair.bodyB });
    if (pair.colliderB.sensor) this.emit(name, { sensor: pair.colliderB, sensorBody: pair.bodyB, collider: pair.colliderA, body: pair.bodyA });
  }
}
