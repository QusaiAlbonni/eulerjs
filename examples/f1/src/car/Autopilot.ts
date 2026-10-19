import { Vector3 } from 'three';
import type { Circuit } from '../track/Circuit.js';
import type { F1Car } from './F1Car.js';
import { SPECIFICATION } from './specification.js';

const { aerodynamics, steering } = SPECIFICATION;
const gravity = 9.81;

/** The share of the tyres' grip it drives on, cornering and braking: a safe driver's, not a racer's. */
const GRIP_USED = 0.78;
/** The tyres' grip, a little under their peak. */
const GRIP = 1.55;
/** How hard it plans to brake, in m/s², with the downforce of the speed it brakes from helping. */
const BRAKING = 26;
/** How far ahead it looks for where to steer, in metres, and more for each m/s. */
const LOOK_AHEAD = 7;
const LOOK_AHEAD_PER_SPEED = 0.42;

const toTarget = new Vector3();
const forward = new Vector3();
const left = new Vector3();

/**
 * A driver for the car, round a circuit's centre line: it works out how fast each corner can be
 * taken, from the grip its downforce gives at speed, and how far back it must brake for it; then
 * holds that speed with the pedals, and steers for a point a little ahead on the line (pure
 * pursuit). For checking the car and the track drive together; and, in time, for cars to race.
 */
export class Autopilot {
  /** The speed it aims for at each of the circuit's samples, in m/s. */
  readonly targetSpeeds: readonly number[];
  private readonly circuit: Circuit;

  constructor(circuit: Circuit) {
    this.circuit = circuit;
    const samples = circuit.samples;
    // the fastest a corner can be taken: v² |curvature| = grip × (g + downforce per kg at v)
    const downforcePerKilogram = (0.5 * aerodynamics.airDensity * aerodynamics.downforceArea) / SPECIFICATION.mass;
    const grip = GRIP * GRIP_USED;
    const cornering = samples.map((sample) => {
      const bend = Math.abs(sample.curvature) - grip * downforcePerKilogram;
      return bend <= 0 ? 100 : Math.min(Math.sqrt((grip * gravity) / bend), 100);
    });
    // and slower before a corner, as far back as braking at BRAKING takes it down to the corner's speed
    const speeds = [...cornering];
    for (let lap = 0; lap < 2; lap++) {
      for (let index = samples.length - 1; index >= 0; index--) {
        const next = (index + 1) % samples.length;
        const gap = samples[next]!.position.distanceTo(samples[index]!.position);
        speeds[index] = Math.min(speeds[index]!, Math.sqrt(speeds[next]! ** 2 + 2 * BRAKING * gap));
      }
    }
    this.targetSpeeds = speeds;
  }

  /** Sets the car's pedals and steering for this moment. */
  drive(car: F1Car): void {
    const body = car.body;
    const where = this.circuit.locate(body.position);
    const index = this.circuit.samples.indexOf(where.sample);
    const speed = car.speed;
    const samples = this.circuit.samples;

    // steering for a point on the line ahead
    const ahead = Math.round((LOOK_AHEAD + LOOK_AHEAD_PER_SPEED * Math.max(speed, 0)) / 2);
    const target = samples[(index + ahead) % samples.length]!.position;
    body.directionToWorld(forward.set(0, 0, 1));
    body.directionToWorld(left.set(1, 0, 0));
    toTarget.subVectors(target, body.position).setY(0);
    const distance = Math.max(toTarget.length(), 1);
    const sideways = toTarget.dot(left) / distance;
    const turn = Math.atan((2 * SPECIFICATION.wheelbase * sideways) / distance);
    car.input.steer = Math.min(Math.max(turn / steering.maxAngle, -1), 1);

    // the pedals, for the speed wanted a little ahead, where the car will be in a moment
    const wanted = this.targetSpeeds[(index + 4) % samples.length]!;
    const short = wanted - speed;
    car.input.throttle = Math.min(Math.max(short * 0.35 + 0.15, 0), 1);
    car.input.brake = short < -1 ? Math.min(-short * 0.12, 1) : 0;
    if (car.input.brake > 0) car.input.throttle = 0;
    car.input.drs = Math.abs(where.sample.curvature) < 1 / 2000 && speed > 60;
  }
}
