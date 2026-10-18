import { Vector3 } from 'three';
import type { Behavior, Body, World } from 'eulerjs';
import { RaycastVehicle } from '@eulerjs/vehicle';
import type { Wheel } from '@eulerjs/vehicle';
import type { CarLayout } from './carLayout.js';

/** Air density, kg/m³. */
const AIR_DENSITY = 1.2;

const dragForce = new Vector3();

/**
 * A small hatchback's driving: an engine that pushes hard at low speed and with its power beyond,
 * brakes on all four wheels, steering that lightens with speed, a handbrake that locks the rear
 * wheels, and air drag. The wheels themselves, springs and tyres on whatever ground is under
 * them, are a RaycastVehicle from @eulerjs/vehicle.
 */
export class Vehicle implements Behavior {
  /** Engine, from -1 (full reverse) to 1 (full forward). */
  throttle = 0;
  /** Brake pedal, from 0 to 1. */
  brake = 0;
  /** Steering, from -1 (full right) to 1 (full left). */
  steering = 0;
  /** Locks the rear wheels and lets them slide. */
  handbrake = false;
  private readonly raycast: RaycastVehicle;
  private readonly drivenWheelCount: number;

  constructor(private readonly layout: CarLayout) {
    this.raycast = new RaycastVehicle({
      wheels: layout.wheels.map((wheel) => ({
        mount: wheel.mount,
        radius: layout.wheelRadius,
        suspensionLength: layout.suspensionLength,
        springStiffness: layout.springStiffness,
        springDamping: layout.springDamping,
        grip: layout.grip,
        rollingResistance: layout.rollingResistance,
      })),
    });
    this.drivenWheelCount = layout.wheels.filter((wheel) => wheel.driven).length;
  }

  /** The wheels, and what each was doing on the last step. */
  get wheels(): readonly Wheel[] {
    return this.raycast.wheels;
  }

  /** How fast the car is going forward, in m/s; negative when reversing. */
  forwardSpeed(body: Body): number {
    return this.raycast.forwardSpeed(body);
  }

  fixedUpdate(body: Body, timestep: number, world: World): void {
    const speed = this.forwardSpeed(body);
    const steerAngle = (this.steering * this.layout.maxSteerAngle) / (1 + Math.abs(speed) / this.layout.steerHalvingSpeed);
    const driveForce = this.driveForce(speed) / this.drivenWheelCount;
    this.layout.wheels.forEach((layout, index) => {
      const wheel = this.raycast.wheels[index]!;
      const rearLocked = this.handbrake && !layout.steered;
      wheel.steerAngle = layout.steered ? steerAngle : 0;
      wheel.driveForce = layout.driven ? driveForce : 0;
      wheel.brakeForce = ((rearLocked ? 1 : this.brake) * this.layout.brakeForce) / this.layout.wheels.length;
      wheel.grip = rearLocked ? this.layout.handbrakeGrip : this.layout.grip;
    });
    this.raycast.fixedUpdate(body, timestep, world);
    this.applyAirDrag(body);
  }

  /** Force at the driven wheels: the engine's full push at low speed, its power over the speed beyond. */
  private driveForce(speed: number): number {
    if (this.throttle === 0) return 0;
    const pushLimit = this.layout.enginePower / Math.max(Math.abs(speed), 1);
    const force = Math.min(this.layout.engineForce, pushLimit) * this.throttle;
    return this.throttle < 0 ? force * this.layout.reverseFraction : force;
  }

  private applyAirDrag(body: Body): void {
    const airSpeed = body.velocity.length();
    body.applyForce(dragForce.copy(body.velocity).multiplyScalar(-0.5 * AIR_DENSITY * this.layout.dragArea * airSpeed));
  }
}
