import { Vector3 } from 'three';
import { angularInverseMass, generalizedInverseMass, pointAtSubstepStart, rotationSinceSubstepStart } from '../positional.js';
import type { SolverBody } from '../SolverBody.js';
import type { ContactConstraint } from './ContactConstraint.js';

const midpoint = new Vector3();
const center = new Vector3();
const offsetFromCenter = new Vector3();
const localCenter = new Vector3();
const startA = new Vector3();
const startB = new Vector3();
const slide = new Vector3();
const slideDirection = new Vector3();
const turnA = new Vector3();
const turnB = new Vector3();

/**
 * The contacts between one pair of colliders, such as the four corners of a box on the floor.
 *
 * Static friction is decided for the patch as a whole: it holds if μ times the patch's total
 * normal force can stop both its slide and its twist, however the load is shared between its
 * points. Deciding point by point instead would ask each corner to stop the whole box with only
 * its own share of the weight, and a box on a gentle slope would creep.
 */
export class ContactPatch {
  constructor(
    private readonly bodyA: SolverBody,
    private readonly bodyB: SolverBody,
    private readonly contacts: readonly ContactConstraint[],
  ) {}

  /** Whether static friction can hold the patch still over this substep. Call after the normals are solved. */
  canHold(): boolean {
    let totalNormal = 0;
    let pushing: ContactConstraint | undefined;
    let pushingCount = 0;
    for (const contact of this.contacts) {
      if (contact.normalCorrection <= 0) continue;
      totalNormal += contact.normalCorrection;
      pushing = contact;
      pushingCount++;
    }
    if (!pushing) return false;
    const frictionLimit = pushing.friction * totalNormal;
    // a single point can't resist twisting, so only its slide counts
    if (pushingCount === 1) return pushing.slideImpulse() <= frictionLimit;
    return this.slideImpulse(totalNormal) / frictionLimit + this.twistShare(totalNormal, frictionLimit) <= 1;
  }

  /** Puts every touching point back where it started this substep. Call right after canHold, or on later passes. */
  removeSlide(substep: number): void {
    for (const contact of this.contacts) contact.removeSlide(substep);
  }

  /**
   * The positional impulse that would stop the slide at the patch's centre of pressure, where the
   * normal force acts on average. Leaves that centre in `center`.
   */
  private slideImpulse(totalNormal: number): number {
    center.set(0, 0, 0);
    for (const contact of this.contacts) {
      if (contact.normalCorrection > 0) center.addScaledVector(contact.midpoint(midpoint), contact.normalCorrection / totalNormal);
    }
    const normal = this.contacts[0]!.normal;
    // both bodies' material points at the centre are there now, so A slid along B by where B's started minus where A's did
    slide.subVectors(this.startOfMaterialPoint(this.bodyB, startB), this.startOfMaterialPoint(this.bodyA, startA));
    slide.addScaledVector(normal, -slide.dot(normal));
    const distance = slide.length();
    if (distance < 1e-12) return 0;
    slideDirection.copy(slide).divideScalar(distance);
    const inverseMass = generalizedInverseMass(this.bodyA, center, slideDirection) + generalizedInverseMass(this.bodyB, center, slideDirection);
    return inverseMass === 0 ? 0 : distance / inverseMass;
  }

  /**
   * How much of the friction limit stopping the patch from twisting about its normal would take:
   * the angular impulse needed, over μ times each point's normal force times its distance from the
   * centre of pressure. Uses `center` from slideImpulse.
   */
  private twistShare(totalNormal: number, frictionLimit: number): number {
    const normal = this.contacts[0]!.normal;
    let twistLimit = 0;
    for (const contact of this.contacts) {
      if (contact.normalCorrection <= 0) continue;
      offsetFromCenter.subVectors(contact.midpoint(midpoint), center);
      offsetFromCenter.addScaledVector(normal, -offsetFromCenter.dot(normal));
      twistLimit += (frictionLimit * contact.normalCorrection * offsetFromCenter.length()) / totalNormal;
    }
    const twist = rotationSinceSubstepStart(this.bodyA, turnA).dot(normal) - rotationSinceSubstepStart(this.bodyB, turnB).dot(normal);
    const inverseInertia = angularInverseMass(this.bodyA, normal) + angularInverseMass(this.bodyB, normal);
    // points in a line can't resist twisting about the normal either
    if (twist === 0 || inverseInertia === 0 || twistLimit === 0) return 0;
    return Math.abs(twist) / inverseInertia / twistLimit;
  }

  /** Where the material point of `body` now at `center` was when the substep began. */
  private startOfMaterialPoint(body: SolverBody, target: Vector3): Vector3 {
    return pointAtSubstepStart(body, body.worldToLocal(localCenter.copy(center)), target);
  }
}
