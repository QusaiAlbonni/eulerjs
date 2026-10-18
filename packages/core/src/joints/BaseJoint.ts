import { Vector3 } from 'three';
import type { Body } from '../Body.js';

export interface BaseJointOptions {
  bodyA: Body;
  /** The other body. Leave out to tie body A to the world. */
  bodyB?: Body | undefined;
  /**
   * Whether the two bodies still collide with each other. Defaults to true; turn it off for parts
   * that overlap where they are joined, such as a ragdoll's thigh and shin. `'unlessOverlapping'`
   * decides when the joint is added to the world: they collide unless their colliders overlap
   * then, as joined limbs do and a shoulder that clears the chest doesn't.
   */
  collideConnected?: boolean | 'unlessOverlapping' | undefined;
  /** The joint breaks, and the world removes it, once it carries more force than this, in newtons. Defaults to Infinity. */
  breakForce?: number | undefined;
  /** The joint breaks once it carries more torque than this, in newton metres. Defaults to Infinity. */
  breakTorque?: number | undefined;
}

/** What every joint has: the bodies it ties, the loads it carries and when it breaks. */
export abstract class BaseJoint {
  readonly bodyA: Body;
  readonly bodyB: Body | undefined;
  /** Whether the two bodies collide with each other; fixed once the joint is in a world. */
  get collideConnected(): boolean {
    return this.collidesConnected;
  }
  /** As asked for, before a world decides 'unlessOverlapping'. */
  readonly collideConnectedSetting: boolean | 'unlessOverlapping';
  private collidesConnected: boolean;
  breakForce: number;
  breakTorque: number;
  /**
   * The force the joint put on body B over the last step (on body A, for a joint to the world),
   * in N, world space; on the other it is the opposite. Written by the backend.
   */
  readonly force = new Vector3();
  /** The torque the joint put on the same body over the last step, in N·m. Written by the backend. */
  readonly torque = new Vector3();
  /** Set once the joint has broken. */
  broken = false;

  constructor(options: BaseJointOptions) {
    this.bodyA = options.bodyA;
    this.bodyB = options.bodyB;
    this.collideConnectedSetting = options.collideConnected ?? true;
    this.collidesConnected = this.collideConnectedSetting !== false;
    this.breakForce = options.breakForce ?? Infinity;
    this.breakTorque = options.breakTorque ?? Infinity;
  }

  /** @internal Called by the world when the joint is added, to settle `'unlessOverlapping'`. */
  settleCollideConnected(overlapping: () => boolean): void {
    if (this.collideConnectedSetting === 'unlessOverlapping') this.collidesConnected = !overlapping();
  }

  /** The bodies the joint ties together. */
  get bodies(): readonly Body[] {
    return this.bodyB ? [this.bodyA, this.bodyB] : [this.bodyA];
  }

  /** Whether the loads of the last step are more than the joint can take. */
  get isOverloaded(): boolean {
    return this.force.length() > this.breakForce || this.torque.length() > this.breakTorque;
  }
}
