import { Matrix3, Quaternion, Vector3 } from 'three';
import type { Collider } from '../../colliders/Collider.js';
import { materialPointNow, pointAtSubstepStart } from '../positional.js';
import type { SolverBody } from '../SolverBody.js';
import { roundingAt } from './round.js';

const colliderPose = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };

/** Where a contact touches one of its two bodies, for the length of a step. */
export interface ContactAnchor {
  /** Writes where the contact is on the body now. */
  current(target: Vector3): Vector3;
  /**
   * For friction: writes where the material point that was at the contact when the substep
   * began was then, and where it is now.
   */
  materialMotion(start: Vector3, now: Vector3): void;
}

/**
 * The anchor for a collider: on a round shape (a sphere, a capsule, a cylinder's side), the
 * touching point itself, which rolls over the surface and so is a different material point every
 * moment; on anything with corners, edges and faces, a material point, whose touching points move
 * with the body.
 * @param outward Unit direction from the body's collider toward the other body.
 */
export function anchorFor(body: SolverBody, collider: Collider, worldPoint: Vector3, outward: Vector3): ContactAnchor {
  collider.poseIn(body, colliderPose);
  const rounding = roundingAt(collider, colliderPose, worldPoint, outward);
  if (rounding) {
    const reach = rounding.reach.length();
    return new SphereSurfaceAnchor(body, body.worldToLocal(rounding.center), reach, reach > 0 ? rounding.reach.divideScalar(reach) : outward);
  }
  return new MaterialAnchor(body, body.worldToLocal(worldPoint.clone()));
}

/** A point fixed in the body. */
class MaterialAnchor implements ContactAnchor {
  constructor(
    private readonly body: SolverBody,
    private readonly localPoint: Vector3,
  ) {}

  current(target: Vector3): Vector3 {
    return this.body.pointToWorld(this.localPoint, target);
  }

  materialMotion(start: Vector3, now: Vector3): void {
    pointAtSubstepStart(this.body, this.localPoint, start);
    this.current(now);
  }
}

/** A point a fixed reach along `outward` from a centre fixed in the body: wherever a round shape has rolled to. */
class SphereSurfaceAnchor implements ContactAnchor {
  constructor(
    private readonly body: SolverBody,
    private readonly localCenter: Vector3,
    private readonly radius: number,
    private readonly outward: Vector3,
  ) {}

  current(target: Vector3): Vector3 {
    return this.body.pointToWorld(this.localCenter, target).addScaledVector(this.outward, this.radius);
  }

  materialMotion(start: Vector3, now: Vector3): void {
    pointAtSubstepStart(this.body, this.localCenter, start).addScaledVector(this.outward, this.radius);
    materialPointNow(this.body, start, now);
  }
}
