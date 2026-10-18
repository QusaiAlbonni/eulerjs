import { Quaternion, Vector3 } from 'three';
import type { Body } from '../Body.js';
import { SixDofJoint } from './SixDofJoint.js';
import type { AxisMotion, JointDrive, JointFrame, OrientationDrive, SixDofJointOptions } from './SixDofJoint.js';

/** Options every preset joint takes: the bodies, where the joint is and its axis, loads and collisions. */
type PresetOptions = Omit<SixDofJointOptions, 'linear' | 'angular' | 'linearDrives' | 'angularDrives' | 'orientationDrive'>;

/** The lowest and highest an axis may go. */
export interface JointLimits {
  lower: number;
  upper: number;
}

function motionOf(limits: JointLimits | undefined): AxisMotion {
  return limits ? { lower: limits.lower, upper: limits.upper } : 'free';
}

function limitsOf(motion: AxisMotion): JointLimits | undefined {
  return typeof motion === 'string' ? undefined : motion;
}

export interface HingeJointOptions extends PresetOptions {
  /** How far it may turn either way from where it was made, in radians. Defaults to turning freely. */
  limits?: JointLimits | undefined;
  /** Turns it, as a motor or a servo; see JointDrive. */
  motor?: JointDrive | undefined;
}

/** Lets two bodies turn about one axis only, like a door on its hinges, a wheel on its axle or an elbow. */
export class HingeJoint extends SixDofJoint {
  constructor(options: HingeJointOptions) {
    super({ ...options, linear: ['locked', 'locked', 'locked'], angular: [motionOf(options.limits), 'locked', 'locked'], angularDrives: [options.motor, undefined, undefined] });
  }

  get limits(): JointLimits | undefined {
    return limitsOf(this.angular[0]);
  }

  set limits(limits: JointLimits | undefined) {
    this.angular[0] = motionOf(limits);
  }

  get motor(): JointDrive | undefined {
    return this.angularDrives[0];
  }

  set motor(motor: JointDrive | undefined) {
    this.angularDrives[0] = motor;
  }

  /** How far it has turned from where it was made, in radians. */
  get angle(): number {
    return this.measure().twist;
  }
}

export interface SliderJointOptions extends PresetOptions {
  /** How far it may slide either way along its axis from where it was made, in metres. Defaults to sliding freely. */
  limits?: JointLimits | undefined;
  /** Moves it, as a motor or a servo; see JointDrive. */
  motor?: JointDrive | undefined;
}

/** Lets two bodies slide along one axis only, without turning, like a drawer, a piston or a lift. */
export class SliderJoint extends SixDofJoint {
  constructor(options: SliderJointOptions) {
    super({ ...options, linear: [motionOf(options.limits), 'locked', 'locked'], angular: ['locked', 'locked', 'locked'], linearDrives: [options.motor, undefined, undefined] });
  }

  get limits(): JointLimits | undefined {
    return limitsOf(this.linear[0]);
  }

  set limits(limits: JointLimits | undefined) {
    this.linear[0] = motionOf(limits);
  }

  get motor(): JointDrive | undefined {
    return this.linearDrives[0];
  }

  set motor(motor: JointDrive | undefined) {
    this.linearDrives[0] = motor;
  }

  /** How far it has slid from where it was made, in metres. */
  get position(): number {
    return this.measure().linear.x;
  }
}

/** Holds two bodies together as one, or a body in place in the world, until it breaks. */
export class FixedJoint extends SixDofJoint {
  constructor(options: PresetOptions) {
    super({ ...options, linear: ['locked', 'locked', 'locked'], angular: ['locked', 'locked', 'locked'] });
  }
}

export interface ConeTwistJointOptions extends PresetOptions {
  /** Turns the limb toward an orientation, as a muscle would; see OrientationDrive. */
  orientationDrive?: OrientationDrive | undefined;
  /**
   * How far the axis may tilt away from where it was, in radians: one angle for a round cone, or
   * one about each of the joint's y and z axes for an oval one. Defaults to tilting freely.
   */
  swingLimit?: number | { aboutY: number; aboutZ: number } | undefined;
  /** How far it may twist about its axis, in radians. Defaults to twisting freely. */
  twistLimits?: JointLimits | undefined;
}

/**
 * A ball joint whose axis may only tilt within a cone and twist within limits, like a shoulder or
 * a hip: the joint for ragdolls.
 */
export class ConeTwistJoint extends SixDofJoint {
  constructor(options: ConeTwistJointOptions) {
    const swing = options.swingLimit;
    const aboutY = typeof swing === 'number' ? swing : swing?.aboutY;
    const aboutZ = typeof swing === 'number' ? swing : swing?.aboutZ;
    super({
      ...options,
      linear: ['locked', 'locked', 'locked'],
      angular: [motionOf(options.twistLimits), aboutY === undefined ? 'free' : { lower: -aboutY, upper: aboutY }, aboutZ === undefined ? 'free' : { lower: -aboutZ, upper: aboutZ }],
    });
  }
}

export interface TargetJointOptions extends Pick<PresetOptions, 'breakForce' | 'breakTorque'> {
  /** The body to pull. */
  body: Body;
  /** The point of the body pulled to the target, in its own frame. Defaults to its origin. */
  anchor?: Vector3 | undefined;
  /** Where to pull the anchor to, in world space. Defaults to where it is. */
  position?: Vector3 | undefined;
  /** How to turn the body. Defaults to how it is turned. */
  quaternion?: Quaternion | undefined;
  /** How fast it springs to the target, in Hz, whatever its mass. Defaults to 5; 0 lets it go. */
  frequency?: number | undefined;
  /**
   * How fast it turns to the target's orientation, in Hz, if not as fast as it moves: say, faster
   * for a body that carries others by it, which are harder to turn than to move. Defaults to
   * `frequency`.
   */
  turnFrequency?: number | undefined;
  /** 1, the default, just doesn't overshoot. */
  dampingRatio?: number | undefined;
  /** The most force it pulls with along each axis, in N. Defaults to Infinity. */
  maxForce?: number | undefined;
  /** The most torque it turns it with, in N·m. Defaults to Infinity. */
  maxTorque?: number | undefined;
  /** Whether it turns the body to the target's orientation as well as pulling it there. Defaults to true. */
  turns?: boolean | undefined;
}

const unturned = new Quaternion();
const targetInverse = new Quaternion();
const localVelocity = new Vector3();

/**
 * Pulls a body toward a pose in the world, as a spring and damper with limits: for dragging a
 * body with the mouse, carrying it, or leading an active ragdoll along by its hips. Move the
 * target with `setTarget` as often as you like. It pulls as hard as a spring of its frequency on
 * the body's mass, so a body it holds up sags by g / (2π frequency)²; take away its gravity
 * (`gravityScale = 0`) to have it hold the pose exactly.
 */
export class TargetJoint extends SixDofJoint {
  private settings: { frequency: number; turnFrequency: number | undefined; dampingRatio: number; maxForce: number; maxTorque: number; turns: boolean };

  constructor(options: TargetJointOptions) {
    const body = options.body;
    const anchor = options.anchor ?? new Vector3();
    const position = options.position ?? body.pointToWorld(anchor, new Vector3());
    super({
      bodyA: body,
      breakForce: options.breakForce,
      breakTorque: options.breakTorque,
      frameA: { position: anchor, quaternion: unturned },
      frameB: { position, quaternion: options.quaternion ?? body.quaternion },
      linear: ['free', 'free', 'free'],
      angular: ['free', 'free', 'free'],
    });
    this.settings = {
      frequency: options.frequency ?? 5,
      turnFrequency: options.turnFrequency,
      dampingRatio: options.dampingRatio ?? 1,
      maxForce: options.maxForce ?? Infinity,
      maxTorque: options.maxTorque ?? Infinity,
      turns: options.turns ?? true,
    };
    this.applySettings();
  }

  /** Where the anchor is pulled to and how the body is turned, in world space. */
  get target(): JointFrame {
    return this.frameB;
  }

  /** How fast it springs to the target, in Hz; 0 lets the body go. */
  get frequency(): number {
    return this.settings.frequency;
  }

  set frequency(frequency: number) {
    this.settings.frequency = frequency;
    this.applySettings();
  }

  /**
   * Moves the target: where to pull the anchor to, how to turn the body, and how fast the target
   * itself is moving, which the body is pulled to match so that it keeps up instead of lagging.
   */
  setTarget(position: Vector3, quaternion?: Quaternion, velocity?: Vector3): void {
    this.frameB.position.copy(position);
    if (quaternion) this.frameB.quaternion.copy(quaternion);
    // the linear drives work along the target's own axes
    if (velocity) localVelocity.copy(velocity).applyQuaternion(targetInverse.copy(this.frameB.quaternion).invert());
    else localVelocity.set(0, 0, 0);
    for (let index = 0; index < 3; index++) {
      const drive = this.linearDrives[index];
      if (drive) drive.targetVelocity = localVelocity.getComponent(index);
    }
  }

  private applySettings(): void {
    const { frequency, turnFrequency, dampingRatio, maxForce, maxTorque, turns } = this.settings;
    for (let index = 0; index < 3; index++) {
      const targetVelocity = this.linearDrives[index]?.targetVelocity ?? 0;
      this.linearDrives[index] = frequency > 0 ? { targetPosition: 0, targetVelocity, frequency, dampingRatio, maxForce } : undefined;
    }
    // letting go lets go of both
    this.orientationDrive = frequency > 0 && turns ? { target: new Quaternion(), frequency: turnFrequency ?? frequency, dampingRatio, maxTorque } : undefined;
  }
}
