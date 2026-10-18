import { Matrix3, Quaternion, Vector3 } from 'three';
import type { SolverBody } from './SolverBody.js';

const acceleration = new Vector3();
const angularAcceleration = new Vector3();
const initialBodyAngularVelocity = new Vector3();
const bodyAngularVelocity = new Vector3();
const midpointAngularVelocity = new Vector3();
const midpointAngularMomentum = new Vector3();
const gyroscopicTorque = new Vector3();
const gyroscopicResidual = new Vector3();
const inverseOrientation = new Quaternion();
const jacobian = new Matrix3();
const angularVelocityCross = new Matrix3();
const angularMomentumCross = new Matrix3();
const nextCenterOfMass = new Vector3();
const rotationAxis = new Vector3();
const rotationStep = new Quaternion();
const rotatedCenterOfMass = new Vector3();
/** Angular velocity the orientation turns by during the current step, in world space. */
const stepRotationRate = new Vector3();
/** Body-frame angular velocity at the end of the current step. */
const endBodyAngularVelocity = new Vector3();

const MAX_GYROSCOPIC_ITERATIONS = 8;
/** Newton stops once a correction is smaller than this fraction of the angular velocity. */
const GYROSCOPIC_TOLERANCE_SQUARED = 1e-24;

/**
 * Advances one body by one step with semi-implicit (symplectic) Euler: velocities first, from the
 * forces accumulated this step, then the pose from the new velocities.
 */
export function integrateBody(body: SolverBody, gravity: Vector3, timestep: number): void {
  if (body.type === 'static' || body.isSleeping) return;
  const spinsInBodyFrame = body.isDynamic && !body.hasEvenInertia;
  if (body.isDynamic) {
    integrateLinearVelocity(body, gravity, timestep);
    integrateAngularVelocity(body, timestep);
    // Damped before the body turns, as the linear velocity is before it moves: the solver works
    // out the velocity of a body it corrects from how far it moved, so damping applied after
    // would be lost on every body touching something or held by a joint.
    if (body.angularDamping > 0) {
      const kept = Math.exp(-body.angularDamping * timestep);
      stepRotationRate.multiplyScalar(kept);
      endBodyAngularVelocity.multiplyScalar(kept);
    }
  } else {
    stepRotationRate.copy(body.angularVelocity);
  }
  integratePose(body, timestep);
  if (spinsInBodyFrame) {
    // The angular velocity was integrated in the body frame; express it with the new orientation.
    body.angularVelocity.copy(endBodyAngularVelocity).applyQuaternion(body.quaternion);
  } else if (body.isDynamic && body.angularDamping > 0) {
    body.angularVelocity.copy(stepRotationRate);
  }
  body.updateDerivedState();
}

function integrateLinearVelocity(body: SolverBody, gravity: Vector3, timestep: number): void {
  acceleration.copy(body.force).multiplyScalar(body.inverseMass).addScaledVector(gravity, body.gravityScale);
  body.velocity.addScaledVector(acceleration, timestep);
  if (body.linearDamping > 0) body.velocity.multiplyScalar(Math.exp(-body.linearDamping * timestep));
}

function integrateAngularVelocity(body: SolverBody, timestep: number): void {
  angularAcceleration.copy(body.torque).applyMatrix3(body.worldInverseInertia);
  body.angularVelocity.addScaledVector(angularAcceleration, timestep);
  if (body.hasEvenInertia) {
    // ω × Iω is zero when I is the same about every axis: the spin carries on unchanged
    stepRotationRate.copy(body.angularVelocity);
    return;
  }
  applyGyroscopicTerm(body, timestep);
}

/**
 * Accounts for the -ω × Iω term of Euler's rotation equations, which makes an unevenly shaped
 * spinning body wobble and keeps its angular momentum (not its angular velocity) constant.
 *
 * Solved in the body frame with the implicit midpoint rule, I (ω₁ - ω₀) = -dt ωₘ × I ωₘ with
 * ωₘ = (ω₀ + ω₁) / 2. Rotational energy and |angular momentum| are quadratic invariants of
 * this equation, and the implicit midpoint rule conserves quadratic invariants exactly, so
 * neither drifts; it is also stable at any spin rate. The equation is solved by Newton's method.
 * The orientation then turns by ωₘ, which keeps the direction of the angular momentum steady too.
 */
function applyGyroscopicTerm(body: SolverBody, timestep: number): void {
  const inertia = body.massProperties!.inertia;
  inverseOrientation.copy(body.quaternion).invert();
  initialBodyAngularVelocity.copy(body.angularVelocity).applyQuaternion(inverseOrientation);
  bodyAngularVelocity.copy(initialBodyAngularVelocity);

  for (let iteration = 0; iteration < MAX_GYROSCOPIC_ITERATIONS; iteration++) {
    midpointAngularVelocity.addVectors(initialBodyAngularVelocity, bodyAngularVelocity).multiplyScalar(0.5);
    midpointAngularMomentum.copy(midpointAngularVelocity).applyMatrix3(inertia);

    // residual = I (ω₁ - ω₀) + dt ωₘ × I ωₘ
    gyroscopicResidual
      .subVectors(bodyAngularVelocity, initialBodyAngularVelocity)
      .applyMatrix3(inertia)
      .add(gyroscopicTorque.crossVectors(midpointAngularVelocity, midpointAngularMomentum).multiplyScalar(timestep));

    // d residual / d ω₁ = I + dt/2 (skew(ωₘ) I - skew(I ωₘ))
    setCrossProductMatrix(angularVelocityCross, midpointAngularVelocity).multiply(inertia);
    setCrossProductMatrix(angularMomentumCross, midpointAngularMomentum);
    for (let element = 0; element < 9; element++) {
      jacobian.elements[element] =
        inertia.elements[element]! + 0.5 * timestep * (angularVelocityCross.elements[element]! - angularMomentumCross.elements[element]!);
    }
    const correction = gyroscopicResidual.applyMatrix3(jacobian.invert());
    bodyAngularVelocity.sub(correction);
    if (correction.lengthSq() <= GYROSCOPIC_TOLERANCE_SQUARED * Math.max(bodyAngularVelocity.lengthSq(), 1e-30)) break;
  }
  midpointAngularVelocity.addVectors(initialBodyAngularVelocity, bodyAngularVelocity).multiplyScalar(0.5);
  stepRotationRate.copy(midpointAngularVelocity).applyQuaternion(body.quaternion);
  endBodyAngularVelocity.copy(bodyAngularVelocity);
}

/** Matrix M with M v = vector × v. */
function setCrossProductMatrix(target: Matrix3, vector: Vector3): Matrix3 {
  return target.set(0, -vector.z, vector.y, vector.z, 0, -vector.x, -vector.y, vector.x, 0);
}

/** Moves the centre of mass along the velocity and turns the body about it. */
function integratePose(body: SolverBody, timestep: number): void {
  nextCenterOfMass.copy(body.worldCenterOfMass).addScaledVector(body.velocity, timestep);

  const angularSpeed = stepRotationRate.length();
  if (angularSpeed > 0) {
    rotationAxis.copy(stepRotationRate).divideScalar(angularSpeed);
    rotationStep.setFromAxisAngle(rotationAxis, angularSpeed * timestep);
    body.quaternion.premultiply(rotationStep).normalize();
  }

  const localCenterOfMass = body.massProperties?.centerOfMass;
  rotatedCenterOfMass.set(0, 0, 0);
  if (localCenterOfMass) rotatedCenterOfMass.copy(localCenterOfMass).applyQuaternion(body.quaternion);
  body.position.subVectors(nextCenterOfMass, rotatedCenterOfMass);
}
