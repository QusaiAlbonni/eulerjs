import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, JavaScriptBackend, MassProperties, PlaneCollider, World } from '@eulerjs/core';
import type { JavaScriptBackendOptions } from '@eulerjs/core';
import { RaycastVehicle } from '@eulerjs/vehicle';
import type { WheelOptions } from '@eulerjs/vehicle';

const gravity = 9.81;
const mass = 800;
const grip = 1.5;
const chassisSize = new Vector3(1.8, 0.6, 4);
const wheelRadius = 0.33;
const suspensionLength = 0.3;
const springStiffness = 60_000;
const mounts = [new Vector3(0.8, -0.2, 1.3), new Vector3(-0.8, -0.2, 1.3), new Vector3(0.8, -0.2, -1.3), new Vector3(-0.8, -0.2, -1.3)];
const rideHeight = -mounts[0]!.y + suspensionLength - (mass * gravity) / 4 / springStiffness + wheelRadius;
/** Its weight carried low, about 0.3 m off the ground as a racing car's is: higher, it would roll over before its tyres slid. */
const centerOfMass = new Vector3(0, -0.4, 0);
/** What the drive or the brakes speed up or slow down: the car, and its four wheels' spin, each as I / r² more mass. */
const drivenMass = mass + (4 * 1) / wheelRadius ** 2;
/** The share of its peak a slip tyre pulls with locked: at a slip ratio of −1, ten times its peak slip ratio of 0.1. */
const lockedShare = (slidingGrip = 0.75) => {
  const shape = 2 - (2 / Math.PI) * Math.asin(slidingGrip);
  return Math.sin(shape * Math.atan(Math.tan(Math.PI / (2 * shape)) * 10));
};

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('slip tyres (%s)', (solver) => {
  const makeWorld = (ground?: Body) => {
    const world = new World({ backend: new JavaScriptBackend({ solver }), timestep: 1 / 120 });
    world.addBody(ground ?? new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9 })] }));
    return world;
  };
  const car = (world: World, wheelOptions: Partial<WheelOptions> = {}, position = new Vector3(0, rideHeight, 0), quaternion = new Quaternion()) => {
    const body = world.addBody(
      new Body({ massProperties: MassProperties.box(chassisSize, mass, centerOfMass), position, quaternion, canSleep: false, colliders: [new BoxCollider({ size: chassisSize })] }),
    );
    const vehicle = body.addBehavior(
      new RaycastVehicle({
        tyres: 'slip',
        wheels: mounts.map((mount) => ({ mount, radius: wheelRadius, suspensionLength, springStiffness, springDamping: 6000, rollingResistance: 0, grip, loadSensitivity: 0, ...wheelOptions })),
      }),
    );
    return { body, vehicle };
  };
  const runFor = (world: World, seconds: number, eachStep?: () => void) => {
    for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
      eachStep?.();
      world.fixedStep();
    }
  };
  /** Sets the car going forward at `speed`, its wheels rolling with it. */
  const rolling = (body: Body, vehicle: RaycastVehicle, speed: number) => {
    body.velocity.set(0, 0, speed);
    for (const wheel of vehicle.wheels) wheel.spinSpeed = speed / wheelRadius;
  };
  /** The car's mean acceleration along its way over `seconds`, in m/s². */
  const accelerationOver = (world: World, body: Body, vehicle: RaycastVehicle, seconds: number, eachStep?: () => void) => {
    const before = vehicle.forwardSpeed(body);
    runFor(world, seconds, eachStep);
    return (vehicle.forwardSpeed(body) - before) / seconds;
  };

  it('accelerates at its drive within its grip, and slower spinning its wheels past their peak', () => {
    const gripping = makeWorld();
    const steady = car(gripping);
    runFor(gripping, 1);
    rolling(steady.body, steady.vehicle, 10);
    // four tenths of what its tyres can take, shared by four wheels: within what the front ones
    // can take too, unloaded as the car squats onto its rear wheels
    for (const wheel of steady.vehicle.wheels) wheel.driveTorque = (0.4 * grip * mass * gravity * wheelRadius) / 4;
    runFor(gripping, 0.3);
    const driveForce = 0.4 * grip * mass * gravity;
    expect(Math.abs(accelerationOver(gripping, steady.body, steady.vehicle, 0.5) / (driveForce / drivenMass) - 1)).toBeLessThan(0.02);
    for (const wheel of steady.vehicle.wheels) {
      expect(wheel.sliding).toBe(false);
      expect(wheel.slipRatio).toBeGreaterThan(0);
      expect(wheel.slipRatio).toBeLessThan(0.1);
    }

    const spinning = makeWorld();
    const floored = car(spinning);
    runFor(spinning, 1);
    rolling(floored.body, floored.vehicle, 10);
    for (const wheel of floored.vehicle.wheels) wheel.driveTorque = (4 * grip * mass * gravity * wheelRadius) / 4;
    runFor(spinning, 0.3);
    const acceleration = accelerationOver(spinning, floored.body, floored.vehicle, 0.5);
    // past the peak the tyres slide: less than they could pull, more than sliding grip alone
    expect(acceleration).toBeLessThan(0.95 * grip * gravity);
    expect(acceleration).toBeGreaterThan(0.75 * grip * gravity);
    for (const wheel of floored.vehicle.wheels) {
      expect(wheel.sliding).toBe(true);
      expect(wheel.slipRatio).toBeGreaterThan(0.3);
    }
  });

  it('brakes hardest short of locking, and locked slides to a stop at its sliding grip, wheels still', () => {
    const world = makeWorld();
    const { body, vehicle } = car(world);
    runFor(world, 1);
    rolling(body, vehicle, 30);
    // within what the rear tyres can take too, unloaded as the car dives onto its front wheels
    for (const wheel of vehicle.wheels) wheel.brakeTorque = (0.4 * grip * mass * gravity * wheelRadius) / 4;
    runFor(world, 0.3);
    const brakingForce = 0.4 * grip * mass * gravity;
    expect(Math.abs(-accelerationOver(world, body, vehicle, 0.5) / (brakingForce / drivenMass) - 1)).toBeLessThan(0.02);
    expect(vehicle.wheels.every((wheel) => wheel.slipRatio < 0 && wheel.slipRatio > -0.1 && wheel.spinSpeed > 0)).toBe(true);

    const locking = makeWorld();
    const locked = car(locking);
    runFor(locking, 1);
    rolling(locked.body, locked.vehicle, 30);
    for (const wheel of locked.vehicle.wheels) wheel.brakeTorque = 20_000;
    runFor(locking, 0.3);
    const deceleration = -accelerationOver(locking, locked.body, locked.vehicle, 0.5);
    expect(deceleration / (lockedShare() * grip * gravity)).toBeCloseTo(1, 1);
    for (const wheel of locked.vehicle.wheels) {
      expect(wheel.spinSpeed).toBe(0);
      expect(wheel.slipRatio).toBeCloseTo(-1, 6);
      expect(wheel.sliding).toBe(true);
    }
    runFor(locking, 3);
    // stopped, and stays stopped: the brake never turned a wheel backward
    expect(Math.abs(locked.vehicle.forwardSpeed(locked.body))).toBeLessThan(1e-3);
    expect(locked.vehicle.wheels.every((wheel) => wheel.spinSpeed >= 0)).toBe(true);
  });

  it('corners no harder than its grip allows, close to it at the limit', () => {
    const world = makeWorld();
    const { body, vehicle } = car(world);
    runFor(world, 1);
    const speed = 20;
    rolling(body, vehicle, speed);
    const previousVelocity = body.velocity.clone();
    const acceleration = new Vector3();
    let hardest = 0;
    let steering = 0;
    runFor(world, 6, () => {
      // steering wound on slowly, the rear wheels holding the speed
      steering = Math.min(steering + 0.25 * world.timestep, 0.25);
      vehicle.wheels[0]!.steerAngle = vehicle.wheels[1]!.steerAngle = steering;
      const push = 4000 * (speed - body.velocity.length());
      vehicle.wheels[2]!.driveTorque = vehicle.wheels[3]!.driveTorque = Math.max(push, 0) * wheelRadius;
      // the car's acceleration over the ground, cornering and driving: whatever it does, its tyres
      // can't push it harder than their grip
      acceleration.subVectors(body.velocity, previousVelocity).divideScalar(world.timestep).setY(0);
      previousVelocity.copy(body.velocity);
      hardest = Math.max(hardest, acceleration.length());
    });
    expect(hardest / (grip * gravity)).toBeGreaterThan(0.85);
    expect(hardest / (grip * gravity)).toBeLessThan(1.05);
  });

  it('grips less for each newton the more it is loaded, as downforce loads it', () => {
    const slideWith = (downforce: number, loadSensitivity: number) => {
      const world = makeWorld();
      const { body, vehicle } = car(world, { loadSensitivity });
      const pressDown = new Vector3(0, -downforce, 0);
      const pressing = () => body.applyForce(pressDown);
      runFor(world, 1, pressing);
      rolling(body, vehicle, 30);
      for (const wheel of vehicle.wheels) wheel.brakeTorque = 50_000;
      runFor(world, 0.3, pressing);
      return -accelerationOver(world, body, vehicle, 0.5, pressing);
    };
    // pressed down with its own weight again: twice the load, and twice the grip at a constant
    // coefficient; 2^−0.1 as much a newton at the default sensitivity
    expect(slideWith(mass * gravity, 0) / slideWith(0, 0)).toBeCloseTo(2, 1);
    expect(slideWith(mass * gravity, 0.1) / slideWith(0, 0.1) / (2 * 2 ** -0.1)).toBeCloseTo(1, 1);
  });

  it('grips as much less as its surface says, on grass or gravel', () => {
    const slideOn = (surfaceGrip: number) => {
      const world = makeWorld();
      const body = world.addBody(
        new Body({ massProperties: MassProperties.box(chassisSize, mass, centerOfMass), position: new Vector3(0, rideHeight, 0), canSleep: false, colliders: [new BoxCollider({ size: chassisSize })] }),
      );
      const vehicle = body.addBehavior(
        new RaycastVehicle({
          tyres: 'slip',
          wheels: mounts.map((mount) => ({ mount, radius: wheelRadius, suspensionLength, springStiffness, springDamping: 6000, rollingResistance: 0, grip, loadSensitivity: 0 })),
          surface: () => ({ grip: surfaceGrip }),
        }),
      );
      runFor(world, 1);
      rolling(body, vehicle, 30);
      for (const wheel of vehicle.wheels) wheel.brakeTorque = 20_000;
      runFor(world, 0.3);
      return -accelerationOver(world, body, vehicle, 0.5);
    };
    expect(slideOn(0.5) / slideOn(1)).toBeCloseTo(0.5, 1);
  });

  it('stands still braked on a slope, and pulls away from a standstill', () => {
    const tilt = 0.2;
    const slope = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -tilt);
    const ramp = new Body({ type: 'static', quaternion: slope, colliders: [new BoxCollider({ size: new Vector3(20, 1, 80), offset: new Vector3(0, -0.5, 0), friction: 0.9 })] });
    const world = makeWorld(ramp);
    const { body, vehicle } = car(world, {}, new Vector3(0, rideHeight + 0.1, 0).applyQuaternion(slope), slope);
    for (const wheel of vehicle.wheels) wheel.brakeTorque = 3000;
    runFor(world, 3);
    expect(body.velocity.length()).toBeLessThan(0.01);
    for (const wheel of vehicle.wheels) {
      wheel.brakeTorque = 0;
      wheel.driveTorque = 1500;
    }
    runFor(world, 2);
    // up the slope, through the hand-over from grip to slip tyres
    expect(vehicle.forwardSpeed(body)).toBeGreaterThan(5);
    expect(vehicle.wheels.every((wheel) => wheel.spinSpeed > 0)).toBe(true);
  });

  it('spins its wheels freely off the ground, driven and braked', () => {
    const world = makeWorld();
    const { body, vehicle } = car(world, { inertia: 2 });
    // hanging in the air, its wheels nowhere near the ground
    body.setPose(new Vector3(0, 50, 0), body.quaternion);
    body.gravityScale = 0;
    for (const wheel of vehicle.wheels) wheel.driveTorque = 100;
    runFor(world, 1);
    for (const wheel of vehicle.wheels) expect(wheel.spinSpeed).toBeCloseTo(100 / 2, 6);
    for (const wheel of vehicle.wheels) {
      wheel.driveTorque = 0;
      wheel.brakeTorque = 400;
    }
    runFor(world, 1);
    expect(vehicle.wheels.every((wheel) => wheel.spinSpeed === 0)).toBe(true);
  });

  it('refuses a sliding grip outside (0, 1)', () => {
    const world = makeWorld();
    expect(() => car(world, { slidingGrip: 1 })).toThrow(RangeError);
  });
});
