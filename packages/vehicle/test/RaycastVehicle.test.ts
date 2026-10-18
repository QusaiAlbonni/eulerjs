import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, HeightfieldCollider, JavaScriptBackend, MassProperties, PlaneCollider, World } from 'eulerjs';
import type { JavaScriptBackendOptions } from 'eulerjs';
import { RaycastVehicle } from '@eulerjs/vehicle';

const gravity = 9.81;
const mass = 1000;
const chassisSize = new Vector3(1.8, 0.6, 4);
const wheelRadius = 0.3;
const suspensionLength = 0.3;
const springStiffness = 25_000;
// a front and a rear axle, 2.6 m apart, the wheels 1.6 m apart on each
const mounts = [new Vector3(0.8, -0.2, 1.3), new Vector3(-0.8, -0.2, 1.3), new Vector3(0.8, -0.2, -1.3), new Vector3(-0.8, -0.2, -1.3)];
const wheelbase = 2.6;
/** How high the chassis centre stands with its weight shared evenly by its springs. */
const rideHeight = -mounts[0]!.y + suspensionLength - (mass * gravity) / 4 / springStiffness + wheelRadius;

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('ray-cast vehicles (%s)', (solver) => {
  const makeWorld = (ground?: Body) => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(ground ?? new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9 })] }));
    return world;
  };
  const car = (world: World, position = new Vector3(0, rideHeight, 0), quaternion = new Quaternion()) => {
    const body = world.addBody(
      new Body({ massProperties: MassProperties.box(chassisSize, mass), position, quaternion, canSleep: false, colliders: [new BoxCollider({ size: chassisSize })] }),
    );
    const vehicle = body.addBehavior(
      new RaycastVehicle({ wheels: mounts.map((mount) => ({ mount, radius: wheelRadius, suspensionLength, springStiffness, springDamping: 3000, rollingResistance: 0 })) }),
    );
    return { body, vehicle };
  };
  const runFor = (world: World, seconds: number, eachStep?: () => void) => {
    for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
      eachStep?.();
      world.fixedStep();
    }
  };

  it('stands at its ride height with its weight on its springs, and lets its wheels hang off the ground', () => {
    const world = makeWorld();
    const { body, vehicle } = car(world);
    runFor(world, 2);
    expect(body.position.y).toBeCloseTo(rideHeight, 3);
    const totalLoad = vehicle.wheels.reduce((sum, wheel) => sum + wheel.load, 0);
    expect(totalLoad / (mass * gravity)).toBeCloseTo(1, 2);
    for (const wheel of vehicle.wheels) {
      expect(wheel.onGround).toBe(true);
      // drawn touching the ground
      expect(wheel.center.y).toBeCloseTo(wheelRadius, 3);
    }
    body.setPose(new Vector3(0, 5, 0), body.quaternion);
    world.fixedStep();
    expect(vehicle.wheels.every((wheel) => !wheel.onGround && wheel.load === 0)).toBe(true);
    expect(vehicle.wheels[0]!.center.y).toBeCloseTo(5 + mounts[0]!.y - suspensionLength, 6);
  });

  it('stands on its bump stops when its springs are too weak to carry it, wheels on the ground', () => {
    const world = makeWorld();
    const body = world.addBody(new Body({ massProperties: MassProperties.box(chassisSize, mass), position: new Vector3(0, rideHeight, 0), canSleep: false, colliders: [new BoxCollider({ size: chassisSize })] }));
    // springs a tenth as stiff: the weight would squash them four times over
    const vehicle = body.addBehavior(new RaycastVehicle({ wheels: mounts.map((mount) => ({ mount, radius: wheelRadius, suspensionLength, springStiffness: springStiffness / 10, springDamping: 3000 })) }));
    runFor(world, 2);
    // held at the end of the wheels' travel, give or take a few millimetres, and staying there
    const bottomedOut = -mounts[0]!.y + wheelRadius;
    expect(Math.abs(body.position.y - bottomedOut)).toBeLessThan(0.01);
    const restingHeight = body.position.y;
    runFor(world, 2);
    expect(Math.abs(body.position.y - restingHeight)).toBeLessThan(1e-3);
    expect(vehicle.wheels.reduce((sum, wheel) => sum + wheel.load, 0) / (mass * gravity)).toBeCloseTo(1, 1);
    expect(world.contacts).toHaveLength(0);
  });

  it('pulls away at its drive force over its mass, and brakes to a stop without rolling back', () => {
    const world = makeWorld();
    const { body, vehicle } = car(world);
    runFor(world, 1);
    for (const wheel of vehicle.wheels) wheel.driveForce = 1000;
    runFor(world, 0.5);
    const speedBefore = vehicle.forwardSpeed(body);
    runFor(world, 1);
    expect(vehicle.forwardSpeed(body) - speedBefore).toBeCloseTo(4000 / mass, 1);
    for (const wheel of vehicle.wheels) {
      wheel.driveForce = 0;
      wheel.brakeForce = 2000;
    }
    const brakingFrom = vehicle.forwardSpeed(body);
    runFor(world, 0.2);
    expect(brakingFrom - vehicle.forwardSpeed(body)).toBeCloseTo(((8000 / mass) * 0.2), 0);
    runFor(world, 3);
    expect(Math.abs(vehicle.forwardSpeed(body))).toBeLessThan(1e-3);
  });

  it('turns on the circle its steering gives, to the left for a positive angle', () => {
    const world = makeWorld();
    const { body, vehicle } = car(world);
    body.velocity.set(0, 0, 3);
    vehicle.wheels[0]!.steerAngle = vehicle.wheels[1]!.steerAngle = 0.3;
    runFor(world, 2, () => {
      // held at its speed against the drag of turning
      const push = 200 * (3 - body.velocity.length());
      vehicle.wheels[2]!.driveForce = vehicle.wheels[3]!.driveForce = push;
    });
    const radius = body.velocity.length() / Math.abs(body.angularVelocity.y);
    expect(radius / (wheelbase / Math.tan(0.3))).toBeGreaterThan(0.98);
    expect(radius / (wheelbase / Math.tan(0.3))).toBeLessThan(1.1);
    expect(body.angularVelocity.y).toBeGreaterThan(0);
  });

  it('stands on a slope square to it, held by its brakes, as on any ground', () => {
    const tilt = 0.2;
    const slope = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -tilt);
    const ramp = new Body({ type: 'static', quaternion: slope, colliders: [new BoxCollider({ size: new Vector3(20, 1, 40), offset: new Vector3(0, -0.5, 0), friction: 0.9 })] });
    const world = makeWorld(ramp);
    const { body, vehicle } = car(world, new Vector3(0, rideHeight + 0.1, 0).applyQuaternion(slope), slope);
    for (const wheel of vehicle.wheels) wheel.brakeForce = 5000;
    runFor(world, 3);
    expect(body.velocity.length()).toBeLessThan(0.01);
    // square to the slope: its up the slope's normal
    expect(body.directionToWorld(new Vector3(0, 1, 0)).angleTo(new Vector3(0, 1, 0).applyQuaternion(slope))).toBeLessThan(0.01);
    // carrying the share of its weight square to the slope
    const totalLoad = vehicle.wheels.reduce((sum, wheel) => sum + wheel.load, 0);
    expect(totalLoad / (mass * gravity * Math.cos(tilt))).toBeCloseTo(1, 2);
  });

  it('rolls over a heightfield, its wheels following the ground', () => {
    const heights = Array.from({ length: 41 }, (_unused, row) => Array.from({ length: 41 }, () => 0.05 * Math.sin(row * 0.8)));
    const terrain = new Body({ type: 'static', colliders: [new HeightfieldCollider({ heights, cellSize: 1, friction: 0.9 })] });
    const world = makeWorld(terrain);
    const { body, vehicle } = car(world, new Vector3(0, rideHeight + 0.1, -12));
    runFor(world, 1);
    body.velocity.set(0, 0, 5);
    let lowestContact = Infinity;
    let everAirborne = false;
    runFor(world, 4, () => {
      for (const wheel of vehicle.wheels) {
        if (!wheel.onGround) everAirborne = true;
        else lowestContact = Math.min(lowestContact, wheel.contactPoint.y);
      }
    });
    expect(everAirborne).toBe(false);
    // touching the bumps, down into the dips
    expect(lowestContact).toBeLessThan(-0.04);
    expect(body.position.z).toBeGreaterThan(5);
    expect(Math.abs(body.position.x)).toBeLessThan(0.1);
  });

  it('presses on dynamic ground it stands on, and is carried along by moving ground', () => {
    const world = makeWorld();
    const platform = world.addBody(new Body({ position: new Vector3(0, 0.25, 0), canSleep: false, colliders: [new BoxCollider({ size: new Vector3(4, 0.5, 6), friction: 0.9 })], mass: 500 }));
    const { vehicle } = car(world, new Vector3(0, rideHeight + 0.5, 0));
    runFor(world, 2);
    expect(vehicle.wheels.every((wheel) => wheel.ground === platform)).toBe(true);
    // the floor holds up the platform and the car on it
    const floorPush = world.contacts.filter((contact) => contact.bodyA === platform || contact.bodyB === platform).reduce((sum, contact) => sum + contact.normalImpulse, 0) / world.timestep;
    expect(floorPush / ((mass + 500) * gravity)).toBeCloseTo(1, 1);

    const moving = makeWorld(new Body({ type: 'kinematic', velocity: new Vector3(2, 0, 0), colliders: [new BoxCollider({ size: new Vector3(200, 1, 200), offset: new Vector3(0, -0.5, 0), friction: 0.9 })] }));
    const carried = car(moving);
    runFor(moving, 2);
    // sideways to the car, which its tyres don't roll: their grip takes it along
    expect(carried.body.velocity.x).toBeCloseTo(2, 2);
  });
});
