import { Vector3 } from 'three';

/**
 * A person of about 1.75 m and 70 kg as eleven capsules, standing upright facing +z with +x to
 * their left and their feet on y = 0. Every capsule's axis is vertical in this pose.
 */

export type PartName =
  | 'pelvis'
  | 'chest'
  | 'head'
  | 'upperArmLeft'
  | 'upperArmRight'
  | 'forearmLeft'
  | 'forearmRight'
  | 'thighLeft'
  | 'thighRight'
  | 'shinLeft'
  | 'shinRight';

export type Clothing = 'skin' | 'shirt' | 'trousers';

export interface RagdollPartLayout {
  readonly name: PartName;
  readonly radius: number;
  /** Between the centres of the capsule's rounded ends. */
  readonly length: number;
  readonly mass: number;
  /** Centre in the standing pose. */
  readonly center: Vector3;
  readonly clothing: Clothing;
}

/**
 * How a joint lets the child turn: a ball joint whose limb may lean within a cone and twist a
 * little (spine, neck, shoulders, hips), or a hinge about the sideways axis that bends only one
 * way (elbows forward, knees back). Angles in radians; a hinge's turn is about +x, the walker
 * facing +z, so a knee bends by a positive angle and an elbow by a negative one.
 */
export type RagdollJointKind =
  | { readonly kind: 'ball'; readonly axis: Vector3; readonly swingLimit: number; readonly twistLimit: number }
  | { readonly kind: 'hinge'; readonly lower: number; readonly upper: number };

/** Where two parts are joined, in the standing pose; the child turns about it. */
export interface RagdollJointLayout {
  readonly parent: PartName;
  readonly child: PartName;
  readonly position: Vector3;
  readonly joint: RagdollJointKind;
}

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const spine: RagdollJointKind = { kind: 'ball', axis: UP, swingLimit: 0.5, twistLimit: 0.4 };
const neck: RagdollJointKind = { kind: 'ball', axis: UP, swingLimit: 0.7, twistLimit: 0.9 };
const shoulder: RagdollJointKind = { kind: 'ball', axis: DOWN, swingLimit: 1.6, twistLimit: 1.0 };
const hip: RagdollJointKind = { kind: 'ball', axis: DOWN, swingLimit: 1.3, twistLimit: 0.5 };
const elbow: RagdollJointKind = { kind: 'hinge', lower: -2.5, upper: 0 };
const knee: RagdollJointKind = { kind: 'hinge', lower: 0, upper: 2.4 };

const part = (name: PartName, radius: number, length: number, mass: number, center: Vector3, clothing: Clothing): RagdollPartLayout => ({
  name,
  radius,
  length,
  mass,
  center,
  clothing,
});

export const RAGDOLL_PARTS: readonly RagdollPartLayout[] = [
  part('pelvis', 0.13, 0.1, 11, new Vector3(0, 0.95, 0), 'trousers'),
  part('chest', 0.15, 0.22, 24, new Vector3(0, 1.27, 0), 'shirt'),
  part('head', 0.11, 0.04, 5, new Vector3(0, 1.62, 0), 'skin'),
  part('upperArmLeft', 0.05, 0.2, 2.1, new Vector3(0.25, 1.27, 0), 'shirt'),
  part('upperArmRight', 0.05, 0.2, 2.1, new Vector3(-0.25, 1.27, 0), 'shirt'),
  part('forearmLeft', 0.045, 0.2, 1.6, new Vector3(0.25, 0.98, 0), 'skin'),
  part('forearmRight', 0.045, 0.2, 1.6, new Vector3(-0.25, 0.98, 0), 'skin'),
  part('thighLeft', 0.075, 0.3, 8.5, new Vector3(0.1, 0.65, 0), 'trousers'),
  part('thighRight', 0.075, 0.3, 8.5, new Vector3(-0.1, 0.65, 0), 'trousers'),
  // the bottom of each shin's capsule is the sole of the foot, on the ground
  part('shinLeft', 0.06, 0.36, 4, new Vector3(0.1, 0.24, 0), 'trousers'),
  part('shinRight', 0.06, 0.36, 4, new Vector3(-0.1, 0.24, 0), 'trousers'),
];

export const RAGDOLL_JOINTS: readonly RagdollJointLayout[] = [
  { parent: 'pelvis', child: 'chest', position: new Vector3(0, 1.09, 0), joint: spine },
  { parent: 'chest', child: 'head', position: new Vector3(0, 1.5, 0), joint: neck },
  { parent: 'chest', child: 'upperArmLeft', position: new Vector3(0.25, 1.4, 0), joint: shoulder },
  { parent: 'chest', child: 'upperArmRight', position: new Vector3(-0.25, 1.4, 0), joint: shoulder },
  { parent: 'upperArmLeft', child: 'forearmLeft', position: new Vector3(0.25, 1.13, 0), joint: elbow },
  { parent: 'upperArmRight', child: 'forearmRight', position: new Vector3(-0.25, 1.13, 0), joint: elbow },
  { parent: 'pelvis', child: 'thighLeft', position: new Vector3(0.1, 0.84, 0), joint: hip },
  { parent: 'pelvis', child: 'thighRight', position: new Vector3(-0.1, 0.84, 0), joint: hip },
  { parent: 'thighLeft', child: 'shinLeft', position: new Vector3(0.1, 0.45, 0), joint: knee },
  { parent: 'thighRight', child: 'shinRight', position: new Vector3(-0.1, 0.45, 0), joint: knee },
];
