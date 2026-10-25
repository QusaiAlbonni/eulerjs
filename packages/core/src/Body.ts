import { DynamicDrawUsage, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, InstancedMesh, Object3D } from 'three';
import { InvalidMassError, InvalidMeshError } from './errors.js';
import { geometryOfObject } from './geometry.js';
import { MassProperties } from './MassProperties.js';
import type { MassSpecification } from './MassProperties.js';
import { Voxels } from './Voxels.js';
import type { Collider } from './colliders/Collider.js';
import { fitCollider } from './colliders/fitCollider.js';
import type { Behavior } from './plugins.js';
import { RigidBodyState } from './RigidBodyState.js';
import type { BodyType } from './RigidBodyState.js';
import type { World } from './World.js';

export interface BodyOptions {
  type?: BodyType | undefined;
  /**
   * Mass, centre of mass and inertia. Leave out for a dynamic body with solid colliders to have
   * them worked out from those, with `mass` or `density`.
   */
  massProperties?: MassProperties | undefined;
  /** Overrides the mass in `massProperties`, the inertia scaled to match; or, without them, the total mass of the colliders. */
  mass?: number | undefined;
  /** Without `massProperties` or `mass`, the colliders' density in kg/m³. Defaults to water, 1000. */
  density?: number | undefined;
  /** Origin of the body frame in world space. Defaults to the bound object's world position. */
  position?: Vector3 | undefined;
  /** Orientation of the body frame. Defaults to the bound object's world orientation. */
  quaternion?: Quaternion | undefined;
  /** Velocity of the centre of mass, in m/s. */
  velocity?: Vector3 | undefined;
  /** Angular velocity in world space, in rad/s. */
  angularVelocity?: Vector3 | undefined;
  /** Fraction of linear velocity lost per second, applied as v *= exp(-linearDamping * dt). */
  linearDamping?: number | undefined;
  /** Fraction of angular velocity lost per second, applied as w *= exp(-angularDamping * dt). */
  angularDamping?: number | undefined;
  /** Multiplier on the world's gravity for this body; 0 turns gravity off. */
  gravityScale?: number | undefined;
  /** A three.js object that follows the body when the world syncs objects. */
  object?: Object3D | undefined;
  /**
   * One instance of a three.js InstancedMesh that follows the body, as `object` does: for many
   * bodies that look alike drawn in one go. Its starting pose, and the scale it keeps, are read
   * from the instance's matrix. `world.addInstances` makes a body for every instance of a mesh.
   */
  instance?: BodyInstance | undefined;
  /** The body's volume as cells, for behaviours that need it such as buoyancy. */
  voxels?: Voxels | undefined;
  /** The shapes the body collides with, in its own frame. */
  colliders?: readonly Collider[] | undefined;
  /** Whether the body may fall asleep once it has been still for a while. Defaults to true. */
  canSleep?: boolean | undefined;
}

/** Options for a body made from a three.js object, which supplies its shape and starting pose. */
export interface ObjectBodyOptions extends Omit<BodyOptions, 'object' | 'massProperties' | 'mass' | 'density' | 'voxels' | 'colliders'> {
  /** Total mass in kg. Give this or `density`. */
  mass?: number | undefined;
  /** In kg/m³. Defaults to water, 1000, when no mass is given either. */
  density?: number | undefined;
  /**
   * How to get the mass properties from the object's meshes: `mesh` integrates the closed
   * surface exactly (the default); `voxels` fills it with cells, which also works for open
   * meshes such as a hull with no deck, and keeps the cells for buoyancy. With `mesh`, a mesh
   * that isn't closed is weighed by its colliders instead, if it has solid ones.
   */
  shape?: 'mesh' | 'voxels' | undefined;
  /** Cell size for `shape: 'voxels'`, in metres. Defaults to a sixteenth of the longest side. */
  cellSize?: number | undefined;
  /**
   * What the body collides as: a shape fitted around the object's meshes, `'box'`, `'sphere'`,
   * `'convex'` (their hull), or `'cylinder'`, `'cone'` or `'capsule'` standing along their y axis;
   * or your own collider instances. Without meshes, the colliders also give the body its mass properties.
   *
   * There is no default: without `collider` the body collides with nothing. That is intended. The
   * mass always comes from the meshes, but the mesh drawn is seldom the shape to collide as (too
   * detailed, or not convex), so which one is your choice.
   */
  collider?: ColliderShorthand | Collider | readonly Collider[] | undefined;
}

/** One instance of an InstancedMesh, for a body to be drawn as. */
export interface BodyInstance {
  readonly mesh: InstancedMesh;
  readonly index: number;
}

/** Options for the bodies `world.addInstances` makes, one for each instance of an InstancedMesh. */
export interface InstancedBodyOptions extends Omit<ObjectBodyOptions, 'shape' | 'cellSize' | 'collider' | 'position' | 'quaternion' | 'velocity' | 'angularVelocity'> {
  /**
   * What each body collides as: a shape fitted around the mesh's geometry (with the instance's
   * scale), or a function making the colliders for the instance at `index`. Every body needs
   * colliders of its own, so it is a function rather than colliders to share.
   */
  collider?: ColliderShorthand | ((index: number) => Collider | readonly Collider[]) | undefined;
}

/** The shapes `collider` can name, to be fitted around an object's meshes. */
export type ColliderShorthand = 'box' | 'sphere' | 'convex' | 'cylinder' | 'cone' | 'capsule';

/** Density used when a body made from an object is given neither a mass nor a density: water. */
export const DEFAULT_DENSITY = 1000;

const leverArm = new Vector3();
const worldPoint = new Vector3();
const torqueFromForce = new Vector3();
const unitScale = new Vector3(1, 1, 1);
const interpolatedPosition = new Vector3();
const interpolatedQuaternion = new Quaternion();
const objectWorldMatrix = new Matrix4();
const parentInverseMatrix = new Matrix4();
const ignoredScale = new Vector3();
const identity = new Matrix4();
const instancePose = new Matrix4();
const instancePosition = new Vector3();
const instanceQuaternion = new Quaternion();

/** Where an instance is in the world: its matrix, in the mesh's frame, carried into the world's. */
function instanceWorldMatrix({ mesh, index }: BodyInstance, target: Matrix4): Matrix4 {
  mesh.updateWorldMatrix(true, false);
  mesh.getMatrixAt(index, target);
  return target.premultiply(mesh.matrixWorld);
}

/** What a body has asked the backend to do to its sleep state since the last sync. */
type SleepRequest = 'wake' | 'sleep' | undefined;

/**
 * A rigid body. The body frame is the frame its mass properties are expressed in, normally the
 * local frame of the mesh it was built from. Dynamics happen about the centre of mass; `position`
 * is the frame's origin, so a bound object's origin lands exactly on it.
 *
 * Its pose and velocities are yours to read and change, like an Object3D's. Changes take effect
 * when the world next steps; the world writes the backend's results back after every step.
 */
export class Body extends RigidBodyState {
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  /** Whether the body may fall asleep once it has been still for a while. */
  canSleep: boolean;
  readonly object: Object3D | undefined;
  /** The instance of an InstancedMesh that follows the body, if it is drawn as one. */
  readonly instance: BodyInstance | undefined;
  /** The body's volume as cells, if it was made with them; buoyancy uses it. */
  readonly voxels: Voxels | undefined;
  /** The shapes the body collides with. Change them with `addCollider` and `removeCollider`. */
  readonly colliders: readonly Collider[];

  /** @internal Force gathered for the current step, in world space; handed to the backend before it steps. */
  readonly force = new Vector3();
  /** @internal Torque about the centre of mass gathered for the current step, in world space. */
  readonly torque = new Vector3();

  /** Pose at the start of the last step, used to interpolate rendering between steps. */
  readonly previousPosition = new Vector3();
  readonly previousQuaternion = new Quaternion();

  private readonly colliderList: Collider[];
  private readonly attachedBehaviors: Behavior[] = [];
  private owningWorld: World | undefined;
  private asleep = false;
  private pendingSleepRequest: SleepRequest;
  /** Whether the matrix and world inverse inertia are older than the pose the last step ended with. */
  private orientationStateStale = false;
  /** The scale the instance is drawn with: the body has none, but the instance keeps its own. */
  private readonly instanceScale = new Vector3(1, 1, 1);
  /** Whether the instance has been written since the body fell asleep, so needn't be again. */
  private instanceWrittenAsleep = false;

  constructor(options: BodyOptions = {}) {
    super(options.type ?? 'dynamic');
    this.linearDamping = options.linearDamping ?? 0;
    this.angularDamping = options.angularDamping ?? 0;
    this.gravityScale = options.gravityScale ?? 1;
    this.canSleep = options.canSleep ?? true;
    this.object = options.object;
    this.instance = options.instance;
    this.voxels = options.voxels;
    this.colliderList = [...(options.colliders ?? [])];
    this.colliders = this.colliderList;

    if (options.massProperties !== undefined) {
      const massProperties = options.mass === undefined ? options.massProperties : options.massProperties.withMass(options.mass);
      this.assignMassProperties(massProperties);
    } else if (this.type === 'dynamic') {
      const specification = options.mass === undefined ? { density: options.density ?? DEFAULT_DENSITY } : { mass: options.mass };
      const fromColliders = massPropertiesOfColliders(this.colliderList, specification);
      if (!fromColliders) {
        throw new InvalidMassError('A dynamic body needs massProperties, or solid colliders to work them out from, e.g. MassProperties.fromMesh(geometry, { mass })');
      }
      this.assignMassProperties(fromColliders);
    }

    this.readInitialPose(options);
    if (options.velocity) this.velocity.copy(options.velocity);
    if (options.angularVelocity) this.angularVelocity.copy(options.angularVelocity);
    this.quaternion.normalize();
    this.previousPosition.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
    this.refreshDerivedState();
  }

  /**
   * A body for a three.js object, with mass properties computed from its meshes and its starting
   * pose read from it. `world.addBody(object, options)` does this for you.
   */
  static fromObject(object: Object3D, options: ObjectBodyOptions = {}): Body {
    const { mass, density, shape, cellSize, collider, ...bodyOptions } = options;
    const geometry = geometryOfObject(object);
    const colliders = collidersFor(collider, geometry);
    if ((bodyOptions.type ?? 'dynamic') !== 'dynamic') return new Body({ ...bodyOptions, object, colliders });

    const specification = mass === undefined ? { density: density ?? DEFAULT_DENSITY } : { mass };
    if (!geometry) {
      const fromColliders = massPropertiesOfColliders(colliders, specification);
      if (!fromColliders) {
        throw new InvalidMassError('The object has no meshes or solid colliders to compute mass properties from');
      }
      return new Body({ ...bodyOptions, object, colliders, massProperties: fromColliders });
    }
    if (shape === 'voxels') {
      const voxels = Voxels.fromGeometry(geometry, { cellSize });
      return new Body({ ...bodyOptions, object, voxels, colliders, massProperties: voxels.massProperties(specification) });
    }
    return new Body({ ...bodyOptions, object, colliders, massProperties: massPropertiesOfMesh(geometry, colliders, specification) });
  }

  /** Adds a shape to collide with, and wakes the body, since what holds it up may have changed. */
  addCollider<SomeCollider extends Collider>(collider: SomeCollider): SomeCollider {
    if (this.colliderList.includes(collider)) return collider;
    this.colliderList.push(collider);
    this.shapeChanged();
    return collider;
  }

  /** Removes a shape, and wakes the body, since what holds it up may have changed. */
  removeCollider(collider: Collider): void {
    const index = this.colliderList.indexOf(collider);
    if (index === -1) return;
    this.colliderList.splice(index, 1);
    this.shapeChanged();
  }

  /**
   * A sleeping body is not simulated until something disturbs it: an awake body running into it,
   * a force, torque or impulse, a new pose or velocity, or `wakeUp()`.
   */
  get isSleeping(): boolean {
    return this.asleep;
  }

  /** Wakes the body and restarts its sleep timer. */
  wakeUp(): void {
    this.asleep = false;
    this.pendingSleepRequest = 'wake';
  }

  /** Puts the body to sleep now, stopping it. */
  sleep(): void {
    if (this.type !== 'dynamic') return;
    this.asleep = true;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.pendingSleepRequest = 'sleep';
  }

  get world(): World | undefined {
    return this.owningWorld;
  }

  get behaviors(): readonly Behavior[] {
    return this.attachedBehaviors;
  }

  /** Replaces the mass properties, and wakes the body. */
  setMassProperties(massProperties: MassProperties): void {
    this.assignMassProperties(massProperties);
    this.refreshDerivedState();
    this.shapeChanged();
  }

  /** Changes the mass while keeping the shape, so the inertia scales with it. */
  setMass(mass: number): void {
    if (!this.massProperties) {
      throw new InvalidMassError('Body has no mass properties to rescale');
    }
    this.setMassProperties(this.massProperties.withMass(mass));
  }

  /** Moves the body instantly, without interpolating from the old pose. */
  setPose(position: Vector3, quaternion: Quaternion): void {
    this.wakeUp();
    this.position.copy(position);
    this.quaternion.copy(quaternion).normalize();
    this.previousPosition.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
    this.refreshDerivedState();
    this.owningWorld?.bodyPosed(this);
  }

  addBehavior<SomeBehavior extends Behavior>(behavior: SomeBehavior): SomeBehavior {
    this.attachedBehaviors.push(behavior);
    behavior.attach?.(this);
    return behavior;
  }

  removeBehavior(behavior: Behavior): void {
    const index = this.attachedBehaviors.indexOf(behavior);
    if (index === -1) return;
    this.attachedBehaviors.splice(index, 1);
    behavior.detach?.(this);
  }

  /** Pushes the body for this step. Applied at `worldPoint`, the force also creates a torque. */
  applyForce(force: Vector3, worldPoint?: Vector3): void {
    if (!this.isDynamic) return;
    if (force.lengthSq() > 0) this.wakeUp();
    this.force.add(force);
    if (worldPoint) {
      leverArm.subVectors(worldPoint, this.worldCenterOfMass);
      this.torque.add(torqueFromForce.crossVectors(leverArm, force));
    }
  }

  /** Like applyForce, with the point given in the body's own frame. */
  applyForceAtLocalPoint(force: Vector3, localPoint: Vector3): void {
    this.applyForce(force, this.pointToWorld(localPoint, worldPoint));
  }

  applyTorque(torque: Vector3): void {
    if (!this.isDynamic) return;
    if (torque.lengthSq() > 0) this.wakeUp();
    this.torque.add(torque);
  }

  /** Changes the velocity at once, as if `impulse` (N·s) were delivered at `worldPoint`. */
  applyImpulse(impulse: Vector3, worldPoint?: Vector3): void {
    if (!this.isDynamic) return;
    if (impulse.lengthSq() > 0) this.wakeUp();
    this.velocity.addScaledVector(impulse, this.inverseMass);
    if (worldPoint) {
      if (this.orientationStateStale) this.refreshDerivedState();
      leverArm.subVectors(worldPoint, this.worldCenterOfMass);
      torqueFromForce.crossVectors(leverArm, impulse).applyMatrix3(this.worldInverseInertia);
      this.angularVelocity.add(torqueFromForce);
    }
  }

  /** @internal */
  clearForces(): void {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  /** Writes the pose, interpolated `alpha` of the way from the previous step, into the bound object or instance. */
  syncObject(alpha = 1): void {
    const object = this.object;
    if (!object && !this.instance) return;
    interpolatedPosition.lerpVectors(this.previousPosition, this.position, alpha);
    interpolatedQuaternion.slerpQuaternions(this.previousQuaternion, this.quaternion, alpha);
    if (this.instance) this.writeInstance(this.instance);
    if (!object) return;
    const parent = object.parent;
    if (parent === null) {
      object.position.copy(interpolatedPosition);
      object.quaternion.copy(interpolatedQuaternion);
      return;
    }
    parent.updateWorldMatrix(true, false);
    objectWorldMatrix.compose(interpolatedPosition, interpolatedQuaternion, unitScale);
    parentInverseMatrix.copy(parent.matrixWorld).invert();
    objectWorldMatrix.premultiply(parentInverseMatrix).decompose(object.position, object.quaternion, ignoredScale);
  }

  /**
   * Writes the interpolated pose into the instance, in the mesh's own frame, with the instance's
   * scale. Once the body sleeps it stays put, so a sleeping body writes it once and then leaves
   * the mesh alone: a scene of sleepers uploads nothing.
   */
  private writeInstance({ mesh, index }: BodyInstance): void {
    if (this.asleep) {
      if (this.instanceWrittenAsleep) return;
      this.instanceWrittenAsleep = true;
    } else this.instanceWrittenAsleep = false;
    instancePose.compose(interpolatedPosition, interpolatedQuaternion, this.instanceScale);
    mesh.updateWorldMatrix(true, false);
    if (!mesh.matrixWorld.equals(identity)) instancePose.premultiply(parentInverseMatrix.copy(mesh.matrixWorld).invert());
    mesh.setMatrixAt(index, instancePose);
    mesh.instanceMatrix.needsUpdate = true;
    // the instances have moved, so three.js must find the mesh's bounds afresh to cull it rightly
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
  }

  /**
   * Bodies for every instance of `mesh`, posed as the instances are, colliding as `collider` says
   * and weighed from the mesh's geometry (or their colliders). `world.addInstances` does this for you.
   */
  static fromInstances(mesh: InstancedMesh, options: InstancedBodyOptions = {}): Body[] {
    const { mass, density, collider, ...bodyOptions } = options;
    const dynamic = (bodyOptions.type ?? 'dynamic') === 'dynamic';
    const specification = mass === undefined ? { density: density ?? DEFAULT_DENSITY } : { mass };
    // the geometry and mass properties for each scale the instances are drawn at, worked out once
    const scaled = new Map<string, { geometry: BufferGeometry; massProperties?: MassProperties | undefined }>();
    if (dynamic) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const bodies: Body[] = [];
    for (let index = 0; index < mesh.count; index++) {
      instanceWorldMatrix({ mesh, index }, instancePose).decompose(instancePosition, instanceQuaternion, ignoredScale);
      const key = ignoredScale.toArray().map((component) => component.toFixed(6)).join(',');
      let shape = scaled.get(key);
      if (!shape) {
        const unscaled = Math.abs(ignoredScale.x - 1) < 1e-6 && Math.abs(ignoredScale.y - 1) < 1e-6 && Math.abs(ignoredScale.z - 1) < 1e-6;
        shape = { geometry: unscaled ? mesh.geometry : mesh.geometry.clone().scale(ignoredScale.x, ignoredScale.y, ignoredScale.z) };
        scaled.set(key, shape);
      }
      const made = typeof collider === 'function' ? collider(index) : undefined;
      const colliders = made === undefined ? collidersFor(collider as ColliderShorthand | undefined, shape.geometry) : Array.isArray(made) ? [...(made as readonly Collider[])] : [made as Collider];
      if (dynamic && !shape.massProperties) shape.massProperties = massPropertiesOfMesh(shape.geometry, colliders, specification);
      bodies.push(new Body({ ...bodyOptions, instance: { mesh, index }, colliders, massProperties: dynamic ? shape.massProperties : undefined, position: instancePosition, quaternion: instanceQuaternion }));
    }
    return bodies;
  }

  /** @internal */
  override refreshDerivedState(): void {
    super.refreshDerivedState();
    this.orientationStateStale = false;
  }

  /**
   * @internal Called by World after reading a step's results: refreshes the centre of mass now,
   * and the matrix and world inverse inertia only once something needs them.
   */
  refreshAfterStep(): void {
    this.refreshCenterOfMass();
    this.orientationStateStale = true;
  }

  /** @internal Called by World when the body is added or removed. */
  setWorld(world: World | undefined): void {
    this.owningWorld = world;
  }

  /** @internal Called by World at the start of every step: renormalises the pose and remembers it for interpolation. */
  beginStep(): void {
    this.quaternion.normalize();
    this.refreshDerivedState();
    this.previousPosition.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
  }

  /** @internal Whether a wake or sleep request waits to be passed on. */
  get hasSleepRequest(): boolean {
    return this.pendingSleepRequest !== undefined;
  }

  /** @internal The wake or sleep request made since the last call, for the world to pass on. */
  takeSleepRequest(): SleepRequest {
    const request = this.pendingSleepRequest;
    this.pendingSleepRequest = undefined;
    return request;
  }

  /** @internal Called by World after reading the backend's results. */
  setSleepState(asleep: boolean): void {
    this.asleep = asleep;
  }

  private shapeChanged(): void {
    if (!this.owningWorld) return;
    this.wakeUp();
    this.owningWorld.bodyChanged(this);
  }

  private readInitialPose(options: BodyOptions): void {
    if (this.object) {
      this.object.updateWorldMatrix(true, false);
      this.object.matrixWorld.decompose(this.position, this.quaternion, ignoredScale);
    }
    if (this.instance) instanceWorldMatrix(this.instance, instancePose).decompose(this.position, this.quaternion, this.instanceScale);
    if (options.position) this.position.copy(options.position);
    if (options.quaternion) this.quaternion.copy(options.quaternion);
  }
}

/** Turns the `collider` option of `addBody(object)` into colliders, fitting shorthands to the geometry. */
function collidersFor(collider: ObjectBodyOptions['collider'], geometry: BufferGeometry | undefined): Collider[] {
  if (collider === undefined) return [];
  if (typeof collider !== 'string') return Array.isArray(collider) ? [...collider] : [collider as Collider];
  if (!geometry) throw new InvalidMeshError(`collider: '${collider}' is fitted to the object's meshes, and it has none`);
  return [fitCollider(collider, geometry)];
}

/** Mass properties of a closed mesh; of the colliders, if it isn't closed and they are solid. */
function massPropertiesOfMesh(geometry: BufferGeometry, colliders: readonly Collider[], specification: MassSpecification): MassProperties {
  try {
    return MassProperties.fromMesh(geometry, specification);
  } catch (error) {
    const fromColliders = error instanceof InvalidMeshError ? massPropertiesOfColliders(colliders, specification) : undefined;
    if (!fromColliders) throw error;
    return fromColliders;
  }
}

/** Mass properties of solid colliders with uniform density, or undefined if none has a volume. Sensors weigh nothing. */
function massPropertiesOfColliders(colliders: readonly Collider[], specification: MassSpecification): MassProperties | undefined {
  const parts = colliders
    .filter((collider) => !collider.sensor)
    .map((collider) => collider.massProperties({ density: 1 }))
    .filter((part) => part !== undefined);
  if (parts.length === 0) return undefined;
  const unitDensity = parts.reduce((combined, part) => combined.combine(part));
  // with density 1 the mass equals the volume
  return unitDensity.withMass('mass' in specification ? specification.mass : specification.density * unitDensity.mass);
}
