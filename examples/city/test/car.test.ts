import { Vector3 } from 'three';
import { Body, PlaneCollider, World } from 'eulerjs';
import { describe, expect, it } from 'vitest';
import { CAR_LAYOUT } from '../src/car/carLayout.js';
import { createCarPhysics, rideHeight } from '../src/car/createCarPhysics.js';
import type { CarPhysics } from '../src/car/createCarPhysics.js';

/** The car on an empty, flat test track: its springs, engine, brakes and tyres against real cars'. */

const gravity = 9.81;
const wheelbase = CAR_LAYOUT.wheels[0]!.mount.z - CAR_LAYOUT.wheels[2]!.mount.z;

interface TestTrack extends CarPhysics {
  readonly world: World;
}

function testTrack(): TestTrack {
  const world = new World();
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9 })] }));
  return { world, ...createCarPhysics({ world }) };
}

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

/** Direction the car points, in degrees from +z toward +x. */
function headingDegrees(body: Body): number {
  const forward = body.directionToWorld(new Vector3(0, 0, 1));
  return (Math.atan2(forward.x, forward.z) * 180) / Math.PI;
}

/** How far the car leans from upright, in degrees. */
function tiltDegrees(body: Body): number {
  return (body.directionToWorld(new Vector3(0, 1, 0)).angleTo(new Vector3(0, 1, 0)) * 180) / Math.PI;
}

/** Gets the car rolling straight ahead at `speed` m/s. */
function rolling(speed: number): TestTrack {
  const track = testTrack();
  track.body.velocity.set(0, 0, speed);
  runFor(track.world, 0.3);
  return track;
}

describe('the car', () => {
  it('stands at the ride height where its springs carry its weight', () => {
    const { world, body, vehicle } = testTrack();
    runFor(world, 3);
    expect(body.position.y).toBeCloseTo(rideHeight(CAR_LAYOUT), 3);
    const totalLoad = vehicle.wheels.reduce((sum, wheel) => sum + wheel.load, 0);
    expect(Math.abs(totalLoad / (CAR_LAYOUT.mass * gravity) - 1)).toBeLessThan(0.005);
    // the engine sits forward, so the front tyres carry more of the weight
    expect(vehicle.wheels[0]!.load).toBeGreaterThan(vehicle.wheels[2]!.load);
    expect(body.velocity.length()).toBeLessThan(0.001);
  });

  it('accelerates like a small hatchback, in a straight line', () => {
    const { world, body, vehicle } = testTrack();
    runFor(world, 1);
    vehicle.throttle = 1;
    let reachedHundred: number | undefined;
    const startTime = world.time;
    runFor(world, 15, () => {
      if (reachedHundred === undefined && vehicle.forwardSpeed(body) > 100 / 3.6) reachedHundred = world.time - startTime;
    });
    expect(reachedHundred).toBeGreaterThan(8);
    expect(reachedHundred).toBeLessThan(12);
    expect(Math.abs(body.position.x)).toBeLessThan(0.001);
    expect(Math.abs(headingDegrees(body))).toBeLessThan(0.01);
  });

  it('brakes to a stop, without the brakes pulling it backwards', () => {
    const { world, body, vehicle } = rolling(20);
    const startZ = body.position.z;
    const startSpeed = body.velocity.z;
    vehicle.brake = 1;
    runFor(world, 5);
    const distance = body.position.z - startZ;
    // braking at 0.9 g would take v²/2a; weight shifting forward off the rear tyres costs some of it
    expect(distance).toBeGreaterThan(startSpeed ** 2 / (2 * 0.9 * gravity));
    expect(distance).toBeLessThan(startSpeed ** 2 / (2 * 0.6 * gravity));
    expect(body.velocity.length()).toBeLessThan(0.01);
  });

  it('reverses', () => {
    const { world, body, vehicle } = testTrack();
    vehicle.throttle = -1;
    runFor(world, 2);
    expect(vehicle.forwardSpeed(body)).toBeLessThan(-2);
  });

  it('turns on the circle its steering geometry gives at walking pace', () => {
    const { world, body, vehicle } = rolling(3);
    vehicle.steering = 1;
    runFor(world, 2);
    const speed = body.velocity.length();
    const radius = speed / Math.abs(body.angularVelocity.y);
    const steerAngle = CAR_LAYOUT.maxSteerAngle / (1 + speed / CAR_LAYOUT.steerHalvingSpeed);
    // the tyres slip a little, which widens the circle
    expect(radius / (wheelbase / Math.tan(steerAngle))).toBeGreaterThan(1);
    expect(radius / (wheelbase / Math.tan(steerAngle))).toBeLessThan(1.15);
    // positive steering is to the left: toward +x when heading along +z
    expect(headingDegrees(body)).toBeGreaterThan(0);
  });

  it('corners no harder than its tyres grip, leaning on its springs, at most lifting an inside rear wheel', () => {
    for (const speed of [10, 20]) {
      const { world, body, vehicle } = rolling(speed);
      vehicle.steering = 1;
      let mostTilt = 0;
      let fewestWheelsDown = 4;
      const liftedWheels = new Set<number>();
      let sidewaysAcceleration = 0;
      let samples = 0;
      const previousVelocity = body.velocity.clone();
      runFor(world, 4, () => {
        vehicle.throttle = Math.max(-1, Math.min(1, speed - body.velocity.length()));
        mostTilt = Math.max(mostTilt, tiltDegrees(body));
        fewestWheelsDown = Math.min(fewestWheelsDown, vehicle.wheels.filter((wheel) => wheel.onGround).length);
        vehicle.wheels.forEach((wheel, index) => !wheel.onGround && liftedWheels.add(index));
        // once the turn has settled, the acceleration across the direction of travel
        if (world.time > 2) {
          const acceleration = body.velocity.clone().sub(previousVelocity).divideScalar(world.timestep).setY(0);
          const across = new Vector3(-body.velocity.z, 0, body.velocity.x).normalize();
          sidewaysAcceleration += Math.abs(acceleration.dot(across));
          samples++;
        }
        previousVelocity.copy(body.velocity);
      });
      const cornering = sidewaysAcceleration / samples / gravity;
      expect(cornering).toBeLessThan(CAR_LAYOUT.grip * 1.02);
      expect(cornering).toBeGreaterThan(0.7);
      expect(mostTilt).toBeLessThan(10);
      // like a front-heavy hatchback on the limit, it may cock the inside rear wheel, the third one (left)
      expect(fewestWheelsDown).toBeGreaterThanOrEqual(3);
      expect([...liftedWheels].every((index) => index === 2)).toBe(true);
    }
  });

  it.each([1, 2, 3])('swerves from full left lock to full right without rolling over, after pulling away for %i s', (pullAway) => {
    // flat out, the wheel turned as the keyboard turns it: toward full lock at 2.5 a second
    const { world, body, vehicle } = testTrack();
    let leastUpright = 1;
    runFor(world, pullAway + 4, () => {
      vehicle.throttle = 1;
      const target = world.time < pullAway ? 0 : world.time < pullAway + 1.5 ? 1 : -1;
      vehicle.steering += Math.max(-2.5 * world.timestep, Math.min(2.5 * world.timestep, target - vehicle.steering));
      leastUpright = Math.min(leastUpright, body.directionToWorld(new Vector3(0, 1, 0)).y);
    });
    expect(leastUpright).toBeGreaterThan(0.9);
  });

  it('spins round on the handbrake without rolling over', () => {
    const { world, body, vehicle } = rolling(15);
    vehicle.steering = 1;
    vehicle.handbrake = true;
    runFor(world, 1.5);
    expect(Math.abs(headingDegrees(body))).toBeGreaterThan(120);
    expect(tiltDegrees(body)).toBeLessThan(10);
  });

  it('lets its wheels hang and the car fall when it is off the ground', () => {
    const { world, body, vehicle } = testTrack();
    body.setPose(new Vector3(0, 5, 0), body.quaternion);
    world.fixedStep();
    expect(vehicle.wheels.every((wheel) => !wheel.onGround && wheel.load === 0)).toBe(true);
    expect(body.velocity.y).toBeCloseTo(-gravity * world.timestep, 6);
  });
});
