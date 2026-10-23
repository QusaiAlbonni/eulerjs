/**
 * The engine: worlds, bodies, colliders, joints, scene queries and the JavaScript backend.
 *
 * @packageDocumentation
 * @module @eulerjs/core
 */
export { World } from './World.js';
export type { WorldOptions } from './World.js';
export { Body, DEFAULT_DENSITY } from './Body.js';
export type { BodyInstance, BodyOptions, ColliderShorthand, InstancedBodyOptions, ObjectBodyOptions } from './Body.js';
export type { BodyMotion, BodyType } from './RigidBodyState.js';
export { DEFAULT_CELLS_ALONG_LONGEST_SIDE, Voxels } from './Voxels.js';
export type { VoxelizeOptions } from './Voxels.js';
export { MassProperties } from './MassProperties.js';
export type { MassSpecification, MeshMassOptions } from './MassProperties.js';
export type { Behavior, Plugin } from './plugins.js';
export { analyzeTopology, forEachTriangle, geometryOfObject } from './geometry.js';
export type { MeshTopology, TriangleVisitor } from './geometry.js';
export { EulerError, InvalidMassError, InvalidMeshError } from './errors.js';
export { DistanceJoint } from './joints/DistanceJoint.js';
export type { DistanceJointOptions } from './joints/DistanceJoint.js';
export type { Joint } from './joints/Joint.js';
export { BaseJoint } from './joints/BaseJoint.js';
export type { BaseJointOptions } from './joints/BaseJoint.js';
export { SixDofJoint } from './joints/SixDofJoint.js';
export type { AxisMotion, JointDrive, JointFrame, JointMeasurement, OrientationDrive, SixAxes, SixDofJointOptions } from './joints/SixDofJoint.js';
export { ConeTwistJoint, FixedJoint, HingeJoint, SliderJoint, TargetJoint } from './joints/presets.js';
export type { ConeTwistJointOptions, HingeJointOptions, JointLimits, SliderJointOptions, TargetJointOptions } from './joints/presets.js';
export { Collider, ROUND_ROLLING_RESISTANCE } from './colliders/Collider.js';
export type { ColliderOptions, ColliderPose } from './colliders/Collider.js';
export { BoxCollider } from './colliders/BoxCollider.js';
export type { BoxColliderOptions } from './colliders/BoxCollider.js';
export { CapsuleCollider } from './colliders/CapsuleCollider.js';
export type { CapsuleColliderOptions } from './colliders/CapsuleCollider.js';
export { CylinderCollider } from './colliders/CylinderCollider.js';
export type { CylinderColliderOptions } from './colliders/CylinderCollider.js';
export { ConeCollider } from './colliders/ConeCollider.js';
export type { ConeColliderOptions } from './colliders/ConeCollider.js';
export { HeightfieldCollider } from './colliders/HeightfieldCollider.js';
export type { HeightfieldColliderOptions } from './colliders/HeightfieldCollider.js';
export { SphereCollider } from './colliders/SphereCollider.js';
export type { SphereColliderOptions } from './colliders/SphereCollider.js';
export { PlaneCollider } from './colliders/PlaneCollider.js';
export { ConvexCollider } from './colliders/ConvexCollider.js';
export type { ConvexColliderOptions, ConvexFace } from './colliders/ConvexCollider.js';
export type { Contact, PhysicsBackend, SensorOverlap, StepSettings } from './backend.js';
export type { ContactEvent, JointBreakEvent, SensorEvent, WorldEventListener, WorldEventName, WorldEvents } from './events.js';
export type { OverlapHit, OverlapOptions, QueryFilter, QueryHit, RayCastOptions, ShapeCastOptions } from './queries.js';
export { JavaScriptBackend } from './javascript/JavaScriptBackend.js';
export type { JavaScriptBackendOptions } from './javascript/JavaScriptBackend.js';
