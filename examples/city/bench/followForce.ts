import { Quaternion, Vector3 } from 'three';
import type { Matrix3 } from 'three';

/**
 * How a walking part is pulled toward its place in the walk by a force and torque on it, worked
 * out from its motion alone: how the cannon-es mirror animates its walkers, cannon-es having no
 * joint drives. eulerjs drives them with its joints (see Pedestrian).
 */

/**
 * How stiffly each part follows the walk: the frequency (Hz) and damping ratio of the spring that
 * pulls it toward its place in the pose. About a second of a muscle's worth, not a robot's.
 */
const FOLLOW_FREQUENCY = 2.5;
const FOLLOW_DAMPING = 1;
const followRate = 2 * Math.PI * FOLLOW_FREQUENCY;

const turn = new Quaternion();
const inverseOrientation = new Quaternion();
const relativeVelocity = new Vector3();

/** A part's motion and mass, as any engine keeps them. */
export interface PartMotion {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly velocity: Vector3;
  readonly angularVelocity: Vector3;
  readonly mass: number;
  /** Inertia tensor about the centre of mass, in the part's own frame. */
  readonly inertia: Matrix3;
}

/**
 * The force through the centre of mass and the torque about it that pull a part toward
 * `targetPosition` and `targetQuaternion`, moving with `targetVelocity`, and carry its weight:
 * a damped spring, m (rate² · offset - 2 ζ rate · relative velocity) - m g, and I (rate² · angle - 2 ζ rate · ω).
 */
export function followForce(
  part: PartMotion,
  targetPosition: Vector3,
  targetQuaternion: Quaternion,
  targetVelocity: Vector3,
  gravity: Vector3,
  force: Vector3,
  torque: Vector3,
): void {
  force
    .subVectors(targetPosition, part.position)
    .multiplyScalar(followRate * followRate)
    .addScaledVector(relativeVelocity.subVectors(part.velocity, targetVelocity), -2 * FOLLOW_DAMPING * followRate)
    .addScaledVector(gravity, -1)
    .multiplyScalar(part.mass);

  turn.multiplyQuaternions(targetQuaternion, inverseOrientation.copy(part.quaternion).invert());
  if (turn.w < 0) turn.set(-turn.x, -turn.y, -turn.z, -turn.w);
  const angle = 2 * Math.acos(Math.min(1, turn.w));
  torque.set(turn.x, turn.y, turn.z);
  if (torque.lengthSq() > 1e-12) torque.normalize().multiplyScalar(angle);
  else torque.set(0, 0, 0);
  torque.multiplyScalar(followRate * followRate).addScaledVector(part.angularVelocity, -2 * FOLLOW_DAMPING * followRate);
  // I α with the inertia turned into world space
  torque.applyQuaternion(inverseOrientation).applyMatrix3(part.inertia).applyQuaternion(part.quaternion);
}
