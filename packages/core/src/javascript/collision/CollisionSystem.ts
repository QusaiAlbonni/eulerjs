import { Box3, Matrix3, Quaternion, Vector3 } from 'three';
import type { Contact } from '../../backend.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import type { SolverBody } from '../SolverBody.js';
import { AabbTree } from './AabbTree.js';
import type { TreeLeaf } from './AabbTree.js';
import { boundsOverlap, sortAlong, sweepAxesAlong, widestAxisOf } from './broadphase.js';
import type { BroadphaseEntry, SweepAxes } from './broadphase.js';
import { ContactConstraint } from './ContactConstraint.js';
import { ContactPatch } from './ContactPatch.js';
import { registerCapsuleCollisionTests } from './capsule.js';
import { registerConvexCollisionTests } from './convex.js';
import { registerHeightfieldCollisionTests } from './heightfield.js';
import { registerRoundCollisionTests } from './round.js';
import { reduceManifold } from './manifoldReduction.js';
import { collide, ContactPointPool, usePointPool } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';
import { collidersOverlap } from './sweep.js';

interface PoseScratch {
  position: Vector3;
  quaternion: Quaternion;
  rotation: Matrix3;
}

const poseA: PoseScratch = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };
const boundsScratch = new Box3();
const wakeBounds = new Box3();
export interface PairSearchEntry extends BroadphaseEntry<SolverBody> {
  /** How far the body can move in the step, in metres; 0 for static and sleeping bodies. */
  travel: number;
  /** The parts of `travel` its moving along and its turning make: how far its centre of mass goes, and the furthest point of its colliders turns. */
  slideTravel: number;
  turnTravel: number;
  /** The last step it was seen with colliders on, to drop it once it is gone. */
  seenOnStep: number;
  /** Whether the body was fixed, static or asleep, when this step's search began. */
  fixed: boolean;
  /** While it is fixed: its leaf in the tree of fixed entries, or, unbounded (a plane), none. */
  leaf: TreeLeaf<PairSearchEntry> | undefined;
  /** Where the search's sort put it this step. */
  order: number;
}

/** Two colliders overlapping, at least one of them a sensor. */
export interface SensorOverlap {
  readonly bodyA: SolverBody;
  readonly bodyB: SolverBody;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
}

/**
 * The contact points between two colliders, found once per step. The collision system reuses it,
 * and its points, the next step: nothing may keep them beyond it.
 */
export interface Manifold {
  readonly bodyA: SolverBody;
  readonly bodyB: SolverBody;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
  readonly points: readonly ContactPoint[];
}

interface CandidatePair {
  bodyA: SolverBody;
  bodyB: SolverBody;
  /** How far apart colliders may be and still become contacts: how far the bodies can close in a step. */
  margin: number;
}

/** A manifold the collision system fills afresh each step. */
interface ReusedManifold extends Manifold {
  bodyA: SolverBody;
  bodyB: SolverBody;
  colliderA: Collider;
  colliderB: Collider;
  readonly points: ContactPoint[];
}

/**
 * Pairs of entries as numbers, the first's place in the sweep order times the count of entries
 * plus the second's: in sweep order as numbers are, and sorted as fast. A list of them grows as
 * it needs to and is reused from step to step.
 */
class PairKeys {
  keys = new Float64Array(64);
  count = 0;

  push(key: number): void {
    if (this.count === this.keys.length) {
      const grown = new Float64Array(2 * this.keys.length);
      grown.set(this.keys);
      this.keys = grown;
    }
    this.keys[this.count++] = key;
  }

  clear(): void {
    this.count = 0;
  }

  sort(): void {
    this.keys.subarray(0, this.count).sort();
  }
}

/** Stamps a step's collider poses, so each body's are worked out once a step (see `posesOf`); never the same twice, whichever world steps. */
let poseStamp = 0;

// An explicit call rather than an import for its side effects, which bundlers may drop.
registerConvexCollisionTests();
registerCapsuleCollisionTests();
registerRoundCollisionTests();
registerHeightfieldCollisionTests();

/** Extra distance, beyond what the bodies can travel in a step, within which nearby points become contacts. */
const CONTACT_SLOP = 0.01;

const STATIC_FRICTION_PASSES = 2;

/** Bodies this close, in metres, count as touching for sleeping together. */
const TOUCHING_GAP = 0.005;

/**
 * Once per step: finds which bodies may touch, from bounding boxes padded by how far each body
 * can move in the step, then the contacts between their colliders, including points that the
 * bodies may close the gap to during the step. Every substep then solves those contacts.
 */
export class CollisionSystem {
  /**
   * Every body with colliders, its swept bounds and how far it can travel in the step, kept from
   * step to step in the order the pair search last sorted them.
   */
  private entries: PairSearchEntry[] = [];
  /**
   * The fixed entries, static or asleep, in a tree, for the moving ones to find; those without
   * bounds, such as planes, apart. Fixed entries can't collide with each other, so the search
   * never sweeps them against each other, which with a great deal of still scenery is most of it.
   */
  private readonly fixedTree = new AabbTree<PairSearchEntry>();
  private readonly unboundedFixed = new Set<PairSearchEntry>();
  /**
   * The axes the last search swept along, and whether any entry's bounds, or which entries there
   * are, have changed since: unchanged, the entries are still in order, along the same axis.
   */
  private sweepAxes: SweepAxes | undefined;
  /** The entries' bounds for the sweep, six numbers each: see `findCandidatePairs`. */
  private sweepBounds = new Float64Array(0);
  private entriesChanged = true;
  /** Whether bodies have fallen asleep since the search last put the fixed ones in the tree: until it does, they are among the entries only. */
  private sleepersOutsideTree = false;
  private stepNumber = 0;
  /** The step's candidate pairs, the first `candidateCount` of them, the rest kept for later steps. */
  private readonly candidatePool: CandidatePair[] = [];
  private candidateCount = 0;
  /** The pairs the sweep finds, and those found in the tree of fixed entries, as `PairKeys`. */
  private readonly sweptPairs = new PairKeys();
  private readonly behindPairs = new PairKeys();
  /** The step's manifolds, and the objects and arrays they are made in, kept from step to step. */
  private readonly manifoldList: ReusedManifold[] = [];
  private readonly manifoldPool: ReusedManifold[] = [];
  private readonly pointPool = new ContactPointPool();
  /** The entry `collectBehind` and `collectWoken` look from, while they are queried with. */
  private queriedEntry: PairSearchEntry | undefined;
  /** What `forEachFixedOverlapping` is looking for, while it looks: made once, its tree query needs no new function each time. */
  private overlapEntry: PairSearchEntry | undefined;
  private overlapAxes: SweepAxes | undefined;
  private overlapVisit: ((fixed: PairSearchEntry) => void) | undefined;
  private activeContacts: ContactConstraint[] = [];
  private patches: ContactPatch[] = [];
  /** The patches static friction holds on the current substep, reused from substep to substep. */
  private readonly holdingPatches: ContactPatch[] = [];

  /**
   * The pairs of bodies that touched (or all but touched) when the last step began, at least one
   * of which the solver moves: what keeps a body resting on one that won't sleep awake. Pair `i`
   * is `touchingFirst[i]` and `touchingSecond[i]`.
   */
  readonly touchingFirst: SolverBody[] = [];
  readonly touchingSecond: SolverBody[] = [];

  /** The sensors that something overlapped during the last step, as found when the step began. */
  sensorOverlaps: SensorOverlap[] = [];

  /** Contacts that pushed during the last step. */
  get contacts(): Contact[] {
    return this.activeContacts.filter((contact) => contact.stepImpulse > 0).map((contact) => contact.report());
  }

  hasColliders(bodies: readonly SolverBody[]): boolean {
    return bodies.some((body) => body.colliders.length > 0);
  }

  /**
   * Finds the pairs of bodies that may touch during the step. A sleeping body that an awake one
   * is moving toward faster than `wakeSpeed` (m/s) is woken first, then `afterWaking` is called
   * so the bodies tied to it can be woken too, all before any pair is chosen: a body's contacts
   * are worked out for the step as either moving or not, and it must not change in between.
   */
  findCandidatePairs(bodies: readonly SolverBody[], timestep: number, wakeSpeed = 0, afterWaking: () => void = () => {}): void {
    this.updateEntries(bodies, timestep);
    this.fixedTree.rebuildIfWorthwhile();
    const entries = this.entries;
    // sorted as a sweep over every entry would sort them, for the pairs to come out in its order;
    // with nothing changed since the last search, they already are
    if (this.entriesChanged || !this.sweepAxes) {
      this.sweepAxes = sweepAxesAlong(widestAxisOf(entries));
      sortAlong(entries, this.sweepAxes.along);
      for (let index = 0; index < entries.length; index++) entries[index]!.order = index;
      this.entriesChanged = false;
    }
    const axes = this.sweepAxes;
    // Pairs in the order a sweep over every entry would find them: by their first entry in the
    // sort, then their second. A moving entry's sweep forward finds its pairs with the entries
    // after it, moving or fixed, already in that order; its pairs with fixed entries before it,
    // which the tree finds, are kept apart, and merged in.
    const swept = this.sweptPairs;
    const behind = this.behindPairs;
    swept.clear();
    behind.clear();
    const { along, first: across, second: up } = axes;
    // every entry's bounds, in sweep order, along then across then up, low then high: read in the
    // innermost loop from one flat array rather than by axis name from each entry's box
    const count = entries.length;
    if (this.sweepBounds.length < 6 * count) this.sweepBounds = new Float64Array(12 * count);
    const sweep = this.sweepBounds;
    for (let index = 0; index < count; index++) {
      const { min, max } = entries[index]!.bounds;
      const at = 6 * index;
      sweep[at] = min[along];
      sweep[at + 1] = max[along];
      sweep[at + 2] = min[across];
      sweep[at + 3] = max[across];
      sweep[at + 4] = min[up];
      sweep[at + 5] = max[up];
    }
    for (let first = 0; first < count; first++) {
      const entry = entries[first]!;
      if (entry.fixed) continue;
      const at = 6 * first;
      const maxAlong = sweep[at + 1]!;
      const minAcross = sweep[at + 2]!;
      const maxAcross = sweep[at + 3]!;
      const minUp = sweep[at + 4]!;
      const maxUp = sweep[at + 5]!;
      // the sweep's innermost loop, its tests written out
      for (let second = first + 1; second < count; second++) {
        const otherAt = 6 * second;
        if (sweep[otherAt]! > maxAlong) break;
        if (sweep[otherAt + 2]! > maxAcross || sweep[otherAt + 3]! < minAcross) continue;
        if (sweep[otherAt + 4]! > maxUp || sweep[otherAt + 5]! < minUp) continue;
        swept.push(first * count + second);
      }
      this.queriedEntry = entry;
      this.forEachFixedOverlapping(entry, axes, this.collectBehind);
    }
    // A sleeping body that something comes at fast is woken; one just woken has no speed to wake
    // another, so which wake doesn't depend on the order the pairs are looked at in.
    for (const pairs of [swept, behind]) {
      for (let index = 0; index < pairs.count; index++) {
        const key = pairs.keys[index]!;
        const one = entries[Math.floor(key / count)]!.item;
        const other = entries[key % count]!.item;
        wakeIfHitHard(one, other, wakeSpeed);
        wakeIfHitHard(other, one, wakeSpeed);
      }
    }
    afterWaking();
    // and what a woken body overlaps among the fixed ones matters now too: the ground under it
    for (const entry of entries) {
      if (!entry.fixed || entry.item.isSleeping || entry.item.type === 'static') continue;
      this.queriedEntry = entry;
      this.forEachFixedOverlapping(entry, axes, this.collectWoken);
    }
    this.queriedEntry = undefined;
    behind.sort();
    // the two lists merged, in sweep order
    this.candidateCount = 0;
    let fromSwept = 0;
    let fromBehind = 0;
    while (fromSwept < swept.count || fromBehind < behind.count) {
      const takeSwept = fromBehind === behind.count || (fromSwept < swept.count && swept.keys[fromSwept]! <= behind.keys[fromBehind]!);
      const key = takeSwept ? swept.keys[fromSwept++]! : behind.keys[fromBehind++]!;
      const entryA = entries[Math.floor(key / count)]!;
      const entryB = entries[key % count]!;
      const bodyA = entryA.item;
      const bodyB = entryB.item;
      if (!bodyA.isMovable && !bodyB.isMovable) continue;
      if (bodyA.ignoresCollisionsWith(bodyB)) continue;
      let candidate = this.candidatePool[this.candidateCount];
      if (!candidate) {
        candidate = { bodyA, bodyB, margin: 0 };
        this.candidatePool.push(candidate);
      }
      this.candidateCount++;
      candidate.bodyA = bodyA.isMovable ? bodyA : bodyB;
      candidate.bodyB = bodyA.isMovable ? bodyB : bodyA;
      candidate.margin = contactMargin(entryA, entryB, timestep);
    }
  }

  /** A fixed entry the queried entry overlaps, from before it in the sweep: a pair the sweep forward misses. */
  private readonly collectBehind = (fixed: PairSearchEntry): void => {
    const entry = this.queriedEntry!;
    if (fixed.order < entry.order) this.behindPairs.push(fixed.order * this.entries.length + entry.order);
  };

  /** A fixed entry a just woken one overlaps: a pair once, even when both have just woken. */
  private readonly collectWoken = (fixed: PairSearchEntry): void => {
    const entry = this.queriedEntry!;
    const bothWoken = !fixed.item.isSleeping && fixed.item.type !== 'static';
    const count = this.entries.length;
    if (!bothWoken || entry.order < fixed.order) this.behindPairs.push(entry.order < fixed.order ? entry.order * count + fixed.order : fixed.order * count + entry.order);
  };

  /**
   * The contact points between every pair of colliders of the candidate pairs, including points
   * up to the pair's margin apart. Body A of each is the one the solver can move, if only one can.
   */
  findManifolds(): readonly Manifold[] {
    const manifolds = this.manifoldList;
    manifolds.length = 0;
    this.sensorOverlaps = [];
    this.touchingFirst.length = 0;
    this.touchingSecond.length = 0;
    // last step's points and manifolds are done with: handed out again
    this.pointPool.reset();
    usePointPool(this.pointPool);
    const stamp = ++poseStamp;
    try {
      for (let pairIndex = 0; pairIndex < this.candidateCount; pairIndex++) {
        const { bodyA, bodyB, margin } = this.candidatePool[pairIndex]!;
        const collidersA = bodyA.colliders;
        const collidersB = bodyB.colliders;
        const posesA = posesOf(bodyA, stamp);
        const posesB = posesOf(bodyB, stamp);
        for (let indexA = 0; indexA < collidersA.length; indexA++) {
          const colliderA = collidersA[indexA]!;
          const poseOfA = posesA[indexA]!;
          for (let indexB = 0; indexB < collidersB.length; indexB++) {
            const colliderB = collidersB[indexB]!;
            if (!colliderA.canCollideWith(colliderB)) continue;
            const poseOfB = posesB[indexB]!;
            if (colliderA.sensor || colliderB.sensor) {
              // a sensor only notices what overlaps it
              if (collidersOverlap(colliderA, poseOfA, colliderB, poseOfB)) this.sensorOverlaps.push({ bodyA, bodyB, colliderA, colliderB });
              continue;
            }
            // the next manifold's object, filled only if the pair has contacts
            let manifold = this.manifoldPool[manifolds.length];
            if (!manifold) {
              manifold = { bodyA, bodyB, colliderA, colliderB, points: [] };
              this.manifoldPool.push(manifold);
            }
            const points = manifold.points;
            points.length = 0;
            collide(colliderA, poseOfA, colliderB, poseOfB, points, margin);
            reduceManifold(points);
            if (points.length === 0) continue;
            manifold.bodyA = bodyA;
            manifold.bodyB = bodyB;
            manifold.colliderA = colliderA;
            manifold.colliderB = colliderB;
            manifolds.push(manifold);
            if (bodyB.type !== 'static' && points.some((point) => point.depth > -TOUCHING_GAP)) {
              this.touchingFirst.push(bodyA);
              this.touchingSecond.push(bodyB);
            }
          }
        }
      }
    } finally {
      usePointPool(undefined);
    }
    return manifolds;
  }

  /** Makes the position-based solver's contacts for the step from the manifolds. */
  detectContacts(): void {
    this.activeContacts = [];
    this.patches = [];
    for (const { bodyA, bodyB, colliderA, colliderB, points } of this.findManifolds()) {
      const patch = points.map((contactPoint) => new ContactConstraint(bodyA, bodyB, colliderA, colliderB, contactPoint));
      this.activeContacts.push(...patch);
      this.patches.push(new ContactPatch(bodyA, bodyB, patch));
    }
  }

  /**
   * Every contact's normal first, then friction, in both passes: friction applied before another
   * contact's normal correction would be undone by it. Static friction runs twice, since putting
   * one point of a patch back moves the others a little. Each patch decides whether it holds
   * after the ones before it have had their go, so it is only asked to stop what they left.
   */
  solvePositions(substep: number): void {
    for (const contact of this.activeContacts) contact.beginSubstep();
    for (const contact of this.activeContacts) contact.separate(substep);
    this.holdingPatches.length = 0;
    for (const patch of this.patches) {
      if (!patch.canHold()) continue;
      patch.removeSlide(substep);
      this.holdingPatches.push(patch);
    }
    for (const contact of this.activeContacts) contact.holdRolling();
    // a second pass, since turning bodies back from rolling moves their touching points again
    for (let pass = 1; pass < STATIC_FRICTION_PASSES; pass++) {
      for (const patch of this.holdingPatches) patch.removeSlide(substep);
    }
  }

  solveVelocities(substep: number, gravityStrength: number): void {
    for (const contact of this.activeContacts) contact.settleNormalSpeed(substep, gravityStrength);
    for (const contact of this.activeContacts) contact.resistSliding();
    for (const contact of this.activeContacts) contact.resistRolling();
    for (const contact of this.activeContacts) contact.accumulateImpulse();
  }

  /**
   * Brings the entries up to date with the bodies: adds new ones, drops ones that are gone or have
   * no colliders left, and works out each body's travel and swept bounds. A static or sleeping
   * body keeps the bounds it had until something moves it.
   */
  private updateEntries(bodies: readonly SolverBody[], timestep: number): void {
    const stepNumber = ++this.stepNumber;
    this.sleepersOutsideTree = false;
    let anyGone = false;
    for (const body of bodies) {
      if (body.colliders.length === 0) continue;
      let entry = body.pairSearchEntry;
      if (!entry) {
        entry = { item: body, bounds: new Box3(), travel: 0, slideTravel: 0, turnTravel: 0, seenOnStep: 0, fixed: false, leaf: undefined, order: 0 };
        body.pairSearchEntry = entry;
        this.entries.push(entry);
        this.entriesChanged = true;
      }
      entry.seenOnStep = stepNumber;
      const fixed = body.type === 'static' || body.isSleeping;
      const placed = entry.leaf !== undefined || this.unboundedFixed.has(entry);
      entry.fixed = fixed;
      if (fixed && !body.boundsStale) {
        if (!placed) this.placeFixed(entry);
        continue;
      }
      measureTravel(entry, timestep);
      this.sweptBounds(body, entry.travel, entry.bounds);
      body.boundsStale = !fixed;
      this.entriesChanged = true;
      // its bounds have changed: out of the tree, and back in if it is still fixed
      if (placed) this.removeFixed(entry);
      if (fixed) this.placeFixed(entry);
    }
    for (const entry of this.entries) if (entry.seenOnStep !== stepNumber) anyGone = true;
    if (!anyGone) return;
    for (const entry of this.entries) {
      if (entry.seenOnStep === stepNumber) continue;
      this.removeFixed(entry);
      if (entry.item.pairSearchEntry === entry) entry.item.pairSearchEntry = undefined;
    }
    this.entries = this.entries.filter((entry) => entry.seenOnStep === stepNumber);
    this.entriesChanged = true;
  }

  /** Notes that bodies have been put to sleep, which the tree has yet to take in (see `wakeAround`). */
  bodiesFellAsleep(): void {
    this.sleepersOutsideTree = true;
  }

  /**
   * Wakes the sleeping bodies whose bounds overlap `body`'s, where the search last saw it and
   * where it is now: when it is taken away, moved by hand, or given other colliders or mass, what
   * rests on it, hangs on it or has it moved into it can't stay asleep, held up by nothing.
   */
  wakeAround(body: SolverBody): void {
    const entry = body.pairSearchEntry;
    if (entry) this.wakeSleepersIn(entry.bounds, body);
    if (body.colliders.length > 0) this.wakeSleepersIn(this.sweptBounds(body, 0, wakeBounds), body);
  }

  private wakeSleepersIn(bounds: Box3, body: SolverBody): void {
    if (bounds.isEmpty()) return;
    const wake = (other: PairSearchEntry) => {
      if (other.item !== body && other.item.isSleeping && other.bounds.intersectsBox(bounds)) other.item.wakeUp();
    };
    this.fixedTree.query(bounds, wake);
    for (const unbounded of this.unboundedFixed) wake(unbounded);
    // the ones fallen asleep since the tree last took them in
    if (this.sleepersOutsideTree) for (const other of this.entries) if (!other.leaf && !this.unboundedFixed.has(other)) wake(other);
  }

  /** Calls `visit` with every fixed entry, but `entry` itself, whose bounds overlap `entry`'s. */
  private forEachFixedOverlapping(entry: PairSearchEntry, axes: SweepAxes, visit: (fixed: PairSearchEntry) => void): void {
    this.overlapEntry = entry;
    this.overlapAxes = axes;
    this.overlapVisit = visit;
    this.fixedTree.query(entry.bounds, this.visitIfOverlapping);
    for (const fixed of this.unboundedFixed) this.visitIfOverlapping(fixed);
    this.overlapEntry = this.overlapAxes = this.overlapVisit = undefined;
  }

  private readonly visitIfOverlapping = (fixed: PairSearchEntry): void => {
    const entry = this.overlapEntry!;
    if (fixed !== entry && boundsOverlap(entry.bounds, fixed.bounds, this.overlapAxes!)) this.overlapVisit!(fixed);
  };

  private placeFixed(entry: PairSearchEntry): void {
    const bounds = entry.bounds;
    if (Number.isFinite(bounds.min.x + bounds.min.y + bounds.min.z + bounds.max.x + bounds.max.y + bounds.max.z)) entry.leaf = this.fixedTree.insert(entry, bounds, 0);
    else this.unboundedFixed.add(entry);
  }

  private removeFixed(entry: PairSearchEntry): void {
    if (entry.leaf) this.fixedTree.remove(entry.leaf);
    entry.leaf = undefined;
    this.unboundedFixed.delete(entry);
  }

  private sweptBounds(body: SolverBody, travel: number, bounds: Box3): Box3 {
    bounds.makeEmpty();
    for (const collider of body.colliders) {
      collider.poseIn(body, poseA);
      bounds.union(collider.bounds(poseA, boundsScratch));
    }
    return bounds.expandByScalar(travel + CONTACT_SLOP);
  }
}

/** Pairs by their first entry's place in the sweep, then their second's. */
/** How far any point of the entry's body's colliders can move in a step at its current speed and spin, and how much of that is sliding and turning. */
function measureTravel(entry: PairSearchEntry, timestep: number): void {
  const body = entry.item;
  entry.travel = entry.slideTravel = entry.turnTravel = 0;
  if (body.type === 'static') return;
  let largestRadius = 0;
  for (const collider of body.colliders) largestRadius = Math.max(largestRadius, collider.boundingRadius + collider.offset.length());
  const slideTravel = body.velocity.length() * timestep;
  const turnTravel = body.angularVelocity.length() * largestRadius * timestep;
  if (!Number.isFinite(slideTravel + turnTravel)) return;
  entry.travel = slideTravel + turnTravel;
  entry.slideTravel = slideTravel;
  entry.turnTravel = turnTravel;
}

/**
 * How far apart two entries' colliders may be and still become contacts: as far as they can close
 * on each other in the step. Against a still body that is how far the moving one can go. Between
 * two moving bodies it is how fast they move toward each other, but no less than either one
 * moves, in case the other is stopped dead on the way, as the front one of two flying together
 * is by a wall: as the boxes of a pile flung apart mostly are, that is far less than the two
 * travels together.
 */
function contactMargin(entryA: PairSearchEntry, entryB: PairSearchEntry, timestep: number): number {
  const apart = entryA.travel + entryB.travel + CONTACT_SLOP;
  if (entryA.fixed || entryB.fixed) return apart;
  const closingSpeed = entryA.item.velocity.distanceTo(entryB.item.velocity);
  const closing = Math.max(closingSpeed * timestep, entryA.slideTravel, entryB.slideTravel) + entryA.turnTravel + entryB.turnTravel + CONTACT_SLOP;
  return closing < apart ? closing : apart;
}

/**
 * The poses of a body's colliders, in its colliders' order, worked out once a step, the first time
 * it is in a pair: a body touching eight others would otherwise work them out eight times over.
 */
function posesOf(body: SolverBody, stamp: number): readonly ColliderPose[] {
  const poses = body.colliderPoses;
  if (body.posesStamp === stamp) return poses;
  const colliders = body.colliders;
  while (poses.length < colliders.length) poses.push({ position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3(), owner: undefined });
  for (let index = 0; index < colliders.length; index++) colliders[index]!.poseIn(body, poses[index]!);
  body.posesStamp = stamp;
  return poses;
}

/** Wakes `sleeper` if `other` is awake and moving faster than `wakeSpeed`. */
function wakeIfHitHard(sleeper: SolverBody, other: SolverBody, wakeSpeed: number): void {
  // a body trembling where it is, however lively its velocity, isn't coming at anything
  if (!sleeper.isSleeping || other.type === 'static' || other.isSleeping || other.isStill) return;
  if (other.velocity.lengthSq() > wakeSpeed * wakeSpeed || other.angularVelocity.lengthSq() > wakeSpeed * wakeSpeed) sleeper.wakeUp();
}
