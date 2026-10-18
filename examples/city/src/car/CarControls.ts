import { MathUtils, Quaternion, Vector3 } from 'three';
import type { Body } from '@eulerjs/core';
import { CAR_LAYOUT } from './carLayout.js';
import { rideHeight } from './createCarPhysics.js';
import type { Vehicle } from './Vehicle.js';

/** How fast the wheel turns toward full lock, and back to the centre when let go, per second. */
const STEER_RATE = 2.5;
const STEER_RETURN_RATE = 4;
/** Below this speed (m/s) the brake key reverses instead. */
const REVERSE_BELOW_SPEED = 0.5;

const UP = new Vector3(0, 1, 0);
const forward = new Vector3();
const upright = new Quaternion();

/**
 * Keyboard driving: W or ↑ to accelerate, S or ↓ to brake and then reverse, A/D or ←/→ to steer,
 * Space for the handbrake, R to put the car back on its wheels.
 */
export class CarControls {
  private readonly pressed = new Set<string>();
  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.pressed.add(event.code);
    if (event.code === 'KeyR' && !event.repeat) this.putBackOnWheels();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => this.pressed.delete(event.code);
  private readonly onBlur = () => this.pressed.clear();

  constructor(
    private readonly body: Body,
    private readonly vehicle: Vehicle,
    private readonly target: Window,
  ) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  update(frameDelta: number): void {
    const accelerating = this.isPressed('KeyW', 'ArrowUp');
    const braking = this.isPressed('KeyS', 'ArrowDown');
    const speed = this.vehicle.forwardSpeed(this.body);
    this.vehicle.throttle = 0;
    this.vehicle.brake = 0;
    if (accelerating) {
      // pressing forward while rolling backwards brakes first
      if (speed < -REVERSE_BELOW_SPEED) this.vehicle.brake = 1;
      else this.vehicle.throttle = 1;
    } else if (braking) {
      if (speed > REVERSE_BELOW_SPEED) this.vehicle.brake = 1;
      else this.vehicle.throttle = -1;
    }
    this.vehicle.handbrake = this.isPressed('Space');

    const steerTarget = (this.isPressed('KeyA', 'ArrowLeft') ? 1 : 0) - (this.isPressed('KeyD', 'ArrowRight') ? 1 : 0);
    const rate = steerTarget === 0 ? STEER_RETURN_RATE : STEER_RATE;
    const change = MathUtils.clamp(steerTarget - this.vehicle.steering, -rate * frameDelta, rate * frameDelta);
    this.vehicle.steering += change;
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  private isPressed(...codes: string[]): boolean {
    return codes.some((code) => this.pressed.has(code));
  }

  /** Stands the car back on its wheels where it is, a little above the road, facing the way it was. */
  private putBackOnWheels(): void {
    forward.set(0, 0, 1).applyQuaternion(this.body.quaternion).setY(0);
    const heading = forward.lengthSq() > 1e-6 ? Math.atan2(forward.x, forward.z) : 0;
    this.body.setPose(this.body.position.clone().setY(rideHeight(CAR_LAYOUT) + 0.3), upright.setFromAxisAngle(UP, heading));
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
  }
}
