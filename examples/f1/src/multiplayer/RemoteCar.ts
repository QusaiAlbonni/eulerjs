import { Quaternion, Vector3 } from 'three';
import { Body, MassProperties } from '@eulerjs/core';
import type { Behavior, World } from '@eulerjs/core';
import type { CarPose, DetailedCarModel } from '../car/DetailedCarModel.js';
import { carColliders, wheelOptions } from '../car/F1Car.js';
import { SPECIFICATION } from '../car/specification.js';
import type { CarState } from './protocol.js';

/**
 * How far a car is carried on past its newest state, at its velocity, before it waits for the
 * next, in seconds: past a lost state or two, not a dropped connection.
 */
const MOST_EXTRAPOLATION = 0.3;
/**
 * The spring that holds the car where its states put it: its natural frequency in hertz,
 * critically damped, toward where the car is and how fast it is going there.
 */
const HOLD_FREQUENCY = 2.5;
/**
 * The most the spring may pull, as an acceleration, in m/s² and rad/s²: more than a car's hardest
 * braking (about 5 g), so that it follows any driving, and far less than a crash, so that in one
 * the car takes the knock as a free car of its mass would, and is drawn back after.
 */
const MOST_HOLD = 80;
const MOST_TURNING_HOLD = 40;
/** How far off the car may be before it is put straight where it is, in metres: it was put back on the grid. */
const TELEPORT = 10;

const axis = new Vector3();
const turned = new Quaternion();
const error = new Vector3();
const pull = new Vector3();
const turnError = new Quaternion();

/** `quaternion` turned on by `angularVelocity` for `seconds`. */
function turnOn(quaternion: Quaternion, angularVelocity: Vector3, seconds: number): Quaternion {
  const rate = angularVelocity.length();
  if (rate < 1e-9) return quaternion;
  turned.setFromAxisAngle(axis.copy(angularVelocity).divideScalar(rate), rate * seconds);
  return quaternion.premultiply(turned).normalize();
}

/** `vector` no longer than `most`. */
function capped(vector: Vector3, most: number): Vector3 {
  const length = vector.length();
  return length > most ? vector.multiplyScalar(most / length) : vector;
}

/**
 * One of the other players' cars, where it is now: its newest state carried on at its velocity
 * for as long as that state took to come, so that it is collided with where its player has it, not
 * where they had it a ping ago. A solid car of the real car's mass, held there by a spring too
 * weak to matter in a crash: it pushes as a car does and gives as one does, its own player's car
 * taking the knock in their own world.
 */
export class RemoteCar implements Behavior, CarPose {
  readonly model: Pick<DetailedCarModel, 'root' | 'update'>;
  readonly body: Body;
  /** As the model draws it: the wheels where the newest state says, spinning on at their speed. */
  readonly vehicle = { wheels: wheelOptions().map((wheel) => ({ mount: wheel.mount, suspensionLength: wheel.suspensionLength, compression: 0, steerAngle: 0, spinAngle: 0 })) };
  readonly input = { steer: 0 };
  private newest: { time: number; state: CarState } | undefined;
  /** Where the newest state puts the car at a given time. */
  private readonly raw = { position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), angularVelocity: new Vector3() };
  /** The host's clock against the world's, set each frame, so that a physics step knows what time it is. */
  private worldToHost: number | undefined;

  constructor(world: World, model: Pick<DetailedCarModel, 'root' | 'update'>) {
    this.model = model;
    model.root.visible = false;
    const size = SPECIFICATION.inertiaBox;
    this.body = world.addBody(
      new Body({
        // drawn where the body is, as the world draws every body, between its steps
        object: model.root,
        position: new Vector3(0, -50, 0),
        colliders: carColliders(true),
        massProperties: MassProperties.box(new Vector3(size.width, size.height, size.length), SPECIFICATION.mass),
        // held up where its states say, not by wheels of its own
        gravityScale: 0,
        canSleep: false,
      }),
    );
    this.body.addBehavior(this);
  }

  /** A state from its player, sent at `sentAt` on the host's clock. */
  receive(state: CarState, sentAt: number): void {
    // one that comes after a newer one is no use: the car is where the newer says
    if (this.newest && sentAt <= this.newest.time) return;
    this.newest = { time: sentAt, state };
  }

  /** Each frame: the clocks lined up for the steps to come, and the wheels drawn, turned on by `frameDelta`. */
  draw(hostNow: number, world: World, frameDelta: number): void {
    this.worldToHost = hostNow - world.time;
    if (!this.newest) return;
    this.model.root.visible = true;
    this.setWheels(frameDelta);
    this.model.update(this, frameDelta);
  }

  /** Each physics step: pulled toward where the car is now and how it moves, as hard as the spring may. */
  fixedUpdate(body: Body, timestep: number, world: World): void {
    if (this.worldToHost === undefined || !this.carryOn(world.time + this.worldToHost)) return;
    const { position, quaternion, velocity, angularVelocity } = this.raw;
    if (body.position.distanceTo(position) > TELEPORT) {
      body.setPose(position, quaternion);
      body.velocity.copy(velocity);
      body.angularVelocity.copy(angularVelocity);
      return;
    }
    const stiffness = (2 * Math.PI * HOLD_FREQUENCY) ** 2;
    const damping = 2 * 2 * Math.PI * HOLD_FREQUENCY;
    // toward where it is, and moving as it moves
    error.subVectors(position, body.position);
    pull.subVectors(velocity, body.velocity).multiplyScalar(damping).addScaledVector(error, stiffness);
    body.velocity.addScaledVector(capped(pull, MOST_HOLD), timestep);
    // and turned toward the way it points, turning as it turns
    turnError.copy(quaternion).multiply(turned.copy(body.quaternion).invert());
    if (turnError.w < 0) turnError.set(-turnError.x, -turnError.y, -turnError.z, -turnError.w);
    const angle = 2 * Math.acos(Math.min(turnError.w, 1));
    const sine = Math.sqrt(Math.max(1 - turnError.w * turnError.w, 0));
    error.set(0, 0, 0);
    if (sine > 1e-6) error.set(turnError.x / sine, turnError.y / sine, turnError.z / sine).multiplyScalar(angle);
    pull.subVectors(angularVelocity, body.angularVelocity).multiplyScalar(damping).addScaledVector(error, stiffness);
    body.angularVelocity.addScaledVector(capped(pull, MOST_TURNING_HOLD), timestep);
  }

  remove(world: World): void {
    world.removeBody(this.body);
    this.model.root.removeFromParent();
  }

  /** Where the newest state puts the car at `hostTime`: carried on from it at its velocity, a little way at most. */
  private carryOn(hostTime: number): boolean {
    const newest = this.newest;
    if (!newest) return false;
    const { position, quaternion, velocity, angularVelocity } = this.raw;
    const ahead = Math.min(Math.max(hostTime - newest.time, 0), MOST_EXTRAPOLATION);
    velocity.fromArray(newest.state.velocity);
    angularVelocity.fromArray(newest.state.angularVelocity);
    position.fromArray(newest.state.position).addScaledVector(velocity, ahead);
    turnOn(quaternion.fromArray(newest.state.quaternion), angularVelocity, ahead);
    return true;
  }

  private setWheels(frameDelta: number): void {
    const state = this.newest!.state;
    this.input.steer = state.steer;
    this.vehicle.wheels.forEach((wheel, index) => {
      const [compression, steerAngle, spinSpeed] = state.wheels[index]!;
      wheel.compression = compression;
      wheel.steerAngle = steerAngle;
      // the spin from its speed: at 30 states a second a wheel at speed turns too far between two to be told which way
      wheel.spinAngle = (wheel.spinAngle + spinSpeed * frameDelta) % (2 * Math.PI);
    });
  }
}
