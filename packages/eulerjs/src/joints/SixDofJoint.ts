import { Quaternion, Vector3 } from 'three';
import type { Body } from '../Body.js';
import { EulerError } from '../errors.js';
import { BaseJoint } from './BaseJoint.js';
import type { BaseJointOptions } from './BaseJoint.js';
import { swingAndTwist } from './sixDofMath.js';
import type { FrameTurn } from './sixDofMath.js';

/**
 * What a joint lets one of its six axes do: nothing ('locked'), anything ('free'), or move
 * between two limits, in metres along a linear axis or radians about an angular one.
 */
export type AxisMotion = 'locked' | 'free' | { lower: number; upper: number };

/**
 * A drive pushes an axis toward a target, as a spring-damper with a force limit: a motor holds a
 * speed (`targetVelocity`, and by default infinite damping), a servo holds a position
 * (`targetPosition` with a `stiffness`, and some `damping` to keep it from ringing).
 * Force = stiffness × (targetPosition - position) + damping × (targetVelocity - velocity),
 * at most `maxForce`, all solved implicitly so that any stiffness is stable.
 */
export interface JointDrive {
  targetPosition?: number | undefined;
  /** In m/s along a linear axis, rad/s about an angular one. Defaults to 0. */
  targetVelocity?: number | undefined;
  /** In N/m or N·m/rad. Defaults to 0. */
  stiffness?: number | undefined;
  /** In N·s/m or N·m·s/rad. Defaults to infinite without a stiffness, making a motor, and to 0 with one. */
  damping?: number | undefined;
  /**
   * Instead of `stiffness` and `damping`: how fast the axis springs to its target, in Hz, and how
   * damped it is (1, the default, just doesn't overshoot), whatever mass it moves; the engine
   * works out the stiffness and damping from the mass along the axis.
   */
  frequency?: number | undefined;
  dampingRatio?: number | undefined;
  /** The most force (N) or torque (N·m) the drive gives. Defaults to Infinity. */
  maxForce?: number | undefined;
}

/**
 * A drive that turns the moving frame toward an orientation relative to the base frame, about
 * whichever axis takes it there (a slerp drive): the servo for ball joints, such as an active
 * ragdoll's shoulders and hips. Stiffness and damping as for a JointDrive, in N·m/rad and N·m·s/rad,
 * or `frequency` and `dampingRatio`.
 */
export interface OrientationDrive {
  /** The moving frame's orientation relative to the base frame to turn toward. */
  target: Quaternion;
  stiffness?: number | undefined;
  damping?: number | undefined;
  frequency?: number | undefined;
  dampingRatio?: number | undefined;
  /** The most torque it gives, in N·m. Defaults to Infinity. */
  maxTorque?: number | undefined;
}

/** A frame fixed in a body, in the body's own frame, or in the world for a joint without body B. */
export interface JointFrame {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

/** The three linear axes, then the three angular ones (twist about x, swing about y, swing about z). */
export type SixAxes<Value> = [Value, Value, Value];

export interface SixDofJointOptions extends BaseJointOptions {
  /** Where the joint is, in world space, as the bodies are now. Defaults to body A's origin. */
  anchor?: Vector3 | undefined;
  /** The joint's x axis, in world space, as the bodies are now: the twist axis, a hinge's axis, a slider's direction. Defaults to world x. */
  axis?: Vector3 | undefined;
  /** Or the joint's frame on body A exactly, in A's own frame, instead of `anchor` and `axis`. */
  frameA?: JointFrame | undefined;
  /** And on body B, in B's frame, or in the world without body B. */
  frameB?: JointFrame | undefined;
  /**
   * What the joint lets frame B do along frame A's x, y and z axes; for a joint to the world,
   * what it lets body A's frame do in the world's. Defaults to all locked.
   */
  linear?: SixAxes<AxisMotion> | undefined;
  /** What it lets that frame do turning: twist about its x axis, swing about the other frame's y and z. Defaults to all locked. */
  angular?: SixAxes<AxisMotion> | undefined;
  linearDrives?: SixAxes<JointDrive | undefined> | undefined;
  angularDrives?: SixAxes<JointDrive | undefined> | undefined;
  orientationDrive?: OrientationDrive | undefined;
  /**
   * Friction in the joint, in N·m: every angular axis it doesn't lock resists turning with up to
   * this much torque, as a stiff joint or tensed muscles do; a joint that locks none, such as a
   * ball joint, resists turning every way alike. Defaults to 0.
   */
  friction?: number | undefined;
  /** Friction along the linear axes it doesn't lock, in N. Defaults to 0. */
  linearFriction?: number | undefined;
}

/** Where a joint's moving frame is relative to its base frame (see `SixDofJoint.roles`). */
export interface JointMeasurement {
  /** The moving frame's origin in the base frame's axes, in metres. */
  linear: Vector3;
  /** Twist about the moving frame's x axis, and swing about the base frame's y and z, in radians. */
  twist: number;
  swing: Vector3;
}

const worldAnchorScratch = new Vector3();
const xAxis = new Vector3(1, 0, 0);

/**
 * The general joint: a frame fixed in each body, and for each of the six ways frame B can move
 * relative to frame A (along its three axes, and twisting and swinging about them) whether it
 * may, between which limits, and what drives it. Hinges, sliders, fixed joints and cone-twist
 * joints are particular settings of it. Its settings can be changed between steps.
 */
export class SixDofJoint extends BaseJoint {
  readonly frameA: JointFrame;
  readonly frameB: JointFrame;
  readonly linear: SixAxes<AxisMotion>;
  readonly angular: SixAxes<AxisMotion>;
  readonly linearDrives: SixAxes<JointDrive | undefined>;
  readonly angularDrives: SixAxes<JointDrive | undefined>;
  orientationDrive: OrientationDrive | undefined;
  friction: number;
  linearFriction: number;

  constructor(options: SixDofJointOptions) {
    super(options);
    if ((options.frameA === undefined) !== (options.frameB === undefined)) throw new EulerError('Give a joint both frameA and frameB, or neither');
    if (options.frameA && options.frameB) {
      this.frameA = copyFrame(options.frameA);
      this.frameB = copyFrame(options.frameB);
    } else {
      // both frames where the joint is now, turned so their x axes lie along `axis`
      const anchor = options.anchor ?? options.bodyA.position;
      const turn = new Quaternion().setFromUnitVectors(xAxis, (options.axis ?? xAxis).clone().normalize());
      this.frameA = frameIn(options.bodyA, anchor, turn);
      this.frameB = options.bodyB ? frameIn(options.bodyB, anchor, turn) : { position: anchor.clone(), quaternion: turn };
    }
    this.linear = [...(options.linear ?? ['locked', 'locked', 'locked'])];
    this.angular = [...(options.angular ?? ['locked', 'locked', 'locked'])];
    this.linearDrives = [...(options.linearDrives ?? [undefined, undefined, undefined])];
    this.angularDrives = [...(options.angularDrives ?? [undefined, undefined, undefined])];
    this.orientationDrive = options.orientationDrive;
    this.friction = options.friction ?? 0;
    this.linearFriction = options.linearFriction ?? 0;
    for (const motion of [...this.linear, ...this.angular]) checkMotion(motion);
  }

  /**
   * The joint's base frame and the frame that moves against it: frame A on body A and frame B on
   * body B; or, for a joint to the world, the world's frame (frameB) and body A's (frameA), so that
   * either way what is measured is how the second body moves.
   */
  get roles(): { base: JointFrame; baseBody: Body | undefined; moving: JointFrame; movingBody: Body } {
    return this.bodyB
      ? { base: this.frameA, baseBody: this.bodyA, moving: this.frameB, movingBody: this.bodyB }
      : { base: this.frameB, baseBody: undefined, moving: this.frameA, movingBody: this.bodyA };
  }

  /** Where the moving frame is relative to the base frame (see `roles`), as the bodies are now. */
  measure(): JointMeasurement {
    const { base, baseBody, moving, movingBody } = this.roles;
    const baseFrame = worldFrame(base, baseBody);
    const movingFrame = worldFrame(moving, movingBody);
    const inverse = baseFrame.quaternion.clone().invert();
    const turn: FrameTurn = { twist: 0, swing: new Vector3() };
    swingAndTwist(inverse.clone().multiply(movingFrame.quaternion), turn);
    return { linear: movingFrame.position.clone().sub(baseFrame.position).applyQuaternion(inverse), twist: turn.twist, swing: turn.swing };
  }
}

/** A frame in world space: fixed in `body`, or already in the world without one. */
function worldFrame(frame: JointFrame, body: Body | undefined): { position: Vector3; quaternion: Quaternion } {
  if (!body) return { position: frame.position.clone(), quaternion: frame.quaternion.clone() };
  return { position: body.pointToWorld(frame.position, new Vector3()), quaternion: body.quaternion.clone().multiply(frame.quaternion) };
}

function copyFrame(frame: JointFrame): JointFrame {
  return { position: frame.position.clone(), quaternion: frame.quaternion.clone().normalize() };
}

/** A frame at `anchor`, turned by `turn` in world space, as seen from `body`. */
function frameIn(body: BaseJoint['bodyA'], anchor: Vector3, turn: Quaternion): JointFrame {
  return { position: body.worldToLocal(worldAnchorScratch.copy(anchor)).clone(), quaternion: body.quaternion.clone().invert().multiply(turn) };
}

function checkMotion(motion: AxisMotion): void {
  if (typeof motion === 'string') return;
  if (!(motion.lower <= motion.upper)) throw new RangeError(`a joint's lower limit must not be above its upper one, got ${motion.lower} and ${motion.upper}`);
}
