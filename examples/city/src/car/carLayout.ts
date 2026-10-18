import { Vector3 } from 'three';

/**
 * A small hatchback, in the car's frame: +z forward, +y up, the origin in the middle of the
 * chassis. Numbers are those of a real car of this size where there is one.
 */
export const CAR_LAYOUT = {
  /** The chassis, which is also what the car collides with. */
  chassisSize: new Vector3(1.75, 0.7, 4.1),
  /** The cabin on top of the chassis, drawn only. */
  cabin: { size: new Vector3(1.5, 0.55, 2.1), center: new Vector3(0, 0.6, -0.25) },
  mass: 1200,
  /**
   * Engine, gearbox and floor pan sit low: this much of the mass, as a point this far below the
   * chassis centre, keeps the centre of mass under the middle of the wheels so it doesn't roll over.
   */
  lowMass: { mass: 400, position: new Vector3(0, -0.3, 0.4) },

  wheelRadius: 0.32,
  /** Where each suspension strut is fixed to the chassis; the wheel hangs below it. */
  wheels: [
    { mount: new Vector3(0.78, -0.15, 1.3), steered: true, driven: true },
    { mount: new Vector3(-0.78, -0.15, 1.3), steered: true, driven: true },
    { mount: new Vector3(0.78, -0.15, -1.25), steered: false, driven: false },
    { mount: new Vector3(-0.78, -0.15, -1.25), steered: false, driven: false },
  ],
  /** Travel from the mount to the wheel centre with the spring unloaded. */
  suspensionLength: 0.35,
  /** Per wheel, in N/m: the car's weight compresses each spring by about 10 cm. */
  springStiffness: 30_000,
  /** Per wheel, in N·s/m: about 0.4 of critical damping, so the body settles after a bump or two. */
  springDamping: 2400,

  /**
   * Tyre grip on dry asphalt: the most force a tyre can take is this times its load. Little more
   * and, flung from one full lock to the other, it would grip hard enough to lift both inside
   * wheels and roll over.
   */
  grip: 1.0,
  /** How much grip the rear tyres keep with the handbrake on: little enough to slide. */
  handbrakeGrip: 0.25,
  /** Engine power at the wheels in watts, and the most push it can give at low speed in newtons. */
  enginePower: 60_000,
  engineForce: 6000,
  /** Total braking force at full pedal, in newtons: about 0.9 g. */
  brakeForce: 11_000,
  /** Reverse is slower than forward. */
  reverseFraction: 0.5,
  /** Drag coefficient times frontal area, in m². */
  dragArea: 0.65,
  rollingResistance: 0.015,

  /** Steering lock at low speed, in radians. */
  maxSteerAngle: 0.6,
  /** The lock is halved at this speed, in m/s, so the car stays drivable when fast. */
  steerHalvingSpeed: 15,
};

export type CarLayout = typeof CAR_LAYOUT;
