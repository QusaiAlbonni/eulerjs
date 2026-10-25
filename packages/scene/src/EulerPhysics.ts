import { Vector3 } from 'three';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { Body, EulerError, HeightfieldCollider, World } from '@eulerjs/core';
import { ScenePhysics } from './ScenePhysics.js';
import type { PhysicsData } from './ScenePhysics.js';

/** As often as three.js's own physics addons step their worlds. */
const STEPS_PER_SECOND = 60;

const zero = new Vector3();

export interface EulerPhysicsOptions {
  /** The world to fill and step; a new one with eulerjs's defaults unless given. */
  world?: World | undefined;
}

/** What `EulerPhysics()` hands back: three.js's RapierPhysics, JoltPhysics and AmmoPhysics API, on eulerjs. */
export interface EulerPhysicsAPI {
  readonly world: World;
  /** The plugin that makes the bodies, for more than the API below offers. */
  readonly scene: ScenePhysics;
  /**
   * Adds the objects in `scene` (and `scene` itself) whose `userData.physics` is set, such as
   * `box.userData.physics = { mass: 1, restitution: 0 }`. A mass of 0, or none, keeps one still.
   */
  addScene(scene: Object3D): void;
  /** Adds one mesh, `mass` kg (0 keeps it still) with `restitution` (0 to 1) for how bouncy it is. */
  addMesh(mesh: Mesh, mass?: number, restitution?: number): void;
  removeMesh(mesh: Mesh): void;
  /** Moves the mesh, or instance `index` of an InstancedMesh, to `position` and stops it. */
  setMeshPosition(mesh: Mesh, position: Vector3, index?: number): void;
  setMeshVelocity(mesh: Mesh, velocity: Vector3, index?: number): void;
  applyImpulse(mesh: Mesh, impulse: Vector3, index?: number): void;
  /**
   * Adds terrain under the mesh's origin: `width` by `depth` cells along x and z, whose
   * `(width + 1) × (depth + 1)` heights run along x first, then row after row along z, as a
   * rotated PlaneGeometry's vertices do; `scale.x` and `scale.z` are its whole width and depth, and
   * `scale.y` scales the heights. Returns its body.
   */
  addHeightfield(mesh: Mesh, width: number, depth: number, heights: ArrayLike<number>, scale: { x: number; y: number; z: number }): Body;
  /** Stops stepping and frees the world. */
  dispose(): void;
}

/**
 * eulerjs as three.js's physics addons are: `await EulerPhysics()` in place of `await RapierPhysics()`,
 * and the rest of an example runs as it was. It steps on its own, 60 times a second, as they do,
 * but at a fixed timestep, so the same scene always plays out the same way.
 *
 * Built on `ScenePhysics`, so it reads `userData.physics` as three.js does and a little more
 * (see `PhysicsData`), and fits each mesh as the plugin does: three.js's box, sphere, cylinder,
 * cone and capsule geometries as those shapes; anything else as its hull if it moves, or as its
 * triangles if it doesn't.
 */
export async function EulerPhysics(options: EulerPhysicsOptions = {}): Promise<EulerPhysicsAPI> {
  const world = options.world ?? new World();
  const scene = world.use(new ScenePhysics());

  const bodyOf = (mesh: Mesh, index = 0): Body => {
    const body = (mesh as InstancedMesh).isInstancedMesh ? world.bodyOf(mesh, index) : world.bodyOf(mesh);
    if (!body) throw new EulerError('That mesh has no body: add it with addMesh or addScene first');
    return body;
  };

  let lastTime = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    // No more than a tick's worth of time a tick: a scene that takes longer to step than that
    // slows down, as it does on three.js's addons, rather than stepping more each tick to catch
    // up, falling further behind, and leaving no time to draw.
    world.update(Math.min((now - lastTime) / 1000, 1 / STEPS_PER_SECOND));
    lastTime = now;
  }, 1000 / STEPS_PER_SECOND);

  return {
    world,
    scene,
    addScene: (root) => {
      scene.addScene(root);
    },
    addMesh: (mesh, mass = 0, restitution = 0) => {
      scene.addObject(mesh, { mass, restitution });
    },
    removeMesh: (mesh) => scene.removeObject(mesh),
    setMeshPosition: (mesh, position, index = 0) => {
      const body = bodyOf(mesh, index);
      body.setPose(position, body.quaternion);
      body.velocity.copy(zero);
      body.angularVelocity.copy(zero);
      body.syncObject();
    },
    setMeshVelocity: (mesh, velocity, index = 0) => {
      const body = bodyOf(mesh, index);
      body.velocity.copy(velocity);
      body.wakeUp();
    },
    applyImpulse: (mesh, impulse, index = 0) => bodyOf(mesh, index).applyImpulse(impulse),
    addHeightfield: (mesh, width, depth, heights, scale) => {
      if (heights.length !== (width + 1) * (depth + 1)) {
        throw new RangeError(`a heightfield ${width} by ${depth} cells needs ${(width + 1) * (depth + 1)} heights, got ${heights.length}`);
      }
      const grid = Array.from({ length: depth + 1 }, (_unused, row) => Array.from({ length: width + 1 }, (_alsoUnused, column) => heights[row * (width + 1) + column]! * scale.y));
      const terrain = new HeightfieldCollider({ heights: grid, cellSize: scale.x / width, cellDepth: scale.z / depth });
      const body = world.addBody(new Body({ type: 'static', object: mesh, colliders: [terrain] }));
      const data: PhysicsData = (mesh.userData.physics as PhysicsData | undefined) ?? {};
      data.body = body;
      mesh.userData.physics = data;
      return body;
    },
    dispose: () => {
      clearInterval(interval);
      world.dispose();
    },
  };
}
