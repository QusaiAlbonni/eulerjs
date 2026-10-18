import { Matrix3, Quaternion, Vector3 } from 'three';
import type { Contact } from '../../backend.js';
import type { Collider } from '../../colliders/Collider.js';
import type { Manifold } from '../collision/CollisionSystem.js';
import { rollingRadius, roundingAt } from '../collision/round.js';
import type { SolverBody } from '../SolverBody.js';
import type { BodyTable } from './BodyTable.js';
import type { Softness } from './softness.js';

/**
 * The contact points of a step for the soft-step solver, one row per point in flat arrays. Each
 * point is found once per step; its anchors, offsets from the two bodies' centres of mass, stay
 * fixed in the bodies for the step, and every substep measures how far apart they have come.
 * Impulses carry over from the matching point of the step before, which is what lets a stack of
 * boxes rest still: each substep starts from the impulses that held it up last time.
 */

/** Fastest the solver pushes overlapping bodies apart, in m/s, so a deep overlap doesn't fling them. */
const MAX_PUSH_OUT_SPEED = 3;
/** Slower impacts than this, in m/s, don't bounce: below it a resting contact would never settle. */
const RESTITUTION_THRESHOLD = 1;
/** A new point takes over an old one's impulses if it is within this, in metres, of where the old one was on body A. */
const WARM_START_MATCH = 0.03;

/** Where one manifold's points are in the kept arrays: rows `start` to `end`, the end not included. */
interface KeptRun {
  readonly bodyA: SolverBody;
  readonly bodyB: SolverBody;
  readonly colliderA: Collider;
  readonly colliderB: Collider;
  readonly start: number;
  end: number;
}

const velocityA = new Float64Array(3);
const velocityB = new Float64Array(3);
const inFrame = new Float64Array(3);
const outwardA = new Vector3();
const outwardB = new Vector3();
const colliderPose = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };
const turned = new Float64Array(3);

/** Points closing slower than this, in m/s, are solved one after the other even in a two-point patch: see `solveNormalPair`. */
const PAIR_IMPACT_SPEED = 1;
/** Beyond this condition number a two-point patch is solved one point after the other: see `solveNormalPair`. */
const MAX_PAIR_CONDITION = 1000;

/** What one point's normal row asks for on a pass: see `normalTerms`. */
const terms = { bias: 0, massScale: 1, impulseScale: 0 };
const otherTerms = { bias: 0, massScale: 1, impulseScale: 0 };

export class ContactTable {
  count = 0;
  /** Where each manifold's rows start, and one past the last manifold's end. */
  private patchStarts: number[] = [];
  private bodyA = new Int32Array(0);
  private bodyB = new Int32Array(0);
  private colliderA: Collider[] = [];
  private colliderB: Collider[] = [];
  private anchorA = new Float64Array(0);
  private anchorB = new Float64Array(0);
  /**
   * The part of each anchor that turns with its body: all of it on a collider with corners, and
   * only the offset to the centre it rolls about on a round one (see `roundingAt`), whose
   * touching point stays facing the other body however it rolls.
   */
  private turningA = new Float64Array(0);
  private turningB = new Float64Array(0);
  private normal = new Float64Array(0);
  private tangentA = new Float64Array(0);
  private tangentB = new Float64Array(0);
  private separation = new Float64Array(0);
  private normalMass = new Float64Array(0);
  private tangentMassA = new Float64Array(0);
  private tangentMassB = new Float64Array(0);
  private friction = new Float64Array(0);
  private restitution = new Float64Array(0);
  /** Rolling resistance times the rolling radius: the most torque per unit of normal force. */
  private rollingArm = new Float64Array(0);
  /** Speed along the normal when the point first pushed: negative, closing. */
  private approachSpeed = new Float64Array(0);
  private normalImpulse = new Float64Array(0);
  private frictionImpulseA = new Float64Array(0);
  private frictionImpulseB = new Float64Array(0);
  private rollingImpulse = new Float64Array(0);
  private maxNormalImpulse = new Float64Array(0);
  private totalNormalImpulse = new Float64Array(0);
  /**
   * What each point of the last step carried over, in the frame its body A had then, so it turns
   * with the body: where it was on body A, and its impulses. Points of one collider pair are
   * consecutive; `keptManifolds` says where each manifold's run begins and ends, by its two
   * bodies and two colliders (one collider is often shared by many bodies).
   */
  private keptAnchors = new Float64Array(0);
  private keptNormalImpulses = new Float64Array(0);
  private keptFriction = new Float64Array(0);
  private keptRolling = new Float64Array(0);
  /** 1 once a point of this step has taken over the kept point's impulses. */
  private keptTaken = new Uint8Array(0);
  private keptManifolds = new Map<SolverBody, Map<SolverBody, KeptRun[]>>();

  /** Rows for every point of the manifolds, with the impulses of the points they match from the last step. */
  prepare(manifolds: readonly Manifold[], bodies: BodyTable): void {
    let count = 0;
    for (const manifold of manifolds) count += manifold.points.length;
    if (this.normalMass.length < count) this.grow(Math.max(count, 2 * this.normalMass.length, 64));
    this.count = count;
    this.patchStarts.length = 0;
    let row = 0;
    for (const manifold of manifolds) {
      this.patchStarts.push(row);
      const indexA = bodies.indexOf.get(manifold.bodyA)!;
      const indexB = bodies.indexOf.get(manifold.bodyB)!;
      const run = this.keptManifolds.get(manifold.bodyA)?.get(manifold.bodyB)?.find((kept) => kept.colliderA === manifold.colliderA && kept.colliderB === manifold.colliderB);
      for (const point of manifold.points) {
        this.prepareRow(row, manifold, point, indexA, indexB, bodies, run);
        row++;
      }
    }
    this.patchStarts.push(row);
  }

  /** Applies the impulses each point starts the substep with. */
  warmStart(bodies: BodyTable): void {
    for (let row = 0; row < this.count; row++) {
      const vector = 3 * row;
      const normalImpulse = this.normalImpulse[row]!;
      const frictionA = this.frictionImpulseA[row]!;
      const frictionB = this.frictionImpulseB[row]!;
      const impulseX = this.normal[vector]! * normalImpulse + this.tangentA[vector]! * frictionA + this.tangentB[vector]! * frictionB;
      const impulseY = this.normal[vector + 1]! * normalImpulse + this.tangentA[vector + 1]! * frictionA + this.tangentB[vector + 1]! * frictionB;
      const impulseZ = this.normal[vector + 2]! * normalImpulse + this.tangentA[vector + 2]! * frictionA + this.tangentB[vector + 2]! * frictionB;
      this.applyImpulse(bodies, row, impulseX, impulseY, impulseZ);
      const rollingX = this.rollingImpulse[vector]!;
      const rollingY = this.rollingImpulse[vector + 1]!;
      const rollingZ = this.rollingImpulse[vector + 2]!;
      if (rollingX !== 0 || rollingY !== 0 || rollingZ !== 0) {
        bodies.applyAngularImpulse(this.bodyA[row]!, rollingX, rollingY, rollingZ);
        bodies.applyAngularImpulse(this.bodyB[row]!, -rollingX, -rollingY, -rollingZ);
      }
    }
  }

  /**
   * One pass over the contacts: every point's normal, then every point's friction and rolling
   * resistance. With `softness` the normal pushes overlaps apart as a soft spring, `fixedSoftness`
   * against a body that doesn't move; without them (the relaxing pass), it only stops the points
   * closing, so the push leaves no extra speed.
   */
  solve(bodies: BodyTable, substep: number, softness: Softness | undefined, fixedSoftness: Softness | undefined): void {
    // The two points of an edge against a face share its load together: one after the other,
    // the first would take a hard impact's whole blow before the second had its turn, and a car
    // striking a wall with the edge of its body, pushed at the top far more than at the bottom,
    // would be rolled over by it. (Going over a bigger patch's points more than once a pass
    // would apply their soft springs more than once, which lets stacks drift.)
    for (let patch = 0; patch + 1 < this.patchStarts.length; patch++) {
      const start = this.patchStarts[patch]!;
      const end = this.patchStarts[patch + 1]!;
      const patchSoftness = bodies.moving[this.bodyB[start]!] ? softness : fixedSoftness;
      if (end - start === 2) this.solveNormalPair(bodies, start, start + 1, substep, patchSoftness);
      else for (let row = start; row < end; row++) this.solveNormal(bodies, row, substep, patchSoftness);
    }
    for (let row = 0; row < this.count; row++) this.solveFriction(bodies, row);
    for (let row = 0; row < this.count; row++) if (this.rollingArm[row]! > 0) this.solveRolling(bodies, row);
  }

  /** Adds each point's impulse on this substep to its total for the step. */
  accumulate(): void {
    for (let row = 0; row < this.count; row++) this.totalNormalImpulse[row] = this.totalNormalImpulse[row]! + this.normalImpulse[row]!;
  }

  /** Bounces: sets the speed apart of each point that hit hard enough to a share of the speed it hit at. */
  applyRestitution(bodies: BodyTable): void {
    for (let row = 0; row < this.count; row++) {
      const restitution = this.restitution[row]!;
      const approachSpeed = this.approachSpeed[row]!;
      if (restitution === 0 || approachSpeed > -RESTITUTION_THRESHOLD || this.maxNormalImpulse[row]! === 0) continue;
      const normalSpeed = this.normalSpeed(bodies, row);
      const change = -this.normalMass[row]! * (normalSpeed + restitution * approachSpeed);
      const impulse = Math.max(this.normalImpulse[row]! + change, 0);
      const applied = impulse - this.normalImpulse[row]!;
      this.normalImpulse[row] = impulse;
      this.totalNormalImpulse[row] = this.totalNormalImpulse[row]! + applied;
      const vector = 3 * row;
      this.applyImpulse(bodies, row, this.normal[vector]! * applied, this.normal[vector + 1]! * applied, this.normal[vector + 2]! * applied);
    }
  }

  /** Keeps every point's impulses, in body A's frame, for the next step to start from. */
  storeImpulses(bodies: BodyTable): void {
    if (this.keptNormalImpulses.length < this.count) {
      const capacity = this.normalMass.length;
      this.keptAnchors = new Float64Array(3 * capacity);
      this.keptNormalImpulses = new Float64Array(capacity);
      this.keptFriction = new Float64Array(3 * capacity);
      this.keptRolling = new Float64Array(3 * capacity);
      this.keptTaken = new Uint8Array(capacity);
    }
    this.keptManifolds = new Map();
    let current: KeptRun | undefined;
    for (let row = 0; row < this.count; row++) {
      const colliderA = this.colliderA[row]!;
      const colliderB = this.colliderB[row]!;
      const bodyA = bodies.bodies[this.bodyA[row]!]!;
      const bodyB = bodies.bodies[this.bodyB[row]!]!;
      // rows of one manifold are consecutive: a new run starts where the bodies or colliders change
      if (!current || current.colliderA !== colliderA || current.colliderB !== colliderB || current.bodyA !== bodyA || current.bodyB !== bodyB) {
        current = { bodyA, bodyB, colliderA, colliderB, start: row, end: row };
        let byB = this.keptManifolds.get(bodyA);
        if (!byB) this.keptManifolds.set(bodyA, (byB = new Map()));
        const runs = byB.get(bodyB);
        if (runs) runs.push(current);
        else byB.set(bodyB, [current]);
      }
      current.end = row + 1;
      const indexA = this.bodyA[row]!;
      const vector = 3 * row;
      bodies.intoStartFrame(indexA, this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!, inFrame);
      this.keptAnchors.set(inFrame, vector);
      const frictionImpulseA = this.frictionImpulseA[row]!;
      const frictionImpulseB = this.frictionImpulseB[row]!;
      bodies.intoStartFrame(
        indexA,
        this.tangentA[vector]! * frictionImpulseA + this.tangentB[vector]! * frictionImpulseB,
        this.tangentA[vector + 1]! * frictionImpulseA + this.tangentB[vector + 1]! * frictionImpulseB,
        this.tangentA[vector + 2]! * frictionImpulseA + this.tangentB[vector + 2]! * frictionImpulseB,
        inFrame,
      );
      this.keptFriction.set(inFrame, vector);
      bodies.intoStartFrame(indexA, this.rollingImpulse[vector]!, this.rollingImpulse[vector + 1]!, this.rollingImpulse[vector + 2]!, inFrame);
      this.keptRolling.set(inFrame, vector);
      this.keptNormalImpulses[row] = this.normalImpulse[row]!;
      this.keptTaken[row] = 0;
    }
  }

  /** The points that pushed during the step, as the world reports them. */
  reports(bodies: BodyTable): Contact[] {
    const contacts: Contact[] = [];
    for (let row = 0; row < this.count; row++) {
      if (this.totalNormalImpulse[row]! <= 0) continue;
      const vector = 3 * row;
      const indexA = this.bodyA[row]!;
      const indexB = this.bodyB[row]!;
      const pointA = new Vector3(bodies.centers[3 * indexA]!, bodies.centers[3 * indexA + 1]!, bodies.centers[3 * indexA + 2]!).add(new Vector3(this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!));
      const pointB = new Vector3(bodies.centers[3 * indexB]!, bodies.centers[3 * indexB + 1]!, bodies.centers[3 * indexB + 2]!).add(new Vector3(this.anchorB[vector]!, this.anchorB[vector + 1]!, this.anchorB[vector + 2]!));
      contacts.push({
        bodyA: bodies.bodies[indexA]!.source,
        bodyB: bodies.bodies[indexB]!.source,
        colliderA: this.colliderA[row]!,
        colliderB: this.colliderB[row]!,
        point: pointA.add(pointB).multiplyScalar(0.5),
        normal: new Vector3(this.normal[vector]!, this.normal[vector + 1]!, this.normal[vector + 2]!),
        depth: -this.separation[row]!,
        normalImpulse: this.totalNormalImpulse[row]!,
      });
    }
    return contacts;
  }

  private prepareRow(row: number, manifold: Manifold, point: Manifold['points'][number], indexA: number, indexB: number, bodies: BodyTable, run: KeptRun | undefined): void {
    const vector = 3 * row;
    this.bodyA[row] = indexA;
    this.bodyB[row] = indexB;
    this.colliderA[row] = manifold.colliderA;
    this.colliderB[row] = manifold.colliderB;
    const anchorAX = point.pointA.x - bodies.centers[3 * indexA]!;
    const anchorAY = point.pointA.y - bodies.centers[3 * indexA + 1]!;
    const anchorAZ = point.pointA.z - bodies.centers[3 * indexA + 2]!;
    const anchorBX = point.pointB.x - bodies.centers[3 * indexB]!;
    const anchorBY = point.pointB.y - bodies.centers[3 * indexB + 1]!;
    const anchorBZ = point.pointB.z - bodies.centers[3 * indexB + 2]!;
    this.anchorA.set([anchorAX, anchorAY, anchorAZ], vector);
    this.anchorB.set([anchorBX, anchorBY, anchorBZ], vector);
    const normalX = point.normal.x;
    const normalY = point.normal.y;
    const normalZ = point.normal.z;
    this.normal.set([normalX, normalY, normalZ], vector);
    // the normal points from B toward A, so A's surface faces along -n and B's along +n
    this.writeTurningPart(this.turningA, vector, manifold.bodyA, manifold.colliderA, point.pointA, outwardA.set(-normalX, -normalY, -normalZ), anchorAX, anchorAY, anchorAZ);
    this.writeTurningPart(this.turningB, vector, manifold.bodyB, manifold.colliderB, point.pointB, outwardB.set(normalX, normalY, normalZ), anchorBX, anchorBY, anchorBZ);
    // two tangents square to the normal and each other
    const pickX = Math.abs(normalX) < 0.57735 ? 1 : 0;
    const pickY = pickX === 1 ? 0 : 1;
    let tangentX = normalY * 0 - normalZ * pickY;
    let tangentY = normalZ * pickX - normalX * 0;
    let tangentZ = normalX * pickY - normalY * pickX;
    const tangentLength = Math.sqrt(tangentX * tangentX + tangentY * tangentY + tangentZ * tangentZ);
    tangentX /= tangentLength;
    tangentY /= tangentLength;
    tangentZ /= tangentLength;
    this.tangentA.set([tangentX, tangentY, tangentZ], vector);
    this.tangentB.set([normalY * tangentZ - normalZ * tangentY, normalZ * tangentX - normalX * tangentZ, normalX * tangentY - normalY * tangentX], vector);
    this.separation[row] = -point.depth;
    this.normalMass[row] = inverse(this.inverseMassAlong(bodies, row, normalX, normalY, normalZ));
    this.tangentMassA[row] = inverse(this.inverseMassAlong(bodies, row, tangentX, tangentY, tangentZ));
    this.tangentMassB[row] = inverse(this.inverseMassAlong(bodies, row, this.tangentB[vector]!, this.tangentB[vector + 1]!, this.tangentB[vector + 2]!));
    this.friction[row] = Math.sqrt(manifold.colliderA.friction * manifold.colliderB.friction);
    this.restitution[row] = Math.max(manifold.colliderA.restitution, manifold.colliderB.restitution);
    const rollingResistance = Math.max(manifold.colliderA.rollingResistance, manifold.colliderB.rollingResistance);
    this.rollingArm[row] = rollingResistance * (rollingRadius(manifold.colliderA) ?? rollingRadius(manifold.colliderB) ?? 0);
    this.approachSpeed[row] = 0;
    this.maxNormalImpulse[row] = 0;
    this.totalNormalImpulse[row] = 0;
    this.warmStartFrom(row, bodies, indexA, run);
  }

  /**
   * Writes the part of an anchor that turns with its body: all of it, or on a round shape only
   * the offset to the centre it rolls about, the reach from there to the surface staying put.
   */
  private writeTurningPart(turning: Float64Array, vector: number, body: SolverBody, collider: Collider, contactPoint: Vector3, outward: Vector3, anchorX: number, anchorY: number, anchorZ: number): void {
    collider.poseIn(body, colliderPose);
    const rounding = roundingAt(collider, colliderPose, contactPoint, outward);
    turning[vector] = anchorX - (rounding?.reach.x ?? 0);
    turning[vector + 1] = anchorY - (rounding?.reach.y ?? 0);
    turning[vector + 2] = anchorZ - (rounding?.reach.z ?? 0);
  }

  /**
   * Takes over the impulses of the nearest point the same pair of colliders had in the last
   * step, if one is within reach and no other point has taken it yet.
   */
  private warmStartFrom(row: number, bodies: BodyTable, indexA: number, run: KeptRun | undefined): void {
    const vector = 3 * row;
    this.normalImpulse[row] = 0;
    this.frictionImpulseA[row] = 0;
    this.frictionImpulseB[row] = 0;
    this.rollingImpulse.fill(0, vector, vector + 3);
    if (!run) return;
    bodies.intoStartFrame(indexA, this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!, inFrame);
    let nearest = -1;
    let nearestDistanceSquared = WARM_START_MATCH * WARM_START_MATCH;
    for (let kept = run.start; kept < run.end; kept++) {
      if (this.keptTaken[kept]) continue;
      const offset = 3 * kept;
      const gapX = this.keptAnchors[offset]! - inFrame[0]!;
      const gapY = this.keptAnchors[offset + 1]! - inFrame[1]!;
      const gapZ = this.keptAnchors[offset + 2]! - inFrame[2]!;
      const distanceSquared = gapX * gapX + gapY * gapY + gapZ * gapZ;
      if (distanceSquared < nearestDistanceSquared) {
        nearest = kept;
        nearestDistanceSquared = distanceSquared;
      }
    }
    if (nearest === -1) return;
    this.keptTaken[nearest] = 1;
    const offset = 3 * nearest;
    this.normalImpulse[row] = this.keptNormalImpulses[nearest]!;
    // the friction impulse, back in world space, split along this step's tangents
    bodies.outOfStartFrame(indexA, this.keptFriction[offset]!, this.keptFriction[offset + 1]!, this.keptFriction[offset + 2]!, inFrame);
    this.frictionImpulseA[row] = inFrame[0]! * this.tangentA[vector]! + inFrame[1]! * this.tangentA[vector + 1]! + inFrame[2]! * this.tangentA[vector + 2]!;
    this.frictionImpulseB[row] = inFrame[0]! * this.tangentB[vector]! + inFrame[1]! * this.tangentB[vector + 1]! + inFrame[2]! * this.tangentB[vector + 2]!;
    bodies.outOfStartFrame(indexA, this.keptRolling[offset]!, this.keptRolling[offset + 1]!, this.keptRolling[offset + 2]!, inFrame);
    this.rollingImpulse.set(inFrame, vector);
  }

  /**
   * What a point's normal row asks for on this pass, into `target`: the speed apart it aims at
   * (as a bias on its speed), and how softly. A point not touching yet closes its gap, but no
   * faster than to touch by the end of the substep; a touching one, on the biased pass, is
   * pushed apart as a soft spring.
   */
  private normalTerms(bodies: BodyTable, row: number, substep: number, softness: Softness | undefined, target: typeof terms): typeof terms {
    const separation = this.currentSeparation(bodies, row);
    target.bias = 0;
    target.massScale = 1;
    target.impulseScale = 0;
    if (separation > 0) target.bias = separation / substep;
    else if (softness) {
      target.bias = Math.max(softness.biasRate * separation, -MAX_PUSH_OUT_SPEED);
      target.massScale = softness.massScale;
      target.impulseScale = softness.impulseScale;
    }
    return target;
  }

  private solveNormal(bodies: BodyTable, row: number, substep: number, softness: Softness | undefined): void {
    const { bias, massScale, impulseScale } = this.normalTerms(bodies, row, substep, softness, terms);
    const normalSpeed = this.normalSpeed(bodies, row);
    const change = -this.normalMass[row]! * massScale * (normalSpeed + bias) - impulseScale * this.normalImpulse[row]!;
    this.setNormalImpulse(bodies, row, Math.max(this.normalImpulse[row]! + change, 0), normalSpeed);
  }

  /**
   * The normals of a two-point patch, such as an edge against a face, struck hard: solved together, the pair
   * of impulses, neither pulling, that brings both points to the speeds their rows ask for, or
   * if that would need one to pull, the one point pushing alone, or neither (Box2D's block
   * solver). K is the pair's effective inverse mass, Kᵢⱼ how fast point i moves for a unit
   * impulse at point j.
   */
  private solveNormalPair(bodies: BodyTable, first: number, second: number, substep: number, softness: Softness | undefined): void {
    const firstTerms = this.normalTerms(bodies, first, substep, softness, terms);
    const secondTerms = this.normalTerms(bodies, second, substep, softness, otherTerms);
    const firstSpeed = this.normalSpeed(bodies, first);
    const secondSpeed = this.normalSpeed(bodies, second);
    // resting and slow contacts one after the other, which their carried-over impulses settle
    // smoothly: solved exactly, a body resting on two points can rock between them
    if (firstSpeed > -PAIR_IMPACT_SPEED && secondSpeed > -PAIR_IMPACT_SPEED) {
      this.solveNormal(bodies, first, substep, softness);
      this.solveNormal(bodies, second, substep, softness);
      return;
    }
    const firstImpulse = this.normalImpulse[first]!;
    const secondImpulse = this.normalImpulse[second]!;
    const firstFirst = 1 / this.normalMass[first]!;
    const secondSecond = 1 / this.normalMass[second]!;
    const coupling = this.normalCoupling(bodies, first, second);
    // points so close together, or so lined up, that they push almost as one: solved together they
    // would ask for great impulses, one against the other, so one after the other instead (as
    // Box2D does past a condition number of a thousand)
    if (firstFirst * firstFirst > MAX_PAIR_CONDITION * (firstFirst * secondSecond - coupling * coupling)) {
      this.solveNormal(bodies, first, substep, softness);
      this.solveNormal(bodies, second, substep, softness);
      return;
    }
    // each point's speed with neither point's impulse yet, plus the bias it aims beyond
    const firstWithout = firstSpeed - firstFirst * firstImpulse - coupling * secondImpulse + firstTerms.bias;
    const secondWithout = secondSpeed - coupling * firstImpulse - secondSecond * secondImpulse + secondTerms.bias;
    // the soft rows' answer, from the rigid one: λ' = λ + s (λ* - λ) - c λ, where λ* stops the points
    const soften = (rigid: number, current: number, rowTerms: typeof terms) => current + rowTerms.massScale * (rigid - current) - rowTerms.impulseScale * current;
    const determinant = firstFirst * secondSecond - coupling * coupling;
    let firstNew = -1;
    let secondNew = -1;
    if (determinant > 1e-12 * firstFirst * secondSecond) {
      // both pushing
      firstNew = soften((-secondSecond * firstWithout + coupling * secondWithout) / determinant, firstImpulse, firstTerms);
      secondNew = soften((-firstFirst * secondWithout + coupling * firstWithout) / determinant, secondImpulse, secondTerms);
    }
    if (firstNew < 0 || secondNew < 0) {
      // the first alone, if the second then needn't push
      firstNew = Math.max(soften(-firstWithout / firstFirst, firstImpulse, firstTerms), 0);
      secondNew = 0;
      if (secondWithout + coupling * firstNew < 0) {
        // the second alone, if the first then needn't push; otherwise both apart
        secondNew = Math.max(soften(-secondWithout / secondSecond, secondImpulse, secondTerms), 0);
        firstNew = firstWithout + coupling * secondNew < 0 ? soften(-firstWithout / firstFirst, firstImpulse, firstTerms) : 0;
        if (firstNew < 0 || (firstNew > 0 && secondNew > 0)) {
          // no case fits exactly, as soft rows may leave none: one after the other
          this.solveNormal(bodies, first, substep, softness);
          this.solveNormal(bodies, second, substep, softness);
          return;
        }
      }
    }
    this.setNormalImpulse(bodies, first, firstNew, firstSpeed);
    this.setNormalImpulse(bodies, second, secondNew, secondSpeed);
  }

  /** How fast point `first` moves along its normal for a unit impulse along the normal of `second`, of the same pair of bodies. */
  private normalCoupling(bodies: BodyTable, first: number, second: number): number {
    const one = 3 * first;
    const other = 3 * second;
    const normal = this.normal;
    return (
      bodies.crossInverseMass(this.bodyA[first]!, this.anchorA[one]!, this.anchorA[one + 1]!, this.anchorA[one + 2]!, normal[one]!, normal[one + 1]!, normal[one + 2]!, this.anchorA[other]!, this.anchorA[other + 1]!, this.anchorA[other + 2]!, normal[other]!, normal[other + 1]!, normal[other + 2]!) +
      bodies.crossInverseMass(this.bodyB[first]!, this.anchorB[one]!, this.anchorB[one + 1]!, this.anchorB[one + 2]!, normal[one]!, normal[one + 1]!, normal[one + 2]!, this.anchorB[other]!, this.anchorB[other + 1]!, this.anchorB[other + 2]!, normal[other]!, normal[other + 1]!, normal[other + 2]!)
    );
  }

  /** Sets a point's normal impulse, applying the change, and notes the speed it hit at. */
  private setNormalImpulse(bodies: BodyTable, row: number, impulse: number, normalSpeed: number): void {
    const applied = impulse - this.normalImpulse[row]!;
    this.normalImpulse[row] = impulse;
    // the speed it hits at, for the bounce: as it is the first time the point pushes, gravity and all
    if (this.maxNormalImpulse[row] === 0 && impulse > 0) this.approachSpeed[row] = normalSpeed;
    this.maxNormalImpulse[row] = Math.max(this.maxNormalImpulse[row]!, impulse);
    if (applied === 0) return;
    const vector = 3 * row;
    this.applyImpulse(bodies, row, this.normal[vector]! * applied, this.normal[vector + 1]! * applied, this.normal[vector + 2]! * applied);
  }

  /** Sliding friction along both tangents, together held inside the circle of friction × the normal impulse. */
  private solveFriction(bodies: BodyTable, row: number): void {
    const limit = this.friction[row]! * this.normalImpulse[row]!;
    const vector = 3 * row;
    this.relativeVelocity(bodies, row);
    const speedA = velocityA[0]! * this.tangentA[vector]! + velocityA[1]! * this.tangentA[vector + 1]! + velocityA[2]! * this.tangentA[vector + 2]!;
    const speedB = velocityA[0]! * this.tangentB[vector]! + velocityA[1]! * this.tangentB[vector + 1]! + velocityA[2]! * this.tangentB[vector + 2]!;
    const oldA = this.frictionImpulseA[row]!;
    const oldB = this.frictionImpulseB[row]!;
    let newA = oldA - this.tangentMassA[row]! * speedA;
    let newB = oldB - this.tangentMassB[row]! * speedB;
    const size = Math.sqrt(newA * newA + newB * newB);
    if (size > limit) {
      const shrink = size > 0 ? limit / size : 0;
      newA *= shrink;
      newB *= shrink;
    }
    this.frictionImpulseA[row] = newA;
    this.frictionImpulseB[row] = newB;
    const changeA = newA - oldA;
    const changeB = newB - oldB;
    if (changeA === 0 && changeB === 0) return;
    this.applyImpulse(
      bodies,
      row,
      this.tangentA[vector]! * changeA + this.tangentB[vector]! * changeB,
      this.tangentA[vector + 1]! * changeA + this.tangentB[vector + 1]! * changeB,
      this.tangentA[vector + 2]! * changeA + this.tangentB[vector + 2]! * changeB,
    );
  }

  /** Rolling resistance: an angular impulse against rolling (not twisting), at most the rolling arm times the normal impulse. */
  private solveRolling(bodies: BodyTable, row: number): void {
    const indexA = this.bodyA[row]!;
    const indexB = this.bodyB[row]!;
    const vector = 3 * row;
    // rolling over each other and spinning on the spot alike: a real contact is a small patch,
    // which resists both, and a ball that only spun would never come to rest
    const spinX = bodies.spins[3 * indexA]! - bodies.spins[3 * indexB]!;
    const spinY = bodies.spins[3 * indexA + 1]! - bodies.spins[3 * indexB + 1]!;
    const spinZ = bodies.spins[3 * indexA + 2]! - bodies.spins[3 * indexB + 2]!;
    const spin = Math.sqrt(spinX * spinX + spinY * spinY + spinZ * spinZ);
    if (spin < 1e-12) return;
    const axisX = spinX / spin;
    const axisY = spinY / spin;
    const axisZ = spinZ / spin;
    const inverseInertia = bodies.angularInverseMassAbout(indexA, axisX, axisY, axisZ) + bodies.angularInverseMassAbout(indexB, axisX, axisY, axisZ);
    if (inverseInertia === 0) return;
    const limit = this.rollingArm[row]! * this.normalImpulse[row]!;
    const oldX = this.rollingImpulse[vector]!;
    const oldY = this.rollingImpulse[vector + 1]!;
    const oldZ = this.rollingImpulse[vector + 2]!;
    const stop = spin / inverseInertia;
    let newX = oldX - axisX * stop;
    let newY = oldY - axisY * stop;
    let newZ = oldZ - axisZ * stop;
    const size = Math.sqrt(newX * newX + newY * newY + newZ * newZ);
    if (size > limit) {
      const shrink = size > 0 ? limit / size : 0;
      newX *= shrink;
      newY *= shrink;
      newZ *= shrink;
    }
    this.rollingImpulse[vector] = newX;
    this.rollingImpulse[vector + 1] = newY;
    this.rollingImpulse[vector + 2] = newZ;
    bodies.applyAngularImpulse(indexA, newX - oldX, newY - oldY, newZ - oldZ);
    bodies.applyAngularImpulse(indexB, oldX - newX, oldY - newY, oldZ - newZ);
  }

  /** How far apart the anchors are along the normal now: the step's starting gap plus how they have moved since. */
  private currentSeparation(bodies: BodyTable, row: number): number {
    const vector = 3 * row;
    const indexA = this.bodyA[row]!;
    const indexB = this.bodyB[row]!;
    let movedX = bodies.centers[3 * indexA]! - bodies.startCenters[3 * indexA]! - (bodies.centers[3 * indexB]! - bodies.startCenters[3 * indexB]!);
    let movedY = bodies.centers[3 * indexA + 1]! - bodies.startCenters[3 * indexA + 1]! - (bodies.centers[3 * indexB + 1]! - bodies.startCenters[3 * indexB + 1]!);
    let movedZ = bodies.centers[3 * indexA + 2]! - bodies.startCenters[3 * indexA + 2]! - (bodies.centers[3 * indexB + 2]! - bodies.startCenters[3 * indexB + 2]!);
    if (bodies.travelling[indexA]) {
      bodies.turnedSinceStart(indexA, this.turningA[vector]!, this.turningA[vector + 1]!, this.turningA[vector + 2]!, turned);
      movedX += turned[0]! - this.turningA[vector]!;
      movedY += turned[1]! - this.turningA[vector + 1]!;
      movedZ += turned[2]! - this.turningA[vector + 2]!;
    }
    if (bodies.travelling[indexB]) {
      bodies.turnedSinceStart(indexB, this.turningB[vector]!, this.turningB[vector + 1]!, this.turningB[vector + 2]!, turned);
      movedX -= turned[0]! - this.turningB[vector]!;
      movedY -= turned[1]! - this.turningB[vector + 1]!;
      movedZ -= turned[2]! - this.turningB[vector + 2]!;
    }
    return this.separation[row]! + movedX * this.normal[vector]! + movedY * this.normal[vector + 1]! + movedZ * this.normal[vector + 2]!;
  }

  /** Writes into `velocityA` the velocity of A's anchor relative to B's. */
  private relativeVelocity(bodies: BodyTable, row: number): void {
    const vector = 3 * row;
    bodies.pointVelocity(this.bodyA[row]!, this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!, velocityA);
    bodies.pointVelocity(this.bodyB[row]!, this.anchorB[vector]!, this.anchorB[vector + 1]!, this.anchorB[vector + 2]!, velocityB);
    velocityA[0] = velocityA[0]! - velocityB[0]!;
    velocityA[1] = velocityA[1]! - velocityB[1]!;
    velocityA[2] = velocityA[2]! - velocityB[2]!;
  }

  /** How fast the anchors move apart along the normal: negative while closing. */
  private normalSpeed(bodies: BodyTable, row: number): number {
    this.relativeVelocity(bodies, row);
    const vector = 3 * row;
    return velocityA[0]! * this.normal[vector]! + velocityA[1]! * this.normal[vector + 1]! + velocityA[2]! * this.normal[vector + 2]!;
  }

  private inverseMassAlong(bodies: BodyTable, row: number, directionX: number, directionY: number, directionZ: number): number {
    const vector = 3 * row;
    return (
      bodies.inverseMassAlong(this.bodyA[row]!, this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!, directionX, directionY, directionZ) +
      bodies.inverseMassAlong(this.bodyB[row]!, this.anchorB[vector]!, this.anchorB[vector + 1]!, this.anchorB[vector + 2]!, directionX, directionY, directionZ)
    );
  }

  /** Pushes A at its anchor by the impulse and B at its anchor by the opposite. */
  private applyImpulse(bodies: BodyTable, row: number, impulseX: number, impulseY: number, impulseZ: number): void {
    const vector = 3 * row;
    bodies.applyImpulse(this.bodyA[row]!, impulseX, impulseY, impulseZ, this.anchorA[vector]!, this.anchorA[vector + 1]!, this.anchorA[vector + 2]!);
    bodies.applyImpulse(this.bodyB[row]!, -impulseX, -impulseY, -impulseZ, this.anchorB[vector]!, this.anchorB[vector + 1]!, this.anchorB[vector + 2]!);
  }

  private grow(capacity: number): void {
    const floats = (width: number) => new Float64Array(capacity * width);
    this.bodyA = new Int32Array(capacity);
    this.bodyB = new Int32Array(capacity);
    this.colliderA = new Array<Collider>(capacity);
    this.colliderB = new Array<Collider>(capacity);
    this.anchorA = floats(3);
    this.anchorB = floats(3);
    this.turningA = floats(3);
    this.turningB = floats(3);
    this.normal = floats(3);
    this.tangentA = floats(3);
    this.tangentB = floats(3);
    this.separation = floats(1);
    this.normalMass = floats(1);
    this.tangentMassA = floats(1);
    this.tangentMassB = floats(1);
    this.friction = floats(1);
    this.restitution = floats(1);
    this.rollingArm = floats(1);
    this.approachSpeed = floats(1);
    this.normalImpulse = floats(1);
    this.frictionImpulseA = floats(1);
    this.frictionImpulseB = floats(1);
    this.rollingImpulse = floats(3);
    this.maxNormalImpulse = floats(1);
    this.totalNormalImpulse = floats(1);
  }
}

function inverse(value: number): number {
  return value > 0 ? 1 / value : 0;
}
