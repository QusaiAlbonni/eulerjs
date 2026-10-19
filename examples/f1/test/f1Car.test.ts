import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, PlaneCollider, World } from '@eulerjs/core';
import { F1Car, FRONT_LEFT, FRONT_RIGHT } from '../src/car/F1Car.js';
import { SPECIFICATION } from '../src/car/specification.js';
import { SURFACES } from '../src/track/Circuit.js';

// The car against what a Formula 1 car does: its numbers are tuned to land in these ranges.

const gravity = 9.81;
const kilometresPerHour = (metresPerSecond: number) => metresPerSecond * 3.6;

const makeCar = () => {
  const world = new World({ timestep: 1 / 120 });
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 1 })] }));
  const car = new F1Car(world, new Object3D(), new Vector3(0, 0, 0));
  return { world, car };
};
const runFor = (world: World, seconds: number, eachStep?: () => boolean | void) => {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    if (eachStep?.() === true) return step * world.timestep;
    world.fixedStep();
  }
  return seconds;
};

describe('the F1 car', () => {
  it('shifts up through every gear in turn flat out, once each, and each upshift at speed kicks it on, the engine giving up its revs', () => {
    const { world, car } = makeCar();
    car.input.throttle = 1;
    const shifts: number[] = [];
    const kicks: number[] = [];
    let gear = car.powertrain.gear;
    let lastSpeed = car.speed;
    let before = 0;
    let since = Infinity;
    let peak = 0;
    runFor(world, 16, () => {
      const acceleration = (car.speed - lastSpeed) / world.timestep;
      lastSpeed = car.speed;
      if (car.powertrain.gear !== gear) {
        shifts.push(car.powertrain.gear);
        gear = car.powertrain.gear;
        since = 0;
        peak = 0;
      } else if (since < 0.1) {
        peak = Math.max(peak, acceleration);
        since += world.timestep;
        // through the shift settling, against the pull just before it
        if (since >= 0.1 && gear >= 5) kicks.push(peak / before);
      } else before = acceleration;
    });
    expect(shifts).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(kicks.length).toBeGreaterThan(1);
    for (const kick of kicks) expect(kick).toBeGreaterThan(1.1);
  });

  it.each(['asphalt', 'grass'] as const)('flat out on %s, its revs climb and fall smoothly, through the gears and spinning its wheels, never leaping', (surface) => {
    const world = new World({ timestep: 1 / 120 });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 1 })] }));
    const car = new F1Car(world, new Object3D(), new Vector3(), 0, () => SURFACES[surface]);
    world.fixedStep();
    car.input.throttle = 1;
    // a second to pull away, the revs held up by the slipping clutch
    runFor(world, 1);
    let last = car.powertrain.rpm;
    let largest = 0;
    let shifts = 0;
    let gear = car.powertrain.gear;
    runFor(world, 7, () => {
      largest = Math.max(largest, Math.abs(car.powertrain.rpm - last));
      last = car.powertrain.rpm;
      if (car.powertrain.gear !== gear) shifts++;
      gear = car.powertrain.gear;
    });
    expect(shifts).toBeGreaterThan(1);
    // a 120th of a second: the engine's inertia, and a shift's settling, keep it to a few hundred rpm
    expect(largest).toBeLessThan(700);
  });

  it('stands at its ride height, its weight shared as the specification says', () => {
    const { world, car } = makeCar();
    runFor(world, 2);
    expect(car.body.position.y).toBeCloseTo(SPECIFICATION.centerOfMassHeight, 2);
    const loads = car.vehicle.wheels.map((wheel) => wheel.load);
    const total = loads.reduce((sum, load) => sum + load, 0);
    expect(total / (SPECIFICATION.mass * gravity)).toBeCloseTo(1, 2);
    expect((loads[FRONT_LEFT]! + loads[FRONT_RIGHT]!) / total).toBeCloseTo(SPECIFICATION.frontWeightShare, 2);
  });

  it('pulls away to 100 km/h in under three seconds, and on to a top speed of 330 to 365 km/h, more with DRS', () => {
    const { world, car } = makeCar();
    runFor(world, 1);
    car.input.throttle = 1;
    const toHundred = runFor(world, 10, () => kilometresPerHour(car.speed) >= 100);
    expect(toHundred).toBeGreaterThan(2.2);
    expect(toHundred).toBeLessThan(3.2);
    runFor(world, 50);
    const topSpeed = kilometresPerHour(car.speed);
    expect(topSpeed).toBeGreaterThan(330);
    expect(topSpeed).toBeLessThan(365);
    expect(car.powertrain.gear).toBe(SPECIFICATION.gearbox.ratios.length);
    car.input.drs = true;
    runFor(world, 30);
    expect(kilometresPerHour(car.speed)).toBeGreaterThan(topSpeed + 5);
  });

  it('stops from 200 km/h in 45 to 75 metres, decelerating at nearly 3 g at first, on its downforce', () => {
    const { world, car } = makeCar();
    runFor(world, 1);
    car.input.throttle = 1;
    runFor(world, 20, () => kilometresPerHour(car.speed) >= 200);
    car.input.throttle = 0;
    car.input.brake = 1;
    const start = car.body.position.clone();
    const startSpeed = car.speed;
    runFor(world, 0.2);
    const firstDeceleration = (startSpeed - car.speed) / 0.2;
    runFor(world, 10, () => car.speed < 0.1);
    const distance = car.body.position.distanceTo(start);
    // at 200 km/h the downforce is about the car's weight: twice the load, a little less than
    // twice the grip, and the drag besides
    expect(firstDeceleration / gravity).toBeGreaterThan(2.8);
    expect(distance).toBeGreaterThan(45);
    expect(distance).toBeLessThan(75);
  });

  it('corners at nearly 3 g or more at 200 km/h, on its downforce', () => {
    const { world, car } = makeCar();
    runFor(world, 1);
    car.input.throttle = 1;
    runFor(world, 20, () => kilometresPerHour(car.speed) >= 200);
    const target = car.speed;
    const previousVelocity = car.body.velocity.clone();
    const acceleration = new Vector3();
    const across = new Vector3();
    let hardest = 0;
    runFor(world, 8, () => {
      // steering wound on slowly, the throttle and brake holding the speed
      car.input.steer = Math.min(car.input.steer + 0.06 * world.timestep, 0.5);
      const short = target - car.speed;
      car.input.throttle = Math.min(Math.max(short * 0.5, 0), 1);
      car.input.brake = Math.min(Math.max(-short * 0.2, 0), 1);
      acceleration.subVectors(car.body.velocity, previousVelocity).divideScalar(world.timestep);
      previousVelocity.copy(car.body.velocity);
      // its sideways part, square to where the car is going
      across.set(-car.body.velocity.z, 0, car.body.velocity.x).normalize();
      hardest = Math.max(hardest, Math.abs(acceleration.dot(across)));
    });
    // a little short of what the tyres could give: the car is set up so that at the limit its
    // front tyres give up first, and it runs wide rather than spinning
    expect(hardest / gravity).toBeGreaterThan(2.7);
    expect(hardest / gravity).toBeLessThan(5.5);
  });
});
