import { Quaternion } from 'three';
import type { Vector3 } from 'three';
import type { AxisMotion, JointDrive } from './SixDofJoint.js';

/**
 * The geometry every solver of a six-degree-of-freedom joint shares: how far apart and how
 * turned its two frames are, measured the same way whichever solver asks.
 *
 * Frame B's position is measured in frame A's axes. Its turn relative to frame A is split into a
 * twist about frame B's x axis and a swing that tilts that axis away from frame A's (the
 * swing-twist decomposition): relative = swing × twist. The swing is given as a rotation vector
 * in frame A, (0, about y, about z).
 */

export interface FrameTurn {
  /** Twist about the x axis, in radians, from -π to π. */
  twist: number;
  /** Swing as a rotation vector in frame A; its x is 0. */
  swing: Vector3;
}

/** Splits the turn `relative` (frame B in frame A) into twist and swing, writing the swing into `target`. */
export function swingAndTwist(relative: Quaternion, target: FrameTurn): FrameTurn {
  // the twist is the part of the rotation about x; the swing is what is left
  const twistLength = Math.hypot(relative.x, relative.w);
  let twistX = 0;
  let twistW = 1;
  if (twistLength > 1e-12) {
    twistX = relative.x / twistLength;
    twistW = relative.w / twistLength;
  }
  if (twistW < 0) {
    twistX = -twistX;
    twistW = -twistW;
  }
  target.twist = 2 * Math.atan2(twistX, twistW);
  // swing = relative × twist⁻¹
  swingScratch.set(-twistX, 0, 0, twistW).premultiply(relative);
  if (swingScratch.w < 0) swingScratch.set(-swingScratch.x, -swingScratch.y, -swingScratch.z, -swingScratch.w);
  const sine = Math.hypot(swingScratch.y, swingScratch.z);
  const angle = 2 * Math.atan2(sine, swingScratch.w);
  if (sine < 1e-12) target.swing.set(0, 0, 0);
  else target.swing.set(0, (swingScratch.y / sine) * angle, (swingScratch.z / sine) * angle);
  return target;
}

const swingScratch = new Quaternion();

/** How far `value` is beyond what `motion` allows: 0 within it, positive above, negative below. */
export function excess(value: number, motion: AxisMotion): number {
  if (motion === 'free') return 0;
  if (motion === 'locked') return value;
  if (value > motion.upper) return value - motion.upper;
  if (value < motion.lower) return value - motion.lower;
  return 0;
}

/** Whether a motion limits an axis to a range symmetric about 0, as the swing cone needs. */
function symmetricLimit(motion: AxisMotion): number | undefined {
  if (typeof motion === 'string') return undefined;
  return Math.abs(motion.lower + motion.upper) < 1e-12 ? motion.upper : undefined;
}

/**
 * Whether the two swing axes form a cone: both limited symmetrically, so that the swing may lean
 * any way within an ellipse whose half widths are the two limits.
 */
export function swingCone(motionY: AxisMotion, motionZ: AxisMotion): { aboutY: number; aboutZ: number } | undefined {
  const aboutY = symmetricLimit(motionY);
  const aboutZ = symmetricLimit(motionZ);
  return aboutY !== undefined && aboutZ !== undefined ? { aboutY, aboutZ } : undefined;
}

/** The cone's limit in the direction the swing leans: the ellipse's radius that way. */
export function coneLimit(cone: { aboutY: number; aboutZ: number }, swing: Vector3): number {
  const length = Math.hypot(swing.y, swing.z);
  if (length < 1e-12) return Math.min(cone.aboutY, cone.aboutZ);
  const cosine = swing.y / length;
  const sine = swing.z / length;
  return (cone.aboutY * cone.aboutZ) / Math.hypot(cone.aboutZ * cosine, cone.aboutY * sine) || 0;
}

/** How far the swing is beyond what its two motions allow, as a rotation vector in frame A to take back, written into `target`. */
export function swingExcess(swing: Vector3, motionY: AxisMotion, motionZ: AxisMotion, target: Vector3): Vector3 {
  const cone = swingCone(motionY, motionZ);
  if (cone) {
    const length = Math.hypot(swing.y, swing.z);
    const limit = coneLimit(cone, swing);
    if (length <= limit) return target.set(0, 0, 0);
    return target.copy(swing).multiplyScalar((length - limit) / length);
  }
  return target.set(0, excess(swing.y, motionY), excess(swing.z, motionZ));
}

/**
 * A drive's stiffness and damping along an axis whose effective inverse mass is `inverseMass`:
 * as given, or, for a drive given by `frequency` and `dampingRatio`, k = m ω² and c = 2 ζ m ω for
 * that axis's mass m, so that it rings at the same frequency whatever it moves.
 */
export function driveGains(drive: Pick<JointDrive, 'stiffness' | 'damping' | 'frequency' | 'dampingRatio'>, inverseMass: number): { stiffness: number; damping: number } {
  if (drive.frequency !== undefined) {
    const mass = inverseMass > 0 ? 1 / inverseMass : 0;
    const angularFrequency = 2 * Math.PI * drive.frequency;
    return { stiffness: mass * angularFrequency * angularFrequency, damping: 2 * (drive.dampingRatio ?? 1) * mass * angularFrequency };
  }
  const stiffness = drive.stiffness ?? 0;
  return { stiffness, damping: drive.damping ?? (stiffness === 0 ? Infinity : 0) };
}

/** Whether a joint locks none of its angular axes, as a ball joint doesn't: its friction then holds its whole turn alike every way. */
export function turnsFreely(angular: readonly AxisMotion[]): boolean {
  return angular[0] !== 'locked' && angular[1] !== 'locked' && angular[2] !== 'locked';
}

/** Whether a drive pulls toward a position, not only a speed. */
export function hasSpring(drive: Pick<JointDrive, 'stiffness' | 'frequency'>): boolean {
  return (drive.stiffness ?? 0) > 0 || (drive.frequency ?? 0) > 0;
}

/**
 * The impulse a drive gives along its axis on a substep, solved implicitly so that it is stable
 * at any stiffness: J = h (k (x* - x - h v) + c (v* - v)) / (1 + h w (h k + c)), for the axis's
 * position x and speed v, inverse mass w along it and substep h; with infinite damping, the
 * impulse that makes the speed v* exactly. Not yet held to its maximum force. A drive set by
 * frequency works its gains out from `gainInverseMass`, how hard the axis really is to move,
 * which can differ from the inverse mass an impulse sees on its own (see `pinnedInverseInertia`).
 */
export function driveImpulse(drive: JointDrive, position: number, speed: number, inverseMass: number, substep: number, gainInverseMass = inverseMass): number {
  const { stiffness, damping } = driveGains(drive, gainInverseMass);
  // infinitely damped: a motor that holds its speed exactly, as far as its force allows
  if (damping === Infinity) return inverseMass > 0 ? ((drive.targetVelocity ?? 0) - speed) / inverseMass : 0;
  const positionPull = drive.targetPosition === undefined ? 0 : stiffness * (drive.targetPosition - position - substep * speed);
  const speedPull = damping * ((drive.targetVelocity ?? 0) - speed);
  return (substep * (positionPull + speedPull)) / (1 + substep * inverseMass * (substep * stiffness + damping));
}

/** The rotation vector, in world space, that turns the moving frame from `orientationB` to `target` relative to `orientationA`, into `rotation`. */
export function turnToTarget(orientationA: Quaternion, target: Quaternion, orientationB: Quaternion, rotation: Vector3): Vector3 {
  // wanted: A target; the turn to it from B is (A target) B⁻¹
  wantedScratch.multiplyQuaternions(orientationA, target).multiply(inverseScratch.copy(orientationB).invert());
  const sign = wantedScratch.w < 0 ? -1 : 1;
  const sine = Math.hypot(wantedScratch.x, wantedScratch.y, wantedScratch.z);
  if (sine < 1e-12) return rotation.set(0, 0, 0);
  const angle = 2 * Math.atan2(sine, sign * wantedScratch.w);
  return rotation.set(wantedScratch.x, wantedScratch.y, wantedScratch.z).multiplyScalar((sign * angle) / sine);
}

const wantedScratch = new Quaternion();
const inverseScratch = new Quaternion();

/** The most impulse a drive may give on a substep. */
export function driveLimit(drive: JointDrive, substep: number): number {
  return (drive.maxForce ?? Infinity) * substep;
}

/** The unit vector along axis `axis` (0, 1 or 2) of a frame turned by `orientation`. */
export function frameAxis(orientation: Quaternion, axis: number, target: Vector3): Vector3 {
  return target.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0).applyQuaternion(orientation);
}

/** The inverse of a symmetric 3 × 3 tensor (xx xy xz yy yz zz) into `target`; zero if it has none. */
export function invertSymmetric(tensor: Float64Array, target: Float64Array): void {
  const [xx, xy, xz, yy, yz, zz] = tensor as unknown as [number, number, number, number, number, number];
  const cofactorXX = yy * zz - yz * yz;
  const cofactorXY = xz * yz - xy * zz;
  const cofactorXZ = xy * yz - xz * yy;
  const determinant = xx * cofactorXX + xy * cofactorXY + xz * cofactorXZ;
  if (!(Math.abs(determinant) > 1e-30)) {
    target.fill(0);
    return;
  }
  target[0] = cofactorXX / determinant;
  target[1] = cofactorXY / determinant;
  target[2] = cofactorXZ / determinant;
  target[3] = (xx * zz - xz * xz) / determinant;
  target[4] = (xy * xz - xx * yz) / determinant;
  target[5] = (xx * yy - xy * xy) / determinant;
}

const inertiaScratch = new Float64Array(6);
const pinnedScratch = new Float64Array(6);

/**
 * How hard a body is to turn about the unit `axis` through a point it is pinned at, the offset
 * `arm` from its centre of mass, given its world inverse inertia (a symmetric tensor, xx xy xz yy
 * yz zz) and inverse mass: aᵀ (I + m (|r|² E - r rᵀ))⁻¹ a, the parallel axis theorem. A limb
 * hanging from a ball joint turns about the joint, not its centre, and is that much harder to turn.
 */
export function pinnedInverseInertia(inverseInertia: Float64Array, inverseMass: number, armX: number, armY: number, armZ: number, axisX: number, axisY: number, axisZ: number): number {
  if (inverseMass <= 0) return 0;
  invertSymmetric(inverseInertia, inertiaScratch);
  const mass = 1 / inverseMass;
  const reachSquared = armX * armX + armY * armY + armZ * armZ;
  inertiaScratch[0] = inertiaScratch[0]! + mass * (reachSquared - armX * armX);
  inertiaScratch[1] = inertiaScratch[1]! - mass * armX * armY;
  inertiaScratch[2] = inertiaScratch[2]! - mass * armX * armZ;
  inertiaScratch[3] = inertiaScratch[3]! + mass * (reachSquared - armY * armY);
  inertiaScratch[4] = inertiaScratch[4]! - mass * armY * armZ;
  inertiaScratch[5] = inertiaScratch[5]! + mass * (reachSquared - armZ * armZ);
  invertSymmetric(inertiaScratch, pinnedScratch);
  const [xx, xy, xz, yy, yz, zz] = pinnedScratch as unknown as [number, number, number, number, number, number];
  return axisX * (xx * axisX + xy * axisY + xz * axisZ) + axisY * (xy * axisX + yy * axisY + yz * axisZ) + axisZ * (xz * axisX + yz * axisY + zz * axisZ);
}
