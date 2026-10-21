import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { Body, BoxCollider, MassProperties, SphereCollider } from '@eulerjs/core';
import type { Behavior, Collider, World } from '@eulerjs/core';
import { RaycastVehicle } from '@eulerjs/vehicle';
import type { GroundSurface, Wheel, WheelOptions } from '@eulerjs/vehicle';
import { Aerodynamics } from './Aerodynamics.js';
import { Powertrain } from './Powertrain.js';
import { SPECIFICATION } from './specification.js';

const { wheel: wheelSpecification, tyre, suspension, brakes, steering } = SPECIFICATION;

/** What the driver does, set as often as they like; read every physics step. */
export interface DriverInput {
  /** 0 to 1. */
  throttle: number;
  /** 0 to 1. */
  brake: number;
  /** −1 to 1, positive to the left. */
  steer: number;
  /** Set to shift once; the car clears them. */
  shiftUp: boolean;
  shiftDown: boolean;
  drs: boolean;
}

/** The wheels in order. */
export const FRONT_LEFT = 0;
export const FRONT_RIGHT = 1;
export const REAR_LEFT = 2;
export const REAR_RIGHT = 3;

/**
 * How far past its peak a tyre may slip, along and across together, before the assists ease off
 * it: a tyre's grip is shared between pulling and cornering, so a wheel spinning up only a little
 * mid-corner can leave too little grip to hold the car's tail.
 */
const ASSIST_SLIP = 1.05;
/** How quickly traction control eases the drive off and back on, in seconds. */
const TRACTION_RESPONSE = 0.03;

const gravity = 9.81;
const frontAxleZ = SPECIFICATION.wheelbase * (1 - SPECIFICATION.frontWeightShare);
const rearAxleZ = -SPECIFICATION.wheelbase * SPECIFICATION.frontWeightShare;

/** Where each wheel's suspension is mounted, so that standing still the car's weight sets it at its ride height. */
export function wheelOptions(): WheelOptions[] {
  // the wheels' centres stand a wheel's radius off the ground, the centre of mass at its height
  const wheelCenterY = wheelSpecification.radius - SPECIFICATION.centerOfMassHeight;
  const axle = (along: number, track: number, stiffness: number, damping: number, inertia: number, weightShare: number, grip: number): WheelOptions[] => {
    const compression = (SPECIFICATION.mass * gravity * weightShare) / 2 / stiffness;
    const mountY = wheelCenterY + suspension.travel - compression;
    return [track / 2, -track / 2].map((across) => ({
      mount: new Vector3(across, mountY, along),
      radius: wheelSpecification.radius,
      suspensionLength: suspension.travel,
      springStiffness: stiffness,
      springDamping: damping,
      inertia,
      grip,
      peakSlipAngle: tyre.peakSlipAngle,
      peakSlipRatio: tyre.peakSlipRatio,
      slidingGrip: tyre.slidingGrip,
      loadSensitivity: tyre.loadSensitivity,
      nominalLoad: tyre.nominalLoad,
      rollingResistance: tyre.rollingResistance,
    }));
  };
  return [
    ...axle(frontAxleZ, SPECIFICATION.frontTrack, suspension.frontStiffness, suspension.frontDamping, wheelSpecification.frontInertia, SPECIFICATION.frontWeightShare, tyre.grip),
    ...axle(rearAxleZ, SPECIFICATION.rearTrack, suspension.rearStiffness, suspension.rearDamping, wheelSpecification.rearInertia, 1 - SPECIFICATION.frontWeightShare, tyre.rearGrip),
  ];
}

/** The collision group the cars are in: the track and everything by it are in the default, group 1. */
export const CAR_GROUP = 2;

/**
 * The car's shape for collisions: as its own body has it, and, `onlyCars`, as another player's
 * car does, which touches no track or wall, its own player's world seeing to those, only cars.
 */
export function carColliders(onlyCars = false): Collider[] {
  const groups = { collisionGroups: CAR_GROUP, ...(onlyCars ? { collidesWith: CAR_GROUP } : {}) };
  // the floor, a few centimetres off the ground, and the body up to the cockpit
  const floor = new BoxCollider({ size: new Vector3(1.4, 0.3, 4.8), offset: new Vector3(0, -SPECIFICATION.centerOfMassHeight + 0.05 + 0.15, 0.25), friction: 0.4, ...groups });
  // and a ball in each wheel, smaller than it so as never to touch the ground: the wheels stand
  // out beyond the floor, and would go through a wall that the floor didn't reach
  const wheels = wheelOptions().map((wheel) => new SphereCollider({ radius: 0.24, offset: new Vector3(wheel.mount.x, wheelSpecification.radius - SPECIFICATION.centerOfMassHeight, wheel.mount.z), friction: 0.3, ...groups }));
  return [floor, ...wheels];
}

/**
 * A Formula 1 car: one body on four slip-tyred wheels, its engine driving the rear ones through
 * an eight-speed gearbox and a limited-slip differential, the air pressing it down and holding it
 * back. The driver's input goes in `input`; traction control and ABS help a driver on a keyboard.
 */
export class F1Car implements Behavior {
  readonly body: Body;
  readonly vehicle: RaycastVehicle;
  readonly aerodynamics: Aerodynamics;
  readonly powertrain = new Powertrain();
  readonly input: DriverInput = { throttle: 0, brake: 0, steer: 0, shiftUp: false, shiftDown: false, drs: false };
  /** Driver aids, off in a real car: they ease off a wheel spinning up or locking past its peak. */
  tractionControl = true;
  antiLock = true;
  /** How much traction control and ABS held back on the last step, 0 to 1: for the dashboard. */
  tractionCut = 0;
  antiLockCut = 0;

  /** `surface`: what the ground is like where each wheel touches it, as `RaycastVehicleOptions.surface`. */
  constructor(world: World, object: Object3D, position: Vector3, heading = 0, surface?: (point: Vector3) => GroundSurface) {
    const size = SPECIFICATION.inertiaBox;
    this.body = world.addBody(
      new Body({
        object,
        massProperties: MassProperties.box(new Vector3(size.width, size.height, size.length), SPECIFICATION.mass),
        position: new Vector3(position.x, position.y + SPECIFICATION.centerOfMassHeight, position.z),
        quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading),
        colliders: carColliders(),
        canSleep: false,
      }),
    );
    // the car's own step first, setting the wheels' torques for the tyres to act on
    this.body.addBehavior(this);
    this.vehicle = this.body.addBehavior(new RaycastVehicle({ tyres: 'slip', wheels: wheelOptions(), surface }));
    this.aerodynamics = this.body.addBehavior(new Aerodynamics(new Vector3(0, 0, frontAxleZ), new Vector3(0, 0, rearAxleZ)));
  }

  /** Forward speed, in m/s. */
  get speed(): number {
    return this.vehicle.forwardSpeed(this.body);
  }

  fixedUpdate(_body: Body, timestep: number): void {
    const input = this.input;
    const wheels = this.vehicle.wheels;
    this.steer(input.steer * steering.maxAngle);

    const [leftTorque, rightTorque] = this.powertrain.update(input, wheels[REAR_LEFT]!.spinSpeed, wheels[REAR_RIGHT]!.spinSpeed, timestep);
    // the engine turns with the rear wheels through the gear, and they must spin it up with them
    const engineInertia = this.powertrain.inertiaAtWheels() / 2;
    wheels[REAR_LEFT]!.inertia = wheelSpecification.rearInertia + engineInertia;
    wheels[REAR_RIGHT]!.inertia = wheelSpecification.rearInertia + engineInertia;
    input.shiftUp = false;
    input.shiftDown = false;
    // traction control eases the drive while a rear tyre, spinning up, slips past its peak: over
    // a few hundredths of a second, as a real one does, rather than all or nothing each step,
    // which would set the wheels' spin and the engine's revs flickering
    const spinningUp = Math.max(combinedSlip(wheels[REAR_LEFT]!, 1), combinedSlip(wheels[REAR_RIGHT]!, 1));
    const wantedCut = this.tractionControl && input.throttle > 0 ? easing(spinningUp) : 0;
    this.tractionCut += (wantedCut - this.tractionCut) * Math.min(timestep / TRACTION_RESPONSE, 1);
    wheels[REAR_LEFT]!.driveTorque = leftTorque * (1 - this.tractionCut);
    wheels[REAR_RIGHT]!.driveTorque = rightTorque * (1 - this.tractionCut);

    // ABS eases each wheel's brake while its tyre, locking, slips past its peak
    this.antiLockCut = 0;
    wheels.forEach((wheel, index) => {
      const most = index < REAR_LEFT ? brakes.frontTorque : brakes.rearTorque;
      const cut = this.antiLock ? easing(combinedSlip(wheel, -1)) : 0;
      this.antiLockCut = Math.max(this.antiLockCut, input.brake > 0 ? cut : 0);
      wheel.brakeTorque = input.brake * most * (1 - cut);
    });
    this.aerodynamics.drsOpen = input.drs;
  }

  /** Turns the front wheels for a turn of `angle` (positive left), the inside one further, as Ackermann's steering does. */
  private steer(angle: number): void {
    const wheels = this.vehicle.wheels;
    if (Math.abs(angle) < 1e-6) {
      wheels[FRONT_LEFT]!.steerAngle = wheels[FRONT_RIGHT]!.steerAngle = 0;
      return;
    }
    const radius = SPECIFICATION.wheelbase / Math.tan(Math.abs(angle));
    const inside = Math.atan(SPECIFICATION.wheelbase / (radius - SPECIFICATION.frontTrack / 2)) * Math.sign(angle);
    const outside = Math.atan(SPECIFICATION.wheelbase / (radius + SPECIFICATION.frontTrack / 2)) * Math.sign(angle);
    // turning left, the left wheel is inside
    wheels[FRONT_LEFT]!.steerAngle = angle > 0 ? inside : outside;
    wheels[FRONT_RIGHT]!.steerAngle = angle > 0 ? outside : inside;
  }

  /** Puts the car back on its wheels, still, at `position` facing `heading`. */
  reset(position: Vector3, heading: number): void {
    this.body.setPose(new Vector3(position.x, position.y + SPECIFICATION.centerOfMassHeight, position.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading));
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    for (const wheel of this.vehicle.wheels) wheel.spinSpeed = 0;
    this.powertrain.gear = 1;
  }
}

/**
 * How far a tyre slips along and across together, as a share of its peak: 1 at the peak. Only
 * while it slips the way `sign` says along it, +1 spinning up, −1 locking; 0 otherwise.
 */
function combinedSlip(wheel: Wheel, sign: number): number {
  if (!wheel.onGround || wheel.slipRatio * sign <= 0) return 0;
  return Math.hypot(wheel.slipRatio / wheel.peakSlipRatio, Math.tan(wheel.slipAngle) / Math.tan(wheel.peakSlipAngle));
}

/** How much an assist eases off a tyre slipping `slip` times its peak: none up to ASSIST_SLIP, nearly all of it a little past. */
function easing(slip: number): number {
  return Math.min(Math.max((slip - ASSIST_SLIP) / 0.3, 0), 0.9);
}
