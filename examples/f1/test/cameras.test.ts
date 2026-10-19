import { Object3D, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { Cameras } from '../src/scene/Cameras.js';

// The views answer the car's acceleration as a driver's head does: pressed back as it pulls, a
// shift's kick setting them nodding, thrown forward as it brakes.

describe('the cameras', () => {
  /** How far behind the car the chase view hangs after `seconds` of `acceleration` in m/s², along the car. */
  function chaseDistance(acceleration: number, seconds: number): number {
    const camera = new PerspectiveCamera();
    const car = new Object3D();
    const cameras = new Cameras(camera, car);
    const frame = 1 / 60;
    let speed = 50;
    for (let step = 0; step < seconds / frame; step++) {
      speed += acceleration * frame;
      car.position.z += speed * frame;
      cameras.update(frame, speed);
    }
    return car.position.z - camera.position.z;
  }

  it('drop the chase view back as the car pulls, and forward as it brakes', () => {
    const steady = chaseDistance(0, 3);
    const pulling = chaseDistance(1.5 * 9.81, 3);
    const braking = chaseDistance(-4 * 9.81, 1);
    // about a fifth of a metre for each g, braking at its share
    expect(pulling - steady).toBeGreaterThan(0.2);
    expect(pulling - steady).toBeLessThan(0.5);
    expect(braking).toBeLessThan(steady - 0.15);
  });
});
