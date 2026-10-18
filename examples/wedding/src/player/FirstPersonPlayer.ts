import { Object3D, Quaternion, Vector3 } from 'three';
import { Body, CapsuleCollider, SixDofJoint } from '@eulerjs/core';
import type { Behavior, World } from '@eulerjs/core';

/** A guest of 1.75 m and 75 kg, as a capsule. */
const RADIUS = 0.3;
const LENGTH = 1.15;
const HALF_HEIGHT = LENGTH / 2 + RADIUS;
const MASS = 75;
/** The eyes, above the body's middle. */
const EYE_HEIGHT = 0.72;
const WALKING_SPEED = 3;
const RUNNING_SPEED = 6;
/** How soon the player gets up to speed, or stops, in seconds. */
const SPEED_UP_TIME = 0.12;
/**
 * The most the legs push with along the ground, in newtons: about a person's push, enough to
 * shove a chair or a table along but not to bulldoze everything in the way.
 */
const MOST_PUSH = 650;
/** In the air, only a little steering. */
const AIR_PUSH = 80;
const JUMP_SPEED = 4.2;
/** How far below the feet the ground still counts as underfoot, in metres. */
const GROUND_REACH = 0.12;

const UP = new Vector3(0, 1, 0);
const SIDEWAYS = new Vector3(1, 0, 0);
const down = new Vector3(0, -1, 0);
const facing = new Quaternion();
const wanted = new Vector3();
const push = new Vector3();
const feet = new Vector3();

/**
 * The player in first person: a capsule body walking on its own legs. It pushes itself toward the
 * speed it wants with no more than a person's force, so it shoves light things aside, leans on
 * heavy ones without moving them, and is stopped by walls. A joint to the world with an
 * orientation drive and nothing else keeps it standing upright, whatever it bumps into.
 */
export class FirstPersonPlayer implements Behavior {
  readonly body: Body;
  /** Follows the body, interpolated between steps: the camera sits on it. */
  readonly head = new Object3D();
  /** What the player wants to do: forward and right from -1 to 1, in the way they look. */
  readonly input = { forward: 0, right: 0, running: false, jumping: false };
  /** Where they look: turned left by `yaw` from -z, and up by `pitch`, in radians. */
  yaw = 0;
  pitch = 0;
  private grounded = false;

  constructor(
    private readonly world: World,
    position: Vector3,
  ) {
    this.body = world.addBody(
      new Body({
        position: position.clone().setY(position.y + HALF_HEIGHT),
        // frictionless, so it slides along what it brushes against instead of climbing it
        colliders: [new CapsuleCollider({ radius: RADIUS, length: LENGTH, friction: 0 })],
        mass: MASS,
        object: this.head,
        canSleep: false,
      }),
    );
    world.addJoint(new SixDofJoint({ bodyA: this.body, linear: ['free', 'free', 'free'], angular: ['free', 'free', 'free'], orientationDrive: { target: new Quaternion(), frequency: 8 } }));
    this.body.addBehavior(this);
  }

  /** Whether the player stood on something on the last step. */
  get onGround(): boolean {
    return this.grounded;
  }

  /** Where the eyes are, as drawn: between steps. */
  eyePosition(target: Vector3): Vector3 {
    return target.copy(this.head.position).addScaledVector(UP, EYE_HEIGHT);
  }

  /** Where the eyes are now, in the simulation. */
  eyePositionNow(target: Vector3): Vector3 {
    return target.copy(this.body.position).addScaledVector(UP, EYE_HEIGHT);
  }

  /** The way the player looks, a unit vector. */
  lookDirection(target: Vector3): Vector3 {
    return target.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  /** How the camera turns to look that way. */
  lookQuaternion(target: Quaternion): Quaternion {
    return target.setFromAxisAngle(UP, this.yaw).multiply(facing.setFromAxisAngle(SIDEWAYS, this.pitch));
  }

  fixedUpdate(body: Body): void {
    feet.copy(body.position);
    const ground = this.world.castRay(feet, down, { maxDistance: HALF_HEIGHT + GROUND_REACH, exclude: body });
    this.grounded = ground !== undefined;

    // the speed wanted along the ground, from the keys, turned the way the player faces
    const speed = this.input.running ? RUNNING_SPEED : WALKING_SPEED;
    wanted.set(this.input.right, 0, -this.input.forward);
    if (wanted.lengthSq() > 1) wanted.normalize();
    wanted.multiplyScalar(speed).applyAxisAngle(UP, this.yaw);
    // what it takes to get there in the speed-up time, as much as the legs can give
    push.set(wanted.x - body.velocity.x, 0, wanted.z - body.velocity.z).multiplyScalar(MASS / SPEED_UP_TIME);
    const most = this.grounded ? MOST_PUSH : AIR_PUSH;
    if (push.length() > most) push.setLength(most);
    body.applyForce(push);
    // and the push back on what it stands on, a chair or a table it climbed onto
    if (ground && ground.body.type === 'dynamic') ground.body.applyForce(push.negate(), ground.point);

    if (this.input.jumping && this.grounded && body.velocity.y < 0.5) {
      body.applyImpulse(push.set(0, MASS * (JUMP_SPEED - body.velocity.y), 0));
      this.grounded = false;
    }
  }

  /** Puts the player back at `position`, standing still. */
  respawn(position: Vector3): void {
    this.body.setPose(position.clone().setY(position.y + HALF_HEIGHT), new Quaternion());
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
  }
}
