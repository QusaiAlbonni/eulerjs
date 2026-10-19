import { Vector3 } from 'three';
import type { Behavior, Body, QueryHit, World } from '@eulerjs/core';

/** What the ground under a wheel is like, as `RaycastVehicleOptions.surface` tells it. */
export interface GroundSurface {
  /** What it scales the tyre's grip by: 1 on the ground the tyre's grip is given for, less on grass or gravel. Defaults to 1. */
  grip?: number | undefined;
  /** Added to the tyre's rolling resistance, as a share of its load: deep gravel drags a car down. Defaults to 0. */
  rollingResistance?: number | undefined;
  /**
   * How far the ground there stands above the surface the wheel's ray hit, in metres, below it if
   * negative: bumps, ripples and kerbs too small or too many to be colliders, felt through the
   * suspension. Defaults to 0.
   */
  height?: number | undefined;
}

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
  /** With `tyres: 'slip'`: the wheel's moment of inertia about its axle, tyre, rim and brake disc together, in kg·m². Defaults to 1. */
  inertia?: number | undefined;
  /** With `tyres: 'slip'`: the slip angle the tyre corners hardest at, in radians. Defaults to 0.1, about 6°. */
  peakSlipAngle?: number | undefined;
  /** With `tyres: 'slip'`: the slip ratio, (spin × radius − speed) / speed, the tyre pulls or brakes hardest at. Defaults to 0.1. */
  peakSlipRatio?: number | undefined;
  /** With `tyres: 'slip'`: the grip left when the tyre slides well past its peak, as a share of it, above 0 and below 1. Defaults to 0.75. */
  slidingGrip?: number | undefined;
  /**
   * With `tyres: 'slip'`: how much less the tyre grips for each newton as it is loaded, the
   * exponent k in grip × (load / nominalLoad)^−k. Twice the load gives 2^−k as much grip a
   * newton: 7% less at the default, 0.1.
   */
  loadSensitivity?: number | undefined;
  /** With `tyres: 'slip'`: the load the tyre grips by `grip` at, in newtons. Defaults to its share of the body's weight. */
  nominalLoad?: number | undefined;
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
  /** In kg·m². */
  inertia: number;
  peakSlipAngle: number;
  peakSlipRatio: number;
  readonly slidingGrip: number;
  loadSensitivity: number;
  nominalLoad: number | undefined;
  /** The tyre curve's shape and stiffness (Pacejka's C and B), from `slidingGrip`. */
  readonly curveShape: number;
  readonly curveStiffness: number;

  /** How far the wheel is turned about its strut, in radians: positive turns it to the body's left. */
  steerAngle = 0;
  /** The force the engine drives the tyre forward with, in newtons; negative drives it backward. */
  driveForce = 0;
  /** The most force the brake slows the wheel with, in newtons. It stops the wheel, but never drives it backward. */
  brakeForce = 0;
  /** With `tyres: 'slip'`: the torque the engine drives the wheel with, in N·m; negative drives it backward. `driveForce` adds to it, times the radius. */
  driveTorque = 0;
  /** With `tyres: 'slip'`: the most torque the brake slows the wheel's spin with, in N·m. `brakeForce` adds to it, times the radius. */
  brakeTorque = 0;

  /** Whether the tyre was on the ground on the last step. */
  onGround = false;
  /** How far its spring was compressed, in metres; 0 off the ground. */
  compression = 0;
  /** How hard the ground pushed on the tyre, in newtons. */
  load = 0;
  /** Whether the tyre was asked for more grip than it has, and slid; with `tyres: 'slip'`, whether it was past its peak. */
  sliding = false;
  /** With `tyres: 'slip'`: how fast the wheel spins about its axle, in rad/s, positive rolling forward. */
  spinSpeed = 0;
  /** With `tyres: 'slip'`: (spin × radius − speed) / speed on the last step: positive spinning up, −1 locked. */
  slipRatio = 0;
  /** With `tyres: 'slip'`: the angle between where the tyre points and where it goes, in radians, positive sliding to its left. */
  slipAngle = 0;
  /** How far the wheel has turned about its axle, in radians, for drawing it. */
  spinAngle = 0;
  /** Where the tyre touched the ground, and the ground's normal there, in world space. */
  readonly contactPoint = new Vector3();
  readonly contactNormal = new Vector3();
  /** What it stood on. */
  ground: Body | undefined;
  /** What `RaycastVehicleOptions.surface` said the ground was like where it touched, on the last step. */
  surface: GroundSurface | undefined;
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
    this.inertia = options.inertia ?? 1;
    this.peakSlipAngle = options.peakSlipAngle ?? 0.1;
    this.peakSlipRatio = options.peakSlipRatio ?? 0.1;
    this.slidingGrip = options.slidingGrip ?? 0.75;
    this.loadSensitivity = options.loadSensitivity ?? 0.1;
    this.nominalLoad = options.nominalLoad;
    if (!(this.slidingGrip > 0 && this.slidingGrip < 1)) throw new RangeError(`slidingGrip must be above 0 and below 1, not ${this.slidingGrip}`);
    // sin(C atan(B s)) peaks at s = 1 and falls toward slidingGrip as s grows
    this.curveShape = 2 - (2 / Math.PI) * Math.asin(this.slidingGrip);
    this.curveStiffness = Math.tan(Math.PI / (2 * this.curveShape));
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
  /**
   * How the tyres grip. `'grip'`, the default: each takes out a share of its slip, up to its grip
   * times its load, and its wheel turns as the ground goes by; give it `driveForce` and
   * `brakeForce`. `'slip'`: each wheel spins as a body of its own, given `driveTorque` and
   * `brakeTorque`, and its tyre pulls with how much it slips, along and across, harder up to a
   * peak and less past it, so that it spins up, locks and slides as a tyre does, and grips less
   * for each newton the more it is loaded. For a racing car.
   */
  tyres?: 'grip' | 'slip' | undefined;
  /**
   * What the ground is like where a wheel touches it, at `point` in world space: its grip and
   * how it drags, for a track whose kerbs, grass and gravel are one collider, or any ground
   * whose grip varies. Asked for every wheel on the ground, every step. Without it, the ground
   * is the same everywhere.
   */
  surface?: ((point: Vector3, hit: QueryHit) => GroundSurface | undefined) | undefined;
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
const contact = new Vector3();
const force = new Vector3();
const leverArm = new Vector3();
const turnPerImpulse = new Vector3();
const stopImpulse = new Vector3();
/** A tyre's pull on the ground, along the tyre and across it, in newtons. */
const tyreForce = { along: 0, side: 0 };
const slipForce = { along: 0, side: 0 };
/** The share of how far a wheel has gone past its bump stop that the stop takes back each step. */
const BUMP_STOP_RECOVERY = 0.2;
/**
 * Slip tyres hand over to grip tyres below these speeds over the ground, in m/s: slip angles and
 * ratios mean nothing at a standstill, and grip tyres hold a braked car still on a slope.
 */
const SLIP_TYRES_FROM = 2;
const SLIP_TYRES_FULLY = 4;
/** The least speed a slip tyre's slip is measured against, in m/s, so that it stays finite near a standstill. */
const LEAST_SLIP_SPEED = 1;
/** Steps a slip tyre's wheel takes within each of the world's, its spin stiffly held by its tyre. */
const SPIN_STEPS = 4;
/** Below this speed over the ground, in m/s, a braked slip tyre's wheel is held still. */
const BRAKED_STANDSTILL = 0.01;

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
  readonly tyres: 'grip' | 'slip';
  private readonly surface: RaycastVehicleOptions['surface'];

  constructor(options: RaycastVehicleOptions) {
    this.wheels = options.wheels.map((wheel) => new Wheel(wheel));
    this.localUp = (options.up ?? new Vector3(0, 1, 0)).clone().normalize();
    this.localForward = (options.forward ?? new Vector3(0, 0, 1)).clone().normalize();
    this.sidewaysResponse = options.sidewaysResponse ?? 0.5;
    this.tyres = options.tyres ?? 'grip';
    this.surface = options.surface;
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
    wheel.surface = hit ? this.surface?.(hit.point, hit) : undefined;
    // how far down the ground is, the surface's own bumps and kerbs taken in
    const distance = hit ? hit.distance - (wheel.surface?.height ?? 0) : Infinity;
    if (!hit || distance > reach) {
      wheel.onGround = false;
      wheel.compression = 0;
      wheel.load = 0;
      wheel.sliding = false;
      wheel.ground = undefined;
      wheel.center.copy(mount).addScaledVector(down, wheel.suspensionLength);
      if (this.tyres === 'slip') {
        spinFreely(wheel, timestep);
        wheel.spinAngle += wheel.spinSpeed * timestep;
      } else {
        wheel.spinAngle += (this.forwardSpeed(body) / wheel.radius) * timestep;
      }
      return;
    }

    // where the tyre touches, on the surface's bumps, and how it moves over the ground there,
    // which may be moving itself
    contact.copy(hit.point).addScaledVector(up, wheel.surface?.height ?? 0);
    body.pointVelocity(contact, contactVelocity).sub(hit.body.pointVelocity(contact, groundVelocity));
    const compression = Math.min(reach - distance, wheel.suspensionLength);
    // the damper resists how fast the chassis comes down on the ground there: the wheel may come
    // upon something higher from one step to the next, a kerb or a crate, without the strut
    // having moved at all
    const compressionRate = -contactVelocity.dot(up);
    const normal = hit.normal;
    const springLoad = Math.max(0, wheel.springStiffness * compression + wheel.springDamping * compressionRate);
    this.push(body, hit.body, force.copy(normal).multiplyScalar(springLoad), contact);
    // past the end of its travel the strut is solid: without a stop there, a car cornering hard
    // would sink onto its outside wheels, and lean further and further until it went over
    const load = springLoad + bumpStop(body, hit.body, contact, normal, reach - distance - wheel.suspensionLength, timestep);

    // the tyre's own directions along the ground: turned by the steering, then laid on the ground
    forward.copy(this.localForward).applyAxisAngle(this.localUp, wheel.steerAngle);
    body.directionToWorld(forward).addScaledVector(normal, -forward.dot(normal)).normalize();
    side.crossVectors(normal, forward);
    const rollingSpeed = contactVelocity.dot(forward);
    const slipSpeed = contactVelocity.dot(side);
    const massShare = body.mass / this.wheels.length;
    const alongPull = world.gravity.dot(forward) * body.gravityScale;
    const sidePull = world.gravity.dot(side) * body.gravityScale;
    if (this.tyres === 'slip') {
      this.slipTyre(body, wheel, load, rollingSpeed, slipSpeed, massShare, alongPull, sidePull, timestep, world.gravity.length());
    } else {
      this.gripTyre(wheel, load, rollingSpeed, slipSpeed, massShare, alongPull, sidePull, timestep, wheel.driveForce, wheel.brakeForce);
    }
    // where the tyre slips, as it grips: pushed anywhere else, its pull against the slip would
    // no longer damp the body's roll, and a car swerving one way and back would roll over
    this.push(body, hit.body, force.copy(forward).multiplyScalar(tyreForce.along).addScaledVector(side, tyreForce.side), contact);

    wheel.onGround = true;
    wheel.compression = compression;
    wheel.load = load;
    wheel.ground = hit.body;
    wheel.contactPoint.copy(contact);
    wheel.contactNormal.copy(normal);
    wheel.center.copy(mount).addScaledVector(down, wheel.suspensionLength - compression);
    if (this.tyres === 'slip') wheel.spinAngle += wheel.spinSpeed * timestep;
    // a wheel braked into a slide is locked
    else if (!(wheel.sliding && wheel.brakeForce > 0)) wheel.spinAngle += (rollingSpeed / wheel.radius) * timestep;
  }

  /**
   * A grip tyre's pull, into `tyreForce`, given what drives and brakes it as forces at the ground.
   * The brake and the tyre's rolling resistance can stop the wheel, but not drive it backward:
   * no more than stops how fast it would roll by the end of the step, gravity and the engine
   * pulling it on, so that a car braked on a slope stands still rather than creeping down it.
   */
  private gripTyre(
    wheel: Wheel,
    load: number,
    rollingSpeed: number,
    slipSpeed: number,
    massShare: number,
    alongPull: number,
    sidePull: number,
    timestep: number,
    driveForce: number,
    brakeForce: number,
  ): void {
    const rollingOn = rollingSpeed + (alongPull + driveForce / massShare) * timestep;
    const resisting = Math.min(brakeForce + rollingResistanceOf(wheel) * load, (Math.abs(rollingOn) * massShare) / timestep);
    let alongForce = driveForce - Math.sign(rollingOn) * resisting;
    // the tyre takes out a share of the slip, and holds against gravity's sideways pull
    let sideForce = -massShare * ((slipSpeed * this.sidewaysResponse) / timestep + sidePull);
    const grip = gripOf(wheel) * load;
    const asked = Math.hypot(alongForce, sideForce);
    wheel.sliding = asked > grip;
    if (wheel.sliding) {
      alongForce *= grip / asked;
      sideForce *= grip / asked;
    }
    tyreForce.along = alongForce;
    tyreForce.side = sideForce;
  }

  /**
   * A slip tyre's pull, into `tyreForce`. The wheel's spin is stepped a few times within the
   * world's step, against its tyre's pull on the ground going by, which holds it so stiffly that
   * each step leans on the stiffness of that hold (implicitly) to stay steady. Slow over the
   * ground, the tyre hands over to a grip tyre's, which holds a car still.
   */
  private slipTyre(
    body: Body,
    wheel: Wheel,
    load: number,
    rollingSpeed: number,
    slipSpeed: number,
    massShare: number,
    alongPull: number,
    sidePull: number,
    timestep: number,
    gravity: number,
  ): void {
    const radius = wheel.radius;
    const driveTorque = wheel.driveTorque + wheel.driveForce * radius;
    const brakeTorque = wheel.brakeTorque + wheel.brakeForce * radius;
    const handOver = smoothstep(SLIP_TYRES_FROM, SLIP_TYRES_FULLY, Math.hypot(rollingSpeed, slipSpeed));
    const against = Math.max(Math.abs(rollingSpeed), LEAST_SLIP_SPEED);
    let along = 0;
    let side = 0;
    wheel.slipAngle = Math.atan2(slipSpeed, against);
    wheel.slipRatio = 0;
    if (handOver > 0) {
      const nominalLoad = wheel.nominalLoad ?? (body.mass * gravity) / this.wheels.length;
      // the most the tyre pulls with: its grip, less for each newton the more it is loaded
      const peak = gripOf(wheel) * load * Math.pow(Math.max(load, 1e-9) / nominalLoad, -wheel.loadSensitivity);
      const across = slipSpeed / against / Math.tan(wheel.peakSlipAngle);
      // how stiffly the tyre holds the spin to the ground going by, about no slip, in 1/s
      const holding = (peak * wheel.curveShape * wheel.curveStiffness * radius * radius) / (wheel.peakSlipRatio * against * wheel.inertia);
      const step = timestep / SPIN_STEPS;
      const spinPerTorque = step / (wheel.inertia * (1 + step * holding));
      const slipRatioOf = (spinSpeed: number) => (spinSpeed * radius - rollingSpeed) / against;
      let ratio = 0;
      for (let index = 0; index < SPIN_STEPS; index++) {
        combinedSlip(wheel, slipRatioOf(wheel.spinSpeed) / wheel.peakSlipRatio, across, peak);
        const resisting = rollingResistanceOf(wheel) * load * radius * Math.sign(wheel.spinSpeed);
        const free = wheel.spinSpeed + (driveTorque - slipForce.along * radius - resisting) * spinPerTorque;
        // the brake stops the wheel, but never turns it backward
        wheel.spinSpeed = Math.sign(free) * Math.max(Math.abs(free) - brakeTorque * spinPerTorque, 0);
        // the pull the tyre has at the spin the step ends with, as stepping against it implies:
        // the pull at the spin it began with would lag behind the wheel as it speeds up
        ratio = slipRatioOf(wheel.spinSpeed);
        combinedSlip(wheel, ratio / wheel.peakSlipRatio, across, peak);
        along += slipForce.along / SPIN_STEPS;
        side += slipForce.side / SPIN_STEPS;
      }
      // no more sideways than takes out the slip's share: slow, the pull a slip angle asks for would overshoot
      const steadying = (massShare * Math.abs(slipSpeed) * this.sidewaysResponse) / timestep;
      side = Math.min(Math.max(side, -steadying), steadying);
      wheel.slipRatio = ratio;
      wheel.sliding = Math.hypot(ratio / wheel.peakSlipRatio, across) > 1;
    }
    if (handOver < 1) {
      this.gripTyre(wheel, load, rollingSpeed, slipSpeed, massShare, alongPull, sidePull, timestep, driveTorque / radius, brakeTorque / radius);
      along = handOver * along + (1 - handOver) * tyreForce.along;
      side = handOver * side + (1 - handOver) * tyreForce.side;
      // the wheel turns with the ground going by, as a grip tyre's does, unless braked into a slide;
      // braked at a standstill it stays still, whichever way the ground's last trembles go
      const held = brakeTorque > 0 && (wheel.sliding || Math.abs(rollingSpeed) < BRAKED_STANDSTILL);
      const rolling = held ? 0 : rollingSpeed / radius;
      wheel.spinSpeed = handOver * wheel.spinSpeed + (1 - handOver) * rolling;
    }
    tyreForce.along = along;
    tyreForce.side = side;
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


/** A wheel's tyre's grip on the ground it is on. */
function gripOf(wheel: Wheel): number {
  return wheel.grip * (wheel.surface?.grip ?? 1);
}

/** A wheel's rolling resistance on the ground it is on. */
function rollingResistanceOf(wheel: Wheel): number {
  return wheel.rollingResistance + (wheel.surface?.rollingResistance ?? 0);
}

/**
 * A slip tyre's pull at a slip `along` it and `across` it, each as a share of its peak slip, of
 * `peak` newtons at most: into `slipForce`, along with the spin and across against the slide.
 * Both share the one grip: pulling hard along leaves less across, the way braking into a corner does.
 */
function combinedSlip(wheel: Wheel, along: number, across: number, peak: number): void {
  const slip = Math.hypot(along, across);
  if (slip < 1e-12) {
    slipForce.along = 0;
    slipForce.side = 0;
    return;
  }
  const pull = (peak * Math.sin(wheel.curveShape * Math.atan(wheel.curveStiffness * slip))) / slip;
  slipForce.along = pull * along;
  slipForce.side = -pull * across;
}

/** A slip tyre's wheel off the ground: driven and braked, with no tyre to hold it. */
function spinFreely(wheel: Wheel, timestep: number): void {
  const spinPerTorque = timestep / wheel.inertia;
  const free = wheel.spinSpeed + (wheel.driveTorque + wheel.driveForce * wheel.radius) * spinPerTorque;
  wheel.spinSpeed = Math.sign(free) * Math.max(Math.abs(free) - (wheel.brakeTorque + wheel.brakeForce * wheel.radius) * spinPerTorque, 0);
  wheel.slipRatio = 0;
  wheel.slipAngle = 0;
}

/** 0 below `from`, 1 above `to`, and smoothly between. */
function smoothstep(from: number, to: number, value: number): number {
  const share = Math.min(Math.max((value - from) / (to - from), 0), 1);
  return share * share * (3 - 2 * share);
}
