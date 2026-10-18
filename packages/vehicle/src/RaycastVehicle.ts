import { Vector3 } from 'three';
import type { Behavior, Body, QueryHit, World } from 'eulerjs';

export interface WheelOptions {
  /** Where the wheel's suspension is fixed to the chassis, in the body's frame. The wheel hangs below it, down the body's up axis. */
  mount: Vector3;
  /** In metres. */
  radius: number;
  /** How far below the mount the wheel's centre hangs with its spring unloaded, in metres: how far it can travel. */
  suspensionLength: number;
  /** In N/m. */
  springStiffness: number;
  /** In N·s/m. */
  springDamping: number;
  /** The most force the tyre takes along the ground, as a share of the load on it: about 1 on dry asphalt. Defaults to 1. */
  grip?: number | undefined;
  /** The force against the tyre's rolling, as a share of the load on it. Defaults to 0.015. */
  rollingResistance?: number | undefined;
}

/**
 * One wheel of a RaycastVehicle: how it is built, what the driver sets (steering, drive and
 * brake), and what it was doing on the last step.
 */
export class Wheel {
  readonly mount: Vector3;
  readonly radius: number;
  readonly suspensionLength: number;
  springStiffness: number;
  springDamping: number;
  /** Change it to make the tyre slide more or less, as a handbrake does to the rear tyres. */
  grip: number;
  rollingResistance: number;

  /** How far the wheel is turned about its strut, in radians: positive turns it to the body's left. */
  steerAngle = 0;
  /** The force the engine drives the tyre forward with, in newtons; negative drives it backward. */
  driveForce = 0;
  /** The most force the brake slows the wheel with, in newtons. It stops the wheel, but never drives it backward. */
  brakeForce = 0;

  /** Whether the tyre was on the ground on the last step. */
  onGround = false;
  /** How far its spring was compressed, in metres; 0 off the ground. */
  compression = 0;
  /** How hard the ground pushed on the tyre, in newtons. */
  load = 0;
  /** Whether the tyre was asked for more grip than it has, and slid. */
  sliding = false;
  /** How far the wheel has turned about its axle, in radians, for drawing it. */
  spinAngle = 0;
  /** Where the tyre touched the ground, and the ground's normal there, in world space. */
  readonly contactPoint = new Vector3();
  readonly contactNormal = new Vector3();
  /** What it stood on. */
  ground: Body | undefined;
  /** Where the wheel's centre is, in world space, for drawing it. */
  readonly center = new Vector3();

  constructor(options: WheelOptions) {
    this.mount = options.mount.clone();
    this.radius = options.radius;
    this.suspensionLength = options.suspensionLength;
    this.springStiffness = options.springStiffness;
    this.springDamping = options.springDamping;
    this.grip = options.grip ?? 1;
    this.rollingResistance = options.rollingResistance ?? 0.015;
  }
}

export interface RaycastVehicleOptions {
  wheels: readonly WheelOptions[];
  /** The body's up and forward axes, in its own frame. Default +y and +z. */
  up?: Vector3 | undefined;
  forward?: Vector3 | undefined;
  /**
   * The share of a wheel's sideways slip its tyre takes out each step, grip allowing. All of it
   * at once would overshoot, the other wheels pulling the same way. Defaults to 0.5.
   */
  sidewaysResponse?: number | undefined;
}

/**
 * The ground under a wheel faces up along its strut, at least this much (the cosine of 70°): a
 * wall, a tree's trunk or the underside of something the ray meets is no ground to stand on.
 */
const LEAST_GROUND_FACING = 0.34;

const up = new Vector3();
const down = new Vector3();
const mount = new Vector3();
const forward = new Vector3();
const side = new Vector3();
const contactVelocity = new Vector3();
const groundVelocity = new Vector3();
const force = new Vector3();
const leverArm = new Vector3();
const turnPerImpulse = new Vector3();
const stopImpulse = new Vector3();
/** The share of how far a wheel has gone past its bump stop that the stop takes back each step. */
const BUMP_STOP_RECOVERY = 0.2;

/**
 * Drives a body on wheels, as games usually do: each wheel is a ray down from where its
 * suspension is mounted, finding the ground (any collider, flat or not, still or moving), and a
 * spring and damper between them. Its tyre pushes along the ground with a force that grows with
 * how much it slips, up to its grip times the load on it; beyond that it slides, which is how a
 * car drifts, skids and spins out. What the wheels push on, they push back on: a car pushes a
 * crate it stands on into the ground, and drags it if it drives off it.
 *
 * Add it to the chassis with `body.addBehavior(vehicle)`, then steer, drive and brake each wheel
 * through `wheels`. The chassis collides as its own colliders; the wheels only through their rays.
 */
export class RaycastVehicle implements Behavior {
  readonly wheels: readonly Wheel[];
  private readonly localUp: Vector3;
  private readonly localForward: Vector3;
  private readonly sidewaysResponse: number;

  constructor(options: RaycastVehicleOptions) {
    this.wheels = options.wheels.map((wheel) => new Wheel(wheel));
    this.localUp = (options.up ?? new Vector3(0, 1, 0)).clone().normalize();
    this.localForward = (options.forward ?? new Vector3(0, 0, 1)).clone().normalize();
    this.sidewaysResponse = options.sidewaysResponse ?? 0.5;
  }

  /** How fast the body is going forward, in m/s; negative going backward. */
  forwardSpeed(body: Body): number {
    return body.velocity.dot(body.directionToWorld(forward.copy(this.localForward)));
  }

  fixedUpdate(body: Body, timestep: number, world: World): void {
    body.directionToWorld(up.copy(this.localUp));
    down.copy(up).negate();
    for (const wheel of this.wheels) this.updateWheel(body, wheel, timestep, world);
  }

  private updateWheel(body: Body, wheel: Wheel, timestep: number, world: World): void {
    body.pointToWorld(wheel.mount, mount);
    const reach = wheel.suspensionLength + wheel.radius;
    const hit = groundUnder(world, body, reach);
    if (!hit) {
      wheel.onGround = false;
      wheel.compression = 0;
      wheel.load = 0;
      wheel.sliding = false;
      wheel.ground = undefined;
      wheel.center.copy(mount).addScaledVector(down, wheel.suspensionLength);
      wheel.spinAngle += (this.forwardSpeed(body) / wheel.radius) * timestep;
      return;
    }

    // how the tyre moves over the ground, which may be moving itself
    body.pointVelocity(hit.point, contactVelocity).sub(hit.body.pointVelocity(hit.point, groundVelocity));
    const compression = Math.min(reach - hit.distance, wheel.suspensionLength);
    // the damper resists how fast the chassis comes down on the ground there: the wheel may come
    // upon something higher from one step to the next, a kerb or a crate, without the strut
    // having moved at all
    const compressionRate = -contactVelocity.dot(up);
    const normal = hit.normal;
    const springLoad = Math.max(0, wheel.springStiffness * compression + wheel.springDamping * compressionRate);
    this.push(body, hit.body, force.copy(normal).multiplyScalar(springLoad), hit.point);
    // past the end of its travel the strut is solid: without a stop there, a car cornering hard
    // would sink onto its outside wheels, and lean further and further until it went over
    const load = springLoad + bumpStop(body, hit.body, hit.point, normal, reach - hit.distance - wheel.suspensionLength, timestep);

    // the tyre's own directions along the ground: turned by the steering, then laid on the ground
    forward.copy(this.localForward).applyAxisAngle(this.localUp, wheel.steerAngle);
    body.directionToWorld(forward).addScaledVector(normal, -forward.dot(normal)).normalize();
    side.crossVectors(normal, forward);
    const rollingSpeed = contactVelocity.dot(forward);
    const slipSpeed = contactVelocity.dot(side);
    const massShare = body.mass / this.wheels.length;

    // The brake and the tyre's rolling resistance can stop the wheel, but not drive it backward:
    // no more than stops how fast it would roll by the end of the step, gravity and the engine
    // pulling it on, so that a car braked on a slope stands still rather than creeping down it.
    const pull = world.gravity.dot(forward) * body.gravityScale;
    const rollingOn = rollingSpeed + (pull + wheel.driveForce / massShare) * timestep;
    const resisting = Math.min(wheel.brakeForce + wheel.rollingResistance * load, (Math.abs(rollingOn) * massShare) / timestep);
    let alongForce = wheel.driveForce - Math.sign(rollingOn) * resisting;
    // the tyre takes out a share of the slip, and holds against gravity's sideways pull
    let sideForce = -massShare * ((slipSpeed * this.sidewaysResponse) / timestep + world.gravity.dot(side) * body.gravityScale);
    const grip = wheel.grip * load;
    const asked = Math.hypot(alongForce, sideForce);
    wheel.sliding = asked > grip;
    if (wheel.sliding) {
      alongForce *= grip / asked;
      sideForce *= grip / asked;
    }
    // where the tyre slips, as it grips: pushed anywhere else, its pull against the slip would
    // no longer damp the body's roll, and a car swerving one way and back would roll over
    this.push(body, hit.body, force.copy(forward).multiplyScalar(alongForce).addScaledVector(side, sideForce), hit.point);

    wheel.onGround = true;
    wheel.compression = compression;
    wheel.load = load;
    wheel.ground = hit.body;
    wheel.contactPoint.copy(hit.point);
    wheel.contactNormal.copy(normal);
    wheel.center.copy(mount).addScaledVector(down, wheel.suspensionLength - compression);
    // a wheel braked into a slide is locked
    if (!(wheel.sliding && wheel.brakeForce > 0)) wheel.spinAngle += (rollingSpeed / wheel.radius) * timestep;
  }

  /** Pushes the body with `pushed` at `point`, and the ground back (static ground takes no notice). */
  private push(body: Body, ground: Body, pushed: Vector3, point: Vector3): void {
    body.applyForce(pushed, point);
    ground.applyForce(pushed.negate(), point);
  }
}

/**
 * The nearest ground the ray down from the wheel's mount (in `mount`, along `down`) meets within
 * `reach`: not anything it starts inside, as it will when the chassis is pressed into a wall or a
 * tree, nor anything facing too far from up.
 */
function groundUnder(world: World, body: Body, reach: number): QueryHit | undefined {
  for (const hit of world.castRayAll(mount, down, { maxDistance: reach, exclude: body })) {
    if (hit.distance > 1e-6 && hit.normal.dot(up) >= LEAST_GROUND_FACING) return hit;
  }
  return undefined;
}

/**
 * The bump stop at the end of a wheel's travel, `overshoot` past it: an impulse at the tyre's
 * contact, along the ground's normal, that stops the chassis coming any further down on the
 * wheel and lifts it back a share of the way, as a contact would. Gravity pulls it back a
 * little within each step, so it rests a few millimetres past the stop. Returns the force it
 * gave, for the tyre's load; 0 within the wheel's travel.
 */
function bumpStop(body: Body, ground: Body, point: Vector3, normal: Vector3, overshoot: number, timestep: number): number {
  if (overshoot <= 0) return 0;
  const approach = contactVelocity.dot(normal);
  const wanted = (BUMP_STOP_RECOVERY * overshoot) / timestep;
  if (approach >= wanted) return 0;
  const inverseMass = inverseMassAt(body, point, normal) + inverseMassAt(ground, point, normal);
  if (inverseMass === 0) return 0;
  const impulse = (wanted - approach) / inverseMass;
  body.applyImpulse(stopImpulse.copy(normal).multiplyScalar(impulse), point);
  ground.applyImpulse(stopImpulse.negate(), point);
  // the tyre's contact moves with the push
  contactVelocity.addScaledVector(normal, wanted - approach);
  return impulse / timestep;
}

/** How hard `body` is to move at `point` along the unit `direction`: 1/m + (r × n) · I⁻¹ (r × n); 0 for bodies forces don't move. */
function inverseMassAt(body: Body, point: Vector3, direction: Vector3): number {
  if (body.type !== 'dynamic') return 0;
  leverArm.subVectors(point, body.worldCenterOfMass).cross(direction);
  return body.inverseMass + leverArm.dot(turnPerImpulse.copy(leverArm).applyMatrix3(body.worldInverseInertia));
}
