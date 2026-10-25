import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import type { InstancedMesh, Object3D } from 'three';
import { Body, DEFAULT_DENSITY, EulerError, fitCollider, forEachTriangle, InvalidMassError, InvalidMeshError, MassProperties } from '@eulerjs/core';
import type { BodyType, Collider, ColliderShorthand, MassSpecification, Plugin, World } from '@eulerjs/core';
import { MeshCollider } from '@eulerjs/bvh';
import { primitiveShape } from './shapes.js';

/**
 * What an object's `userData.physics` says about it: three.js's own convention, as its
 * RapierPhysics, JoltPhysics and AmmoPhysics read it (`mass` and `restitution`), and a little more.
 * A glTF node's extras arrive in `userData`, so a Blender custom property `physics` comes through as
 * this.
 */
export interface PhysicsData {
  /** In kg. 0 or none: the object doesn't move. */
  mass?: number | undefined;
  /** How bouncy, usually from 0 to 1. Defaults to 0. */
  restitution?: number | undefined;
  /** Coulomb friction coefficient. Defaults to 0.5. */
  friction?: number | undefined;
  /** Overrides what `mass` makes it: `'kinematic'` for an object moved by hand, say. */
  type?: BodyType | undefined;
  /**
   * What it collides as, in place of the shape chosen for it: a shape fitted around its meshes
   * (see `fitCollider`), or `'mesh'` for its triangles, which only a static or kinematic body can be.
   */
  collider?: ColliderShorthand | 'mesh' | undefined;
  /** Written by ScenePhysics: the body made for the object, or for an InstancedMesh one for each instance. */
  body?: Body | Body[] | undefined;
}

const worldPosition = new Vector3();
const worldQuaternion = new Quaternion();
const worldScale = new Vector3();
const toObjectFrame = new Matrix4();
const relativeMatrix = new Matrix4();
const instanceMatrix = new Matrix4();
const unitScale = new Vector3(1, 1, 1);

/**
 * Makes the bodies for a three.js scene from what its objects say about themselves, in
 * `userData.physics` (see `PhysicsData`). Use it with `world.use(new ScenePhysics())`.
 *
 * Each object with `userData.physics` becomes one body, whatever else it holds: a mesh, or a group
 * of them (a glTF node of several primitives, say), together with the meshes under it that don't
 * have physics of their own. It starts where it is drawn, nested in moved groups or not, and moves
 * its object as it goes. An InstancedMesh becomes a body for each instance.
 *
 * What it collides as: three.js's box, sphere, cylinder, cone and capsule geometries as those
 * shapes, while they are still the shape three.js made them; anything else as its convex hull if
 * it moves, or as its very triangles if it doesn't. A moving body's mass properties come from its
 * meshes when they are closed, else from its collider.
 */
export class ScenePhysics implements Plugin {
  readonly name = 'scene';
  private owningWorld: World | undefined;

  install(world: World): void {
    this.owningWorld = world;
  }

  dispose(): void {
    this.owningWorld = undefined;
  }

  /**
   * Makes a body for every object in `root` (and `root` itself) whose `userData.physics` is set,
   * in the tree's order, skipping any that already has one. Returns the bodies made.
   */
  addScene(root: Object3D): Body[] {
    const world = this.world;
    const made: Body[] = [];
    root.updateWorldMatrix(true, true);
    root.traverse((object) => {
      if (!isPhysicsData(object.userData.physics) || hasOwnBody(world, object)) return;
      const bodies = this.addObject(object);
      made.push(...(Array.isArray(bodies) ? bodies : [bodies]));
    });
    return made;
  }

  /**
   * Makes the body for one object, as `physics` says (its `userData.physics` unless given), and
   * notes it there as `body`: for an InstancedMesh, the list of its instances' bodies.
   */
  addObject(object: Object3D, physics: PhysicsData = isPhysicsData(object.userData.physics) ? object.userData.physics : {}): Body | Body[] {
    const world = this.world;
    const data: PhysicsData = Object.assign(isPhysicsData(object.userData.physics) ? object.userData.physics : {}, physics);
    object.userData.physics = data;
    const type = data.type ?? ((data.mass ?? 0) > 0 ? 'dynamic' : 'static');
    const specification: MassSpecification = data.mass !== undefined && data.mass > 0 ? { mass: data.mass } : { density: DEFAULT_DENSITY };
    const material = { friction: data.friction, restitution: data.restitution };
    if ((object as InstancedMesh).isInstancedMesh) {
      const mesh = object as InstancedMesh;
      const bodies = world.addInstances(mesh, { type, ...specification, collider: (index) => instanceCollider(mesh, index, type, data.collider, material) });
      data.body = bodies;
      return bodies;
    }

    object.updateWorldMatrix(true, true);
    const { geometry, meshes } = ownGeometry(object);
    if (!geometry) throw new InvalidMeshError('That object has no meshes of its own to collide as');
    object.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
    const lone = meshes.length === 1 && meshes[0] === object ? (object as Mesh) : undefined;
    const shape = data.collider ?? (lone ? primitiveShape(lone.geometry, worldScale) : undefined) ?? (type === 'dynamic' ? 'convex' : 'mesh');
    const collider = colliderOf(shape, geometry, type, material);
    const massProperties = type === 'dynamic' ? massPropertiesOf(geometry, collider, specification) : undefined;
    const body = world.addBody(new Body({ type, object, colliders: [collider], massProperties }));
    data.body = body;
    return body;
  }

  /** Takes an object's body, or its instances' bodies, out of the world, and forgets them in its `userData.physics`. */
  removeObject(object: Object3D): void {
    const world = this.world;
    const data = object.userData.physics as PhysicsData | undefined;
    const noted = data?.body;
    const bodies = noted === undefined ? [world.bodyOf(object)] : Array.isArray(noted) ? noted : [noted];
    for (const body of bodies) if (body) world.removeBody(body);
    if (data) delete data.body;
  }

  private get world(): World {
    if (!this.owningWorld) throw new EulerError('ScenePhysics is not in a world yet: world.use(new ScenePhysics()) first');
    return this.owningWorld;
  }
}

function isPhysicsData(value: unknown): value is PhysicsData {
  return typeof value === 'object' && value !== null;
}

/** Whether this very object, not just one it sits in, already has a body in the world. */
function hasOwnBody(world: World, object: Object3D): boolean {
  if ((object as InstancedMesh).isInstancedMesh) return world.bodyOf(object, 0) !== undefined;
  return world.bodyOf(object)?.object === object;
}

/**
 * The triangles of an object's meshes, in its frame (where it is, as it is turned, but with its
 * scale and its meshes' applied), leaving out those under it with physics of their own and
 * InstancedMeshes, which are bodies apart; and the meshes they came from.
 */
function ownGeometry(object: Object3D): { geometry: BufferGeometry | undefined; meshes: Mesh[] } {
  object.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
  toObjectFrame.compose(worldPosition, worldQuaternion, unitScale).invert();
  const corners: number[] = [];
  const meshes: Mesh[] = [];
  const visit = (node: Object3D) => {
    if (node !== object && isPhysicsData(node.userData.physics)) return;
    if (node instanceof Mesh && !(node as InstancedMesh).isInstancedMesh && node.geometry instanceof BufferGeometry) {
      meshes.push(node);
      relativeMatrix.multiplyMatrices(toObjectFrame, node.matrixWorld);
      forEachTriangle(node.geometry, (first, second, third) => {
        for (const corner of [first, second, third]) {
          corner.applyMatrix4(relativeMatrix);
          corners.push(corner.x, corner.y, corner.z);
        }
      });
    }
    for (const child of node.children) visit(child);
  };
  visit(object);
  if (corners.length === 0) return { geometry: undefined, meshes };
  return { geometry: new BufferGeometry().setAttribute('position', new Float32BufferAttribute(corners, 3)), meshes };
}

/** The collider for one instance: its geometry at the scale it is drawn at, shaped as for any mesh. */
function instanceCollider(mesh: InstancedMesh, index: number, type: BodyType, chosen: PhysicsData['collider'], material: { friction: number | undefined; restitution: number | undefined }): Collider {
  mesh.getMatrixAt(index, instanceMatrix);
  instanceMatrix.premultiply(mesh.matrixWorld).decompose(worldPosition, worldQuaternion, worldScale);
  const geometry = mesh.geometry.clone().scale(worldScale.x, worldScale.y, worldScale.z);
  const shape = chosen ?? primitiveShape(mesh.geometry, worldScale) ?? (type === 'dynamic' ? 'convex' : 'mesh');
  return colliderOf(shape, geometry, type, material);
}

function colliderOf(shape: ColliderShorthand | 'mesh', geometry: BufferGeometry, type: BodyType, material: { friction: number | undefined; restitution: number | undefined }): Collider {
  if (shape !== 'mesh') return fitCollider(shape, geometry, material);
  if (type === 'dynamic') throw new InvalidMeshError("collider: 'mesh' has no volume to give a moving body its mass: only a static or kinematic one can collide as its triangles. Try 'convex'.");
  return new MeshCollider({ geometry, ...material });
}

/** Exact from the meshes if they are closed; else from the collider, which a hull or a primitive always fills. */
function massPropertiesOf(geometry: BufferGeometry, collider: Collider, specification: MassSpecification): MassProperties {
  try {
    return MassProperties.fromMesh(geometry, specification);
  } catch (error) {
    if (!(error instanceof InvalidMeshError)) throw error;
    const fromCollider = collider.massProperties(specification);
    if (!fromCollider) throw new InvalidMassError('Neither its meshes nor its collider give that object a volume to weigh');
    return fromCollider;
  }
}
