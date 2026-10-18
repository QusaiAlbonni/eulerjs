import { CapsuleGeometry, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { Scene } from 'three';
import { Body, CapsuleCollider, ConeTwistJoint, HingeJoint, TargetJoint } from 'eulerjs';
import type { SixDofJoint, World } from 'eulerjs';
import { RAGDOLL_JOINTS, RAGDOLL_PARTS } from './ragdollLayout.js';
import type { Clothing, PartName, RagdollJointLayout } from './ragdollLayout.js';
import type { WalkerPlacement } from './routes.js';
import { placePart } from './walkCycle.js';
import type { BodyPose } from './walkCycle.js';

/**
 * How stiffly the limbs hold the walk's pose at their joints, in Hz: a muscle's worth, not a
 * robot's. The engine works out each joint's stiffness from the limbs it turns.
 */
const MUSCLE_FREQUENCY = 6;
/**
 * How stiffly the hips are carried along the walk and turned its way, in Hz, as springs on the
 * pelvis alone: they carry the whole body by it, six times as heavy and far harder to turn, so
 * the person as a whole follows at about 2.5 Hz either way.
 */
const CARRY_FREQUENCY = 6;
const CARRY_TURN_FREQUENCY = 30;
/**
 * The friction in each joint, in N·m for every kilogram of the limb it turns: enough that a
 * fallen body's round limbs stop rolling over each other within their joints' limits, too
 * little to hold a limb up against its own weight.
 */
const JOINT_FRICTION_PER_KILOGRAM = 0.3;
/**
 * How fast a limp body's joints take the spin out of its limbs, per second: the tone of the
 * muscles, as a damper on every joint as stiff as the limb is hard to turn about it. Friction
 * alone stops a limb, but not the last tremble of a heap of them.
 */
const LIMP_DAMPING_RATE = 6;
/** Limbs are soft and clothed: they hardly roll at all over the ground or each other. */
const LIMB_ROLLING_RESISTANCE = 0.1;

const skin = new MeshStandardMaterial({ color: 0xd9a383, roughness: 0.8 });
const trousers = new MeshStandardMaterial({ color: 0x2d3340, roughness: 0.9 });
const SHIRT_COLORS = [0xb8442f, 0x3a6ea5, 0xe0c341, 0x4f8a4c, 0xe8e6e1, 0x7a4d8f];

const targetPosition = new Vector3();
const targetQuaternion = new Quaternion();
const relative = new Quaternion();

/** A joint of the body and how to drive it toward the walk's pose. */
interface DrivenJoint {
  readonly joint: SixDofJoint;
  readonly layout: RagdollJointLayout;
  /** The turn of the joint's frames from their parts, the same on both: see `jointFor`. */
  readonly turn: Quaternion;
  /** How much its damper resists turning while the body is limp, in N·m·s/rad. */
  readonly limpDamping: number;
}

/**
 * One person: eleven capsules joined at the spine, neck, shoulders and hips by ball joints that
 * only lean so far, and at the elbows and knees by hinges that bend only one way.
 * While walking it is an active ragdoll: its joints' drives turn every limb toward where the
 * walk puts it, as muscles do, and a target joint carries its hips along the route, with gravity
 * off so the pose holds exactly; it still bumps into whatever it meets. Limp, gravity comes back,
 * the drives let go and the joints alone hold it together, and it falls in a heap.
 */
export class Pedestrian {
  readonly parts: ReadonlyMap<PartName, Body>;
  readonly joints: readonly SixDofJoint[];
  private readonly driven: readonly DrivenJoint[];
  /** Carries the hips along the walk. */
  private readonly carrier: TargetJoint;
  private isWalking = true;

  constructor(world: World, placement: WalkerPlacement, pose: BodyPose, options: { scene?: Scene | undefined; shirtColor?: number | undefined } = {}) {
    const shirt = new MeshStandardMaterial({ color: options.shirtColor ?? SHIRT_COLORS[0]!, roughness: 0.85 });
    const materials: Record<Clothing, MeshStandardMaterial> = { skin, shirt, trousers };
    const parts = new Map<PartName, Body>();
    for (const layout of RAGDOLL_PARTS) {
      const collider = new CapsuleCollider({ radius: layout.radius, length: layout.length, friction: 0.8, rollingResistance: LIMB_ROLLING_RESISTANCE });
      let object: Mesh | undefined;
      if (options.scene) {
        object = new Mesh(new CapsuleGeometry(layout.radius, layout.length, 3, 8), materials[layout.clothing]);
        object.castShadow = true;
        options.scene.add(object);
      }
      placePart(placement, pose, layout.name, targetPosition, targetQuaternion);
      parts.set(layout.name, world.addBody(new Body({ colliders: [collider], mass: layout.mass, position: targetPosition, quaternion: targetQuaternion, object })));
    }
    this.parts = parts;
    this.driven = RAGDOLL_JOINTS.map((layout) => {
      const turn = layout.joint.kind === 'ball' ? new Quaternion().setFromUnitVectors(xAxis, layout.joint.axis) : new Quaternion();
      return { joint: world.addJoint(jointFor(layout, parts.get(layout.parent)!, parts.get(layout.child)!, turn)), layout, turn, limpDamping: LIMP_DAMPING_RATE * inertiaAboutJoint(layout) };
    });
    this.joints = this.driven.map((driven) => driven.joint);
    this.carrier = world.addJoint(new TargetJoint({ body: parts.get('pelvis')!, frequency: CARRY_FREQUENCY, turnFrequency: CARRY_TURN_FREQUENCY }));
    this.walking = true;
    this.followPose(placement, pose);
  }

  /** Whether the person is walking, carried and held in the walk's pose; or limp, falling under gravity. */
  get walking(): boolean {
    return this.isWalking;
  }

  set walking(walking: boolean) {
    this.isWalking = walking;
    for (const part of this.parts.values()) part.gravityScale = walking ? 0 : 1;
    this.carrier.frequency = walking ? CARRY_FREQUENCY : 0;
    for (const { joint, limpDamping } of this.driven) {
      // walking, a spring to the pose; limp, only a damper
      if (joint instanceof HingeJoint) joint.motor = walking ? { targetPosition: 0, frequency: MUSCLE_FREQUENCY } : { damping: limpDamping };
      else joint.orientationDrive = walking ? { target: new Quaternion(), frequency: MUSCLE_FREQUENCY } : { target: new Quaternion(), damping: limpDamping };
      // with its drives changed, a sleeping body would otherwise lie on as it was
      joint.bodyA.wakeUp();
    }
  }

  /** Drives every joint toward its turn in `pose`, and carries the hips to where `placement` puts them. */
  followPose(placement: WalkerPlacement, pose: BodyPose): void {
    if (!this.isWalking) return;
    for (const { joint, layout, turn } of this.driven) {
      // the child's frame in the parent's, as the pose turns them: (parent turn)⁻¹ (child turn)
      relative.copy(pose[layout.parent].quaternion).multiply(turn).invert().multiply(pose[layout.child].quaternion).multiply(turn);
      if (joint instanceof HingeJoint) {
        // a hinge turns about its frames' x axis only
        if (relative.w < 0) relative.set(-relative.x, -relative.y, -relative.z, -relative.w);
        joint.motor!.targetPosition = 2 * Math.atan2(relative.x, relative.w);
      } else joint.orientationDrive!.target.copy(relative);
    }
    placePart(placement, pose, 'pelvis', targetPosition, targetQuaternion);
    this.carrier.setTarget(targetPosition, targetQuaternion, placement.velocity);
  }

  /** Puts every part straight into `pose` at `placement`, moving with it, and starts walking. */
  standUp(placement: WalkerPlacement, pose: BodyPose): void {
    for (const [name, body] of this.parts) {
      placePart(placement, pose, name, targetPosition, targetQuaternion);
      body.setPose(targetPosition, targetQuaternion);
      body.velocity.copy(placement.velocity);
      body.angularVelocity.set(0, 0, 0);
    }
    this.walking = true;
    this.followPose(placement, pose);
  }
}

const xAxis = new Vector3(1, 0, 0);

/** Roughly how hard a joint's limb is to turn about it: the limb as a rod from its centre, m (d² + l² / 12). */
function inertiaAboutJoint(layout: RagdollJointLayout): number {
  const limb = RAGDOLL_PARTS.find((part) => part.name === layout.child)!;
  const reach = layout.position.distanceTo(limb.center);
  const span = limb.length + 2 * limb.radius;
  return limb.mass * (reach * reach + (span * span) / 12);
}

/**
 * The joint for a layout, with both frames placed as in the standing pose, where every part is
 * unturned, and turned by `turn` from the parts: so the limits count from standing straight,
 * however the person stands when made. Two parts that overlap where they are joined, such as a
 * thigh and a shin at the knee, can't be kept apart and don't collide with each other.
 */
function jointFor(layout: RagdollJointLayout, parent: Body, child: Body, turn: Quaternion): SixDofJoint {
  const parentCenter = RAGDOLL_PARTS.find((part) => part.name === layout.parent)!.center;
  const childCenter = RAGDOLL_PARTS.find((part) => part.name === layout.child)!.center;
  const settings = layout.joint;
  const frameA = { position: layout.position.clone().sub(parentCenter), quaternion: turn };
  const frameB = { position: layout.position.clone().sub(childCenter), quaternion: turn };
  const friction = JOINT_FRICTION_PER_KILOGRAM * RAGDOLL_PARTS.find((part) => part.name === layout.child)!.mass;
  const common = { bodyA: parent, bodyB: child, frameA, frameB, friction, collideConnected: 'unlessOverlapping' as const };
  if (settings.kind === 'hinge') return new HingeJoint({ ...common, limits: { lower: settings.lower, upper: settings.upper } });
  return new ConeTwistJoint({ ...common, swingLimit: settings.swingLimit, twistLimits: { lower: -settings.twistLimit, upper: settings.twistLimit } });
}
