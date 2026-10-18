import { Vector3 } from 'three';
import { TargetJoint } from '@eulerjs/core';
import type { Body, Plugin, QueryHit, World } from '@eulerjs/core';
import type { FirstPersonPlayer } from './FirstPersonPlayer.js';

/** How far the player can reach, in metres. */
const REACH = 3;
/** A shove: how much speed it gives a 10 kg thing, less for heavier ones. */
const SHOVE_IMPULSE = 45;
/** Too heavy to pick up, in kg: the tables are, the chairs, presents and cake are not. */
const MOST_CARRIED = 20;
/** How stiffly a carried thing follows the hands, in Hz, and with how much force at most. */
const CARRY_FREQUENCY = 5;
const CARRY_FORCE = 700;
/** Thrown things leave at this speed, in m/s, slower if they are heavy. */
const THROW_SPEED = 9;
const THROW_IMPULSE_LIMIT = 60;

const eye = new Vector3();
const look = new Vector3();
const held = new Vector3();
const impulse = new Vector3();

interface Carried {
  readonly body: Body;
  readonly joint: TargetJoint;
  /** How far in front of the eyes it is held. */
  readonly distance: number;
}

/**
 * What the player does with their hands: shove what they look at, pick it up and carry it in
 * front of them, and throw it. Carrying is a target joint from the point they took hold of to a
 * point in front of their eyes, so a carried chair swings, knocks into things and is pulled no
 * harder than arms can pull.
 */
export class Hands implements Plugin {
  readonly name = 'hands';
  private carried: Carried | undefined;

  constructor(
    private readonly world: World,
    private readonly player: FirstPersonPlayer,
  ) {}

  /** What is being carried, if anything. */
  get holding(): Body | undefined {
    return this.carried?.body;
  }

  /** Whether `body` is light enough to pick up. */
  canLift(body: Body): boolean {
    return body.mass <= MOST_CARRIED;
  }

  /** What the player looks at within reach, if it is loose. */
  aimedAt(): QueryHit | undefined {
    const hit = this.world.castRay(this.player.eyePositionNow(eye), this.player.lookDirection(look), { maxDistance: REACH, exclude: this.player.body });
    return hit && hit.body.type === 'dynamic' && hit.body !== this.carried?.body ? hit : undefined;
  }

  /** Shoves what the player looks at, where they look at it; whether there was anything to shove. */
  shove(): boolean {
    const hit = this.aimedAt();
    if (!hit) return false;
    hit.body.applyImpulse(impulse.copy(look).multiplyScalar(SHOVE_IMPULSE * Math.min(1, Math.sqrt(hit.body.mass / 10))), hit.point);
    return true;
  }

  /** Picks up what the player looks at, held where they took hold of it; whether they could. */
  pickUp(): boolean {
    if (this.carried) return false;
    const hit = this.aimedAt();
    if (!hit || !this.canLift(hit.body)) return false;
    const joint = this.world.addJoint(
      new TargetJoint({ body: hit.body, anchor: hit.body.worldToLocal(hit.point.clone()), frequency: CARRY_FREQUENCY, maxForce: CARRY_FORCE, turns: false }),
    );
    // held a little nearer than where it was taken hold of, and never so near it hits the face
    this.carried = { body: hit.body, joint, distance: Math.max(1.1, Math.min(hit.distance, 1.6)) };
    hit.body.wakeUp();
    return true;
  }

  /** Lets go of what is carried. */
  drop(): void {
    if (!this.carried) return;
    this.world.removeJoint(this.carried.joint);
    this.carried = undefined;
  }

  /** Lets go of what is carried with a throw the way the player looks. */
  throwHeld(): void {
    const body = this.carried?.body;
    if (!body) return;
    this.drop();
    this.player.lookDirection(look);
    body.applyImpulse(impulse.copy(look).multiplyScalar(Math.min(THROW_SPEED * body.mass, THROW_IMPULSE_LIMIT)));
  }

  /** Before each step: moves the carried thing's target to in front of the eyes, moving with the player. */
  beforeStep(): void {
    if (!this.carried) return;
    // something it was taken from may have been removed from the world, or it may have been yanked away
    if (!this.world.bodies.includes(this.carried.body)) {
      this.drop();
      return;
    }
    this.player.eyePositionNow(eye);
    held.copy(eye).addScaledVector(this.player.lookDirection(look), this.carried.distance);
    this.carried.joint.setTarget(held, undefined, this.player.body.velocity);
  }
}
