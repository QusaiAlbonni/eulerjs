import { Quaternion, Vector3 } from 'three';
import type { Behavior, Body, World } from '@eulerjs/core';
import type { FluidMedium } from '../media.js';
import type { Polar } from './polars.js';

export interface FoilOptions {
  /** The fluid the foil works in: a Wind for sails, an Ocean for keels and rudders. */
  medium: FluidMedium;
  /** Planform area in m². */
  area: number;
  /** Where the force acts (the centre of effort) at angle 0, in the body frame. */
  center: Vector3;
  /**
   * Point the foil turns about (on a mast or rudder post), in the body frame. The centre of
   * effort swings around it with the angle. Defaults to the centre itself.
   */
  pivot?: Vector3;
  /** Axis the foil turns about (a mast, a rudder post), in the body frame. Defaults to +y. */
  spanAxis?: Vector3;
  /** Direction the leading edge points at angle 0, in the body frame. Defaults to +z. */
  chordAxis?: Vector3;
  polar: Polar;
  /** Rotation of the chord about the span axis, in radians. */
  angle?: number;
}

const span = new Vector3();
const chord = new Vector3();
const flow = new Vector3();
const bodyVelocity = new Vector3();
const flowDirection = new Vector3();
const liftDirection = new Vector3();
const crossProduct = new Vector3();
const trim = new Quaternion();

/**
 * A wing-like surface — sail, keel, rudder — that turns the flow past it into lift (across the
 * flow) and drag (along it). Only the part of the flow across the span counts, so a foil
 * ignores flow along its own span.
 */
export class Foil implements Behavior {
  medium: FluidMedium;
  area: number;
  polar: Polar;
  angle: number;
  readonly center: Vector3;
  readonly pivot: Vector3;
  readonly spanAxis: Vector3;
  readonly chordAxis: Vector3;

  /** The force applied on the last step, in world space. */
  readonly lastForce = new Vector3();
  /** Where that force acted, in world space. */
  readonly lastCenter = new Vector3();
  /** Angle of attack on the last step, in radians, from 0 to π. */
  lastAngleOfAttack = 0;
  /** Speed of the flow across the span on the last step, in m/s. */
  lastFlowSpeed = 0;

  constructor(options: FoilOptions) {
    this.medium = options.medium;
    this.area = options.area;
    this.polar = options.polar;
    this.angle = options.angle ?? 0;
    this.center = options.center.clone();
    this.pivot = (options.pivot ?? options.center).clone();
    this.spanAxis = (options.spanAxis ?? new Vector3(0, 1, 0)).clone().normalize();
    const chordAxis = (options.chordAxis ?? new Vector3(0, 0, 1)).clone();
    this.chordAxis = chordAxis.addScaledVector(this.spanAxis, -chordAxis.dot(this.spanAxis));
    if (this.chordAxis.lengthSq() < 1e-12) {
      throw new RangeError('A foil chord axis must not be parallel to its span axis');
    }
    this.chordAxis.normalize();
  }

  fixedUpdate(body: Body, _timestep: number, world: World): void {
    this.computeForce(body, world.time, this.lastForce);
    body.applyForce(this.lastForce, this.lastCenter);
  }

  /** The force the foil would apply to `body` at `time`, without applying it. Updates the `last…` fields. */
  computeForce(body: Body, time: number, target: Vector3): Vector3 {
    trim.setFromAxisAngle(this.spanAxis, this.angle);
    const trimmedCenter = this.lastCenter.subVectors(this.center, this.pivot).applyQuaternion(trim).add(this.pivot);
    const center = body.localToWorld(trimmedCenter);
    body.directionToWorld(span.copy(this.spanAxis));
    body.directionToWorld(chord.copy(this.chordAxis).applyQuaternion(trim));

    // Flow relative to the foil, keeping only the part across the span.
    this.medium.velocityAt(center, time, flow).sub(body.pointVelocity(center, bodyVelocity));
    flow.addScaledVector(span, -flow.dot(span));
    const flowSpeed = flow.length();
    this.lastFlowSpeed = flowSpeed;
    if (flowSpeed < 1e-9) {
      this.lastAngleOfAttack = 0;
      return target.set(0, 0, 0);
    }
    flowDirection.copy(flow).divideScalar(flowSpeed);

    // Signed angle from the chord to the upstream direction (-flowDirection), about the span.
    const upstreamCosine = -chord.dot(flowDirection);
    const upstreamSine = -crossProduct.crossVectors(chord, flowDirection).dot(span);
    const signedAngle = Math.atan2(upstreamSine, upstreamCosine);
    const angleOfAttack = Math.abs(signedAngle);
    this.lastAngleOfAttack = angleOfAttack;

    // Lift is perpendicular to the flow. With a positive lift coefficient it points to the side of
    // the chord the flow is not coming from (to leeward), as on a flat plate.
    liftDirection.crossVectors(span, flowDirection).multiplyScalar(Math.sign(signedAngle));
    const dynamicPressureTimesArea = 0.5 * this.medium.density * flowSpeed * flowSpeed * this.area;
    return target
      .copy(liftDirection)
      .multiplyScalar(dynamicPressureTimesArea * this.polar.liftCoefficient(angleOfAttack))
      .addScaledVector(flowDirection, dynamicPressureTimesArea * this.polar.dragCoefficient(angleOfAttack));
  }
}
