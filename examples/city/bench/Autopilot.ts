import { MathUtils, Vector3 } from 'three';
import type { Body } from 'eulerjs';
import type { Vehicle } from '../src/car/Vehicle.js';

/** Within this distance of a waypoint, in metres, the car heads for the next one. */
const ARRIVAL_DISTANCE = 6;
/** Speed on the straights and through the turns, in m/s. */
const CRUISING_SPEED = 12;
const TURNING_SPEED = 6;

const forward = new Vector3();
const toWaypoint = new Vector3();

/** Drives the car round a loop of waypoints: steers at the next one, slows for it, and keeps going. */
export class Autopilot {
  private next = 0;
  laps = 0;

  constructor(
    private readonly body: Body,
    private readonly vehicle: Vehicle,
    private readonly waypoints: readonly Vector3[],
  ) {}

  /** Sets the throttle, brake and steering for the coming step. */
  drive(): void {
    const waypoint = this.waypoints[this.next]!;
    toWaypoint.subVectors(waypoint, this.body.position).setY(0);
    if (toWaypoint.length() < ARRIVAL_DISTANCE) {
      this.next = (this.next + 1) % this.waypoints.length;
      if (this.next === 0) this.laps++;
      return this.drive();
    }
    this.body.directionToWorld(forward.set(0, 0, 1)).setY(0).normalize();
    // positive steering turns left, toward +x when heading along +z
    const turnNeeded = Math.atan2(forward.clone().cross(toWaypoint).y, forward.dot(toWaypoint));
    this.vehicle.steering = MathUtils.clamp(turnNeeded * 2, -1, 1);
    const targetSpeed = toWaypoint.length() < 20 || Math.abs(turnNeeded) > 0.3 ? TURNING_SPEED : CRUISING_SPEED;
    const speed = this.vehicle.forwardSpeed(this.body);
    this.vehicle.throttle = MathUtils.clamp((targetSpeed - speed) * 0.5, 0, 1);
    this.vehicle.brake = speed > targetSpeed + 2 ? 0.6 : 0;
  }
}
