import { Quaternion, Vector3 } from 'three';
import type { SolverBody } from './SolverBody.js';

/** Where a body was at the start of the current substep, and whether a constraint has moved it since. */
export interface SubstepState {
  readonly centerOfMass: Vector3;
  readonly quaternion: Quaternion;
  corrected: boolean;
}

const leverArm = new Vector3();
const angularDirection = new Vector3();
const correction = new Vector3();
const rotationChange = new Vector3();
const orientationChange = new Quaternion();
const rotatedCenterOfMass = new Vector3();
const newCenterOfMass = new Vector3();
const inertiaTimesDirection = new Vector3();
const inverseStartOrientation = new Quaternion();

/** @internal Records the pose a body starts a substep in, before it is integrated. */
export function beginSubstep(body: SolverBody): void {
  let state = body.substepStart;
  if (!state) {
    state = { centerOfMass: new Vector3(), quaternion: new Quaternion(), corrected: false };
    body.substepStart = state;
  }
  state.centerOfMass.copy(body.worldCenterOfMass);
  state.quaternion.copy(body.quaternion);
  state.corrected = false;
}

/**
 * @internal After the constraints have run, sets the velocities of every body they moved to the
 * motion it actually made over the substep, as position-based dynamics does.
 */
export function deriveVelocitiesIfCorrected(body: SolverBody, substep: number): void {
  const state = body.substepStart;
  if (!state?.corrected) return;
  // the corrections kept the quaternion normalised and the centre of mass up to date; the
  // velocity pass needs the inertia turned the way they left the body
  body.refreshDerivedState();
  body.velocity.subVectors(body.worldCenterOfMass, state.centerOfMass).divideScalar(substep);
  orientationChange.multiplyQuaternions(body.quaternion, inverseStartOrientation.copy(state.quaternion).invert());
  const sign = orientationChange.w < 0 ? -1 : 1;
  body.angularVelocity.set(orientationChange.x, orientationChange.y, orientationChange.z).multiplyScalar((2 * sign) / substep);
}

/**
 * How hard `body` is to move at `worldPoint` along the unit `direction`: 1/m + (r × n)ᵀ I⁻¹ (r × n).
 * Zero for bodies that forces can't move.
 */
export function generalizedInverseMass(body: SolverBody, worldPoint: Vector3, direction: Vector3): number {
  if (!body.isMovable) return 0;
  leverArm.subVectors(worldPoint, body.worldCenterOfMass);
  angularDirection.crossVectors(leverArm, direction);
  return body.inverseMass + angularDirection.dot(inertiaTimesDirection.copy(angularDirection).applyMatrix3(body.worldInverseInertia));
}

/**
 * Moves and turns `body` as if the positional impulse `impulse` (kg·m: a force times the substep
 * squared) acted at `worldPoint`, keeping its matrix and centre of mass up to date.
 */
export function applyPositionalImpulse(body: SolverBody, impulse: Vector3, worldPoint: Vector3): void {
  if (!body.isMovable) return;
  const state = body.substepStart;
  if (state) state.corrected = true;

  leverArm.subVectors(worldPoint, body.worldCenterOfMass);
  rotationChange.crossVectors(leverArm, impulse).applyMatrix3(body.worldInverseInertia);
  newCenterOfMass.copy(body.worldCenterOfMass).addScaledVector(impulse, body.inverseMass);
  turnAndMove(body);
}

/**
 * Turns `body` about its centre of mass as if the angular positional impulse `angularImpulse`
 * (kg·m²: a torque times the substep squared) acted on it.
 */
export function applyAngularPositionalImpulse(body: SolverBody, angularImpulse: Vector3): void {
  if (!body.isMovable) return;
  const state = body.substepStart;
  if (state) state.corrected = true;
  rotationChange.copy(angularImpulse).applyMatrix3(body.worldInverseInertia);
  newCenterOfMass.copy(body.worldCenterOfMass);
  turnAndMove(body);
}

/**
 * Turns `body` by the small rotation vector `rotation` (world space) about the world point
 * `pivot`, which stays where it is: the centre of mass swings round it.
 */
export function turnAboutPoint(body: SolverBody, rotation: Vector3, pivot: Vector3): void {
  if (!body.isMovable) return;
  const state = body.substepStart;
  if (state) state.corrected = true;
  rotationChange.copy(rotation);
  leverArm.subVectors(body.worldCenterOfMass, pivot);
  newCenterOfMass.copy(body.worldCenterOfMass).add(correction.crossVectors(rotation, leverArm));
  turnAndMove(body);
}

/** Turns the body by `rotationChange` and puts its centre of mass at `newCenterOfMass`. */
function turnAndMove(body: SolverBody): void {
  // q += ½ [Δθ, 0] q, then renormalise
  orientationChange.set(rotationChange.x, rotationChange.y, rotationChange.z, 0).multiply(body.quaternion);
  body.quaternion.set(
    body.quaternion.x + 0.5 * orientationChange.x,
    body.quaternion.y + 0.5 * orientationChange.y,
    body.quaternion.z + 0.5 * orientationChange.z,
    body.quaternion.w + 0.5 * orientationChange.w,
  );
  body.quaternion.normalize();

  const localCenterOfMass = body.massProperties?.centerOfMass;
  rotatedCenterOfMass.set(0, 0, 0);
  if (localCenterOfMass) rotatedCenterOfMass.copy(localCenterOfMass).applyQuaternion(body.quaternion);
  body.position.subVectors(newCenterOfMass, rotatedCenterOfMass);
  // the quaternion was just renormalised; the world inverse inertia is refreshed when the next substep integrates the body
  body.refreshCenterOfMass();
}

export interface PositionCorrection {
  bodyA: SolverBody;
  /** The point on body A, in world space. */
  pointA: Vector3;
  /** Leave out to pin body A to a fixed point in the world. */
  bodyB?: SolverBody | undefined;
  /** The point on body B (or in the world), in world space. */
  pointB: Vector3;
  /** Unit direction from point B toward point A, along which the constraint acts. */
  direction: Vector3;
  /** How far the points are from where the constraint wants them, along `direction`: positive to pull them together. */
  error: number;
  /** Softness in m/N; 0 is perfectly stiff. */
  compliance?: number | undefined;
  /**
   * The two bodies' generalized inverse masses along `direction`, summed, if already known.
   * Contacts work it out once per step, since it barely changes over a step.
   */
  inverseMass?: number | undefined;
}

/**
 * One XPBD position correction (Müller et al. 2020, "Detailed Rigid Body Simulation with Extended
 * Position Based Dynamics"): moves both bodies along `direction` to remove `error`, sharing the
 * work by how easy each is to move at its point. Returns the positional impulse magnitude; divide
 * by the substep squared to get the force it represents.
 */
export function correctPosition(correctionRequest: PositionCorrection, substep: number): number {
  const { bodyA, pointA, bodyB, pointB, direction, error } = correctionRequest;
  const inverseMass =
    correctionRequest.inverseMass ?? generalizedInverseMass(bodyA, pointA, direction) + (bodyB ? generalizedInverseMass(bodyB, pointB, direction) : 0);
  const scaledCompliance = (correctionRequest.compliance ?? 0) / (substep * substep);
  const totalInverseMass = inverseMass + scaledCompliance;
  if (totalInverseMass === 0) return 0;

  const impulseMagnitude = -error / totalInverseMass;
  correction.copy(direction).multiplyScalar(impulseMagnitude);
  applyPositionalImpulse(bodyA, correction, pointA);
  if (bodyB) applyPositionalImpulse(bodyB, correction.negate(), pointB);
  return impulseMagnitude;
}


/**
 * Where a point fixed to `body` (given in its frame) was at the start of the current substep,
 * whether the body was moved by the solver or, being kinematic, by its own velocity. Bodies the
 * solver hasn't seen this substep report where the point is now.
 */
export function pointAtSubstepStart(body: SolverBody, localPoint: Vector3, target: Vector3): Vector3 {
  const state = body.substepStart;
  if (!state) return body.pointToWorld(localPoint, target);
  const localCenterOfMass = body.massProperties?.centerOfMass;
  target.copy(localPoint);
  if (localCenterOfMass) target.sub(localCenterOfMass);
  return target.applyQuaternion(state.quaternion).add(state.centerOfMass);
}

/**
 * Where the material point of `body` that was at `startPoint` when the substep began is now:
 * carried along by the body's motion since then.
 */
export function materialPointNow(body: SolverBody, startPoint: Vector3, target: Vector3): Vector3 {
  const state = body.substepStart;
  if (!state) return target.copy(startPoint);
  orientationChange.multiplyQuaternions(body.quaternion, inverseStartOrientation.copy(state.quaternion).invert());
  return target.subVectors(startPoint, state.centerOfMass).applyQuaternion(orientationChange).add(body.worldCenterOfMass);
}

/** How far `body` has turned since the substep began, as a rotation vector (axis times angle) in world space. */
export function rotationSinceSubstepStart(body: SolverBody, target: Vector3): Vector3 {
  const state = body.substepStart;
  if (!state) return target.set(0, 0, 0);
  orientationChange.multiplyQuaternions(body.quaternion, inverseStartOrientation.copy(state.quaternion).invert());
  const sign = orientationChange.w < 0 ? -1 : 1;
  return target.set(orientationChange.x, orientationChange.y, orientationChange.z).multiplyScalar(2 * sign);
}

/** How hard `body` is to turn about the unit `axis`: aᵀ I⁻¹ a. Zero for bodies that forces can't move. */
export function angularInverseMass(body: SolverBody, axis: Vector3): number {
  if (!body.isMovable) return 0;
  return axis.dot(inertiaTimesDirection.copy(axis).applyMatrix3(body.worldInverseInertia));
}

/** Changes a body's spin as if the angular impulse `angularImpulse` (N·m·s) acted on it; never wakes it. */
export function applyAngularVelocityImpulse(body: SolverBody, angularImpulse: Vector3): void {
  if (!body.isMovable) return;
  body.angularVelocity.add(rotationChange.copy(angularImpulse).applyMatrix3(body.worldInverseInertia));
}

/**
 * Changes a body's velocity as if `impulse` (N·s) acted at `worldPoint`, for constraints'
 * velocity passes. Unlike `body.applyImpulse` it never wakes a sleeping body, which the solver
 * treats as immovable.
 */
export function applyVelocityImpulse(body: SolverBody, impulse: Vector3, worldPoint: Vector3): void {
  if (!body.isMovable) return;
  body.velocity.addScaledVector(impulse, body.inverseMass);
  leverArm.subVectors(worldPoint, body.worldCenterOfMass);
  rotationChange.crossVectors(leverArm, impulse).applyMatrix3(body.worldInverseInertia);
  body.angularVelocity.add(rotationChange);
}
