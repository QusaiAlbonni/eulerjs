import { Quaternion, Vector3 } from 'three';
import { RAGDOLL_JOINTS, RAGDOLL_PARTS } from './ragdollLayout.js';
import type { PartName } from './ragdollLayout.js';
import type { WalkerPlacement } from './routes.js';

/** Where one part should be, in the walker's own frame: facing +z, feet on y = 0. */
export interface PartPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

export type BodyPose = Record<PartName, PartPose>;

/** How far the legs swing forward and back from the hips, in radians, and how far the knee bends while a leg swings through. */
const HIP_SWING = 0.4;
const KNEE_BEND = 0.7;
/** The arms swing against the legs, this much of the legs' swing. */
const ARM_SWING = 0.6;
const ELBOW_BEND = 0.25;
/**
 * Ground covered per full stride (both legs stepping once), in metres: each stance leg sweeps
 * back twice its swing angle while its foot stays put.
 */
export const STRIDE_LENGTH = 2 * 2 * 0.84 * Math.sin(HIP_SWING);

const SIDEWAYS = new Vector3(1, 0, 0);
const UP = new Vector3(0, 1, 0);
const centers = new Map(RAGDOLL_PARTS.map((part) => [part.name, part.center]));
const jointOf = new Map(RAGDOLL_JOINTS.map((joint) => [joint.child, joint.position]));

/** A pose with every part standing as in the layout; `walkPose` overwrites it. */
export function standingPose(): BodyPose {
  const pose = {} as Record<PartName, PartPose>;
  for (const part of RAGDOLL_PARTS) pose[part.name] = { position: part.center.clone(), quaternion: new Quaternion() };
  return pose;
}

/**
 * The pose at `phase` (radians, one full stride per 2π) of the walk, written into `pose`: legs
 * swinging from the hips with the knee of the swinging leg bent, arms swinging the other way,
 * and the whole body lifted so the lower foot is on the ground.
 */
export function walkPose(phase: number, pose: BodyPose): BodyPose {
  for (const part of RAGDOLL_PARTS) {
    pose[part.name].position.copy(part.center);
    pose[part.name].quaternion.identity();
  }
  for (const [side, legPhase] of [['Left', phase], ['Right', phase + Math.PI]] as const) {
    const hipAngle = HIP_SWING * Math.sin(legPhase);
    // the leg moving forward is in its swing, and bends at the knee to clear the ground
    const kneeAngle = KNEE_BEND * Math.max(0, Math.cos(legPhase));
    swingLimb(pose, `thigh${side}`, `shin${side}`, hipAngle, -kneeAngle);
    swingLimb(pose, `upperArm${side}`, `forearm${side}`, -ARM_SWING * hipAngle, ELBOW_BEND);
  }
  const lowestSole = Math.min(soleHeight(pose, 'shinLeft'), soleHeight(pose, 'shinRight'));
  for (const part of RAGDOLL_PARTS) pose[part.name].position.y -= lowestSole;
  return pose;
}

const upperRotation = new Quaternion();
const lowerRotation = new Quaternion();
const fromJoint = new Vector3();
const middleJoint = new Vector3();
const down = new Vector3();

/**
 * Turns a two-part limb forward by `upperAngle` at its top joint and by `lowerAngle` more at its
 * middle joint (negative bends it back, as a knee does).
 */
function swingLimb(pose: BodyPose, upper: PartName, lower: PartName, upperAngle: number, lowerAngle: number): void {
  const topJoint = jointOf.get(upper)!;
  // turning about +x by a negative angle carries a hanging limb forward, toward +z
  upperRotation.setFromAxisAngle(SIDEWAYS, -upperAngle);
  pose[upper].quaternion.copy(upperRotation);
  pose[upper].position.copy(fromJoint.subVectors(centers.get(upper)!, topJoint).applyQuaternion(upperRotation).add(topJoint));

  const restMiddle = jointOf.get(lower)!;
  middleJoint.subVectors(restMiddle, topJoint).applyQuaternion(upperRotation).add(topJoint);
  lowerRotation.setFromAxisAngle(SIDEWAYS, -lowerAngle).premultiply(upperRotation);
  pose[lower].quaternion.copy(lowerRotation);
  pose[lower].position.copy(fromJoint.subVectors(centers.get(lower)!, restMiddle).applyQuaternion(lowerRotation).add(middleJoint));
}

/** Height of the bottom of a shin's capsule: the sole of the foot. */
function soleHeight(pose: BodyPose, shin: PartName): number {
  const layout = RAGDOLL_PARTS.find((part) => part.name === shin)!;
  down.set(0, -(layout.length / 2 + layout.radius), 0).applyQuaternion(pose[shin].quaternion);
  return pose[shin].position.y + down.y;
}

/** Where a part goes in the world: its place in the walker's pose, turned to the heading and moved to the walker's spot. */
export function placePart(placement: WalkerPlacement, pose: BodyPose, name: PartName, position: Vector3, quaternion: Quaternion): void {
  const facing = quaternion.setFromAxisAngle(UP, placement.heading);
  position.copy(pose[name].position).applyQuaternion(facing).add(placement.position);
  quaternion.multiply(pose[name].quaternion);
}
