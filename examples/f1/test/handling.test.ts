import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, PlaneCollider, World } from '@eulerjs/core';
import { F1Car } from '../src/car/F1Car.js';
import { keyboardSteeringLock } from '../src/ui/DriverControls.js';

// The car driven as the keyboard drives it, pedals and steering all or nothing but ramped in and
// out, through what a driver does on a lap. With the assists on, as they are by default, it must
// never spin: how far it slides is its sideslip, the angle between where it points and where it
// goes, a few degrees cornering hard, ten or more sliding, thirty spun.

interface Pedals {
  throttle: number;
  brake: number;
  steer: number;
}

const approach = (value: number, target: number, rate: number, timestep: number) => {
  const step = rate * timestep;
  return Math.abs(target - value) <= step ? target : value + Math.sign(target - value) * step;
};

/** The worst sideslip, in degrees, driving `keys` for `seconds` from `startSpeed` in m/s. */
function worstSideslip(startSpeed: number, keys: (time: number) => Pedals, seconds: number): number {
  const world = new World({ timestep: 1 / 120 });
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 1 })] }));
  const car = new F1Car(world, new Object3D(), new Vector3());
  world.fixedStep();
  car.input.throttle = 1;
  for (let step = 0; step < 120 * 30 && car.speed < startSpeed; step++) world.fixedStep();
  const heading = new Vector3();
  const velocity = new Vector3();
  let worst = 0;
  for (let step = 0; step < seconds * 120; step++) {
    const wanted = keys(step * world.timestep);
    const input = car.input;
    // as DriverControls ramps the keys
    input.throttle = approach(input.throttle, wanted.throttle, wanted.throttle > input.throttle ? 5 : 8, world.timestep);
    input.brake = approach(input.brake, wanted.brake, wanted.brake > input.brake ? 5 : 8, world.timestep);
    const steer = wanted.steer * keyboardSteeringLock(car.speed);
    input.steer = approach(input.steer, steer, Math.abs(steer) > Math.abs(input.steer) ? 2.5 : 4, world.timestep);
    world.fixedStep();
    heading.set(0, 0, 1).applyQuaternion(car.body.quaternion).setY(0).normalize();
    velocity.copy(car.body.velocity).setY(0);
    if (velocity.length() > 3) worst = Math.max(worst, (heading.angleTo(velocity) * 180) / Math.PI);
  }
  return worst;
}

describe('the F1 car on the keys, its assists on', () => {
  const kmh = (speed: number) => speed / 3.6;
  it.each<[string, number, (time: number) => Pedals, number]>([
    ['floored out of a slow corner', kmh(70), () => ({ throttle: 1, brake: 0, steer: -1 }), 2.5],
    ['at full lock round a hairpin, on the throttle', kmh(60), () => ({ throttle: 1, brake: 0, steer: 1 }), 3],
    ['steering into a fast corner', kmh(200), () => ({ throttle: 0.6, brake: 0, steer: -1 }), 3],
    ['lifting off mid-corner', kmh(150), (time) => ({ throttle: time < 1.5 ? 0.6 : 0, brake: 0, steer: -1 }), 3],
    ['braking hard in a straight line', kmh(280), () => ({ throttle: 0, brake: 1, steer: 0 }), 3],
    ['braking into a corner', kmh(250), (time) => ({ throttle: 0, brake: 1, steer: time > 0.8 ? -1 : 0 }), 3],
  ])('stays pointing where it goes %s', (_name, startSpeed, keys, seconds) => {
    expect(worstSideslip(startSpeed, keys, seconds)).toBeLessThan(10);
  });
});
