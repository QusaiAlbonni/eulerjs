import { Box3, Matrix3, Quaternion, Vector3 } from 'three';
import type { Contact } from '../../backend.js';
import type { Collider } from '../../colliders/Collider.js';
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
import { collide } from './narrowphase.js';
import type { ContactPoint } from './narrowphase.js';
import { collidersOverlap } from './sweep.js';

interface PoseScratch {
  position: Vector3;
  quaternion: Quaternion;
  rotation: Matrix3;
}

const poseA: PoseScratch = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };
const poseB: PoseScratch = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };
const boundsScratch = new Box3();
export interface PairSearchEntry extends BroadphaseEntry<SolverBody> {
  /** How far the body can move in the step, in metres; 0 for static and sleeping bodies. */
  travel: number;
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

/** The contact points between two colliders, found once per step. */
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
  private candidatePairs: CandidatePair[] = [];
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
  private entriesChanged = true;
  private stepNumber = 0;
  private activeContacts: ContactConstraint[] = [];
  private patches: ContactPatch[] = [];
  /** The patches static friction holds on the current substep, reused from substep to substep. */
  private readonly holdingPatches: ContactPatch[] = [];

  /**
   * The pairs of bodies that touched (or all but touched) when the last step began, at least one
   * of which the solver moves: what keeps a body resting on one that won't sleep awake.
   */
  touchingPairs: [SolverBody, SolverBody][] = [];

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
    const swept: [PairSearchEntry, PairSearchEntry][] = [];
    const behind: [PairSearchEntry, PairSearchEntry][] = [];
    const { along, first: across, second: up } = axes;
    for (let first = 0; first < entries.length; first++) {
      const entry = entries[first]!;
      if (entry.fixed) continue;
      const bounds = entry.bounds;
      // the sweep's innermost loop, its tests written out
      for (let second = first + 1; second < entries.length; second++) {
        const other = entries[second]!;
        const otherBounds = other.bounds;
        if (otherBounds.min[along] > bounds.max[along]) break;
        if (otherBounds.min[across] > bounds.max[across] || otherBounds.max[across] < bounds.min[across]) continue;
        if (otherBounds.min[up] > bounds.max[up] || otherBounds.max[up] < bounds.min[up]) continue;
        swept.push([entry, other]);
      }
      this.forEachFixedOverlapping(entry, axes, (fixed) => {
        if (fixed.order < entry.order) behind.push([fixed, entry]);
      });
    }
    // A sleeping body that something comes at fast is woken; one just woken has no speed to wake
    // another, so which wake doesn't depend on the order the pairs are looked at in.
    for (const pairs of [swept, behind]) {
      for (const [one, other] of pairs) {
        wakeIfHitHard(one.item, other.item, wakeSpeed);
        wakeIfHitHard(other.item, one.item, wakeSpeed);
      }
    }
    afterWaking();
    // and what a woken body overlaps among the fixed ones matters now too: the ground under it
    for (const entry of entries) {
      if (!entry.fixed || entry.item.isSleeping || entry.item.type === 'static') continue;
      this.forEachFixedOverlapping(entry, axes, (fixed) => {
        const bothWoken = !fixed.item.isSleeping && fixed.item.type !== 'static';
        if (!bothWoken || entry.order < fixed.order) behind.push(entry.order < fixed.order ? [entry, fixed] : [fixed, entry]);
      });
    }
    const found = mergeInSweepOrder(swept, behind.sort(bySweepOrder));
    this.candidatePairs = [];
    for (const [entryA, entryB] of found) {
      const bodyA = entryA.item;
      const bodyB = entryB.item;
      if (!bodyA.isMovable && !bodyB.isMovable) continue;
      if (bodyA.ignoresCollisionsWith(bodyB)) continue;
      const margin = entryA.travel + entryB.travel + CONTACT_SLOP;
      this.candidatePairs.push(bodyA.isMovable ? { bodyA, bodyB, margin } : { bodyA: bodyB, bodyB: bodyA, margin });
    }
  }

  /**
   * The contact points between every pair of colliders of the candidate pairs, including points
   * up to the pair's margin apart. Body A of each is the one the solver can move, if only one can.
   */
  findManifolds(): Manifold[] {
    const manifolds: Manifold[] = [];
    this.sensorOverlaps = [];
    this.touchingPairs = [];
    for (const { bodyA, bodyB, margin } of this.candidatePairs) {
      for (const colliderA of bodyA.colliders) {
        colliderA.poseIn(bodyA, poseA);
        for (const colliderB of bodyB.colliders) {
          if (!colliderA.canCollideWith(colliderB)) continue;
          colliderB.poseIn(bodyB, poseB);
          if (colliderA.sensor || colliderB.sensor) {
            // a sensor only notices what overlaps it
            if (collidersOverlap(colliderA, poseA, colliderB, poseB)) this.sensorOverlaps.push({ bodyA, bodyB, colliderA, colliderB });
            continue;
          }
          const points: ContactPoint[] = [];
          collide(colliderA, poseA, colliderB, poseB, points, margin);
          reduceManifold(points);
          if (points.length === 0) continue;
          manifolds.push({ bodyA, bodyB, colliderA, colliderB, points });
          if (bodyB.type !== 'static' && points.some((point) => point.depth > -TOUCHING_GAP)) this.touchingPairs.push([bodyA, bodyB]);
        }
      }
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

  /** How far any point of the body's colliders can move in a step, at its current speed and spin. */
  private travelInStep(body: SolverBody, timestep: number): number {
    if (body.type === 'static') return 0;
    let largestRadius = 0;
    for (const collider of body.colliders) largestRadius = Math.max(largestRadius, collider.boundingRadius + collider.offset.length());
    const travel = (body.velocity.length() + body.angularVelocity.length() * largestRadius) * timestep;
    return Number.isFinite(travel) ? travel : 0;
  }

  /**
   * Brings the entries up to date with the bodies: adds new ones, drops ones that are gone or have
   * no colliders left, and works out each body's travel and swept bounds. A static or sleeping
   * body keeps the bounds it had until something moves it.
   */
  private updateEntries(bodies: readonly SolverBody[], timestep: number): void {
    const stepNumber = ++this.stepNumber;
    let anyGone = false;
    for (const body of bodies) {
      if (body.colliders.length === 0) continue;
      let entry = body.pairSearchEntry;
      if (!entry) {
        entry = { item: body, bounds: new Box3(), travel: 0, seenOnStep: 0, fixed: false, leaf: undefined, order: 0 };
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
      entry.travel = this.travelInStep(body, timestep);
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

  /** Calls `visit` with every fixed entry, but `entry` itself, whose bounds overlap `entry`'s. */
  private forEachFixedOverlapping(entry: PairSearchEntry, axes: SweepAxes, visit: (fixed: PairSearchEntry) => void): void {
    this.fixedTree.query(entry.bounds, (fixed) => {
      if (fixed !== entry && boundsOverlap(entry.bounds, fixed.bounds, axes)) visit(fixed);
    });
    for (const fixed of this.unboundedFixed) if (fixed !== entry && boundsOverlap(entry.bounds, fixed.bounds, axes)) visit(fixed);
  }

  private placeFixed(entry: PairSearchEntry): void {
    const bounds = entry.bounds;
    if (Number.isFinite(bounds.min.x + bounds.min.y + bounds.min.z + bounds.max.x + bounds.max.y + bounds.max.z)) entry.leaf = this.fixedTree.insert(entry, bounds);
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
function bySweepOrder(one: [PairSearchEntry, PairSearchEntry], other: [PairSearchEntry, PairSearchEntry]): number {
  return one[0].order - other[0].order || one[1].order - other[1].order;
}

/** Two lists of pairs, each in sweep order, as one. */
function mergeInSweepOrder(first: [PairSearchEntry, PairSearchEntry][], second: [PairSearchEntry, PairSearchEntry][]): [PairSearchEntry, PairSearchEntry][] {
  if (second.length === 0) return first;
  if (first.length === 0) return second;
  const merged: [PairSearchEntry, PairSearchEntry][] = [];
  let fromFirst = 0;
  let fromSecond = 0;
  while (fromFirst < first.length && fromSecond < second.length) {
    merged.push(bySweepOrder(first[fromFirst]!, second[fromSecond]!) <= 0 ? first[fromFirst++]! : second[fromSecond++]!);
  }
  while (fromFirst < first.length) merged.push(first[fromFirst++]!);
  while (fromSecond < second.length) merged.push(second[fromSecond++]!);
  return merged;
}

/** Wakes `sleeper` if `other` is awake and moving faster than `wakeSpeed`. */
function wakeIfHitHard(sleeper: SolverBody, other: SolverBody, wakeSpeed: number): void {
  // a body trembling where it is, however lively its velocity, isn't coming at anything
  if (!sleeper.isSleeping || other.type === 'static' || other.isSleeping || other.isStill) return;
  if (other.velocity.lengthSq() > wakeSpeed * wakeSpeed || other.angularVelocity.lengthSq() > wakeSpeed * wakeSpeed) sleeper.wakeUp();
}
