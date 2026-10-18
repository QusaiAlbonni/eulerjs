import { Vector3 } from 'three';
import { BaseJoint } from './BaseJoint.js';
import type { BaseJointOptions } from './BaseJoint.js';

export interface DistanceJointOptions extends BaseJointOptions {
  /** Where the joint holds body A, in its own frame. Defaults to its frame origin. */
  anchorA?: Vector3 | undefined;
  /** Where the joint holds body B, in its own frame; or, without body B, the fixed point in world space. */
  anchorB?: Vector3 | undefined;
  /** The distance to keep. Defaults to the distance between the anchors when the joint is made. */
  length?: number | undefined;
  /** Softness in m/N: 0 is a rigid rod; larger values stretch like a spring of stiffness 1 / compliance. */
  compliance?: number | undefined;
  /** Like a rope: only resists being stretched, and goes slack when the anchors come closer. */
  slack?: boolean | undefined;
  /** How fast motion along the joint dies out, per second. */
  damping?: number | undefined;
}

const worldAnchorA = new Vector3();
const worldAnchorB = new Vector3();

/**
 * Keeps two points, on two bodies or on a body and the world, a fixed distance apart. Its
 * settings can be changed between steps; the backend reads them every step.
 */
export class DistanceJoint extends BaseJoint {
  readonly anchorA: Vector3;
  readonly anchorB: Vector3;
  length: number;
  compliance: number;
  slack: boolean;
  damping: number;
  /** Tension in newtons, written by the backend after each step; 0 while a rope is slack. */
  tension = 0;

  constructor(options: DistanceJointOptions) {
    super(options);
    this.anchorA = (options.anchorA ?? new Vector3()).clone();
    this.anchorB = (options.anchorB ?? new Vector3()).clone();
    this.compliance = options.compliance ?? 0;
    this.slack = options.slack ?? false;
    this.damping = options.damping ?? 0;
    this.length = options.length ?? this.currentAnchors().distance;
  }

  /** The anchors in world space and the distance between them, as of the last step. */
  currentAnchors(): { pointA: Vector3; pointB: Vector3; distance: number } {
    this.bodyA.pointToWorld(this.anchorA, worldAnchorA);
    if (this.bodyB) this.bodyB.pointToWorld(this.anchorB, worldAnchorB);
    else worldAnchorB.copy(this.anchorB);
    return { pointA: worldAnchorA, pointB: worldAnchorB, distance: worldAnchorA.distanceTo(worldAnchorB) };
  }
}
