import { Matrix4, Mesh, Quaternion, SpotLight, Vector3 } from 'three';
import type { Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Body, World } from 'eulerjs';
import type { Buoyancy, Ocean, WaveSurface, Wind } from '@eulerjs/marine';
import { SailboatControls } from './SailboatControls.js';
import { SAILBOAT_LAYOUT } from './sailboatLayout.js';
import { createSailboatPhysics } from './sailboatPhysics.js';
import type { SailboatFoils } from './sailboatPhysics.js';

export interface Sailboat {
  readonly body: Body;
  /** The visual boat, bound to the body; the camera follows it. */
  readonly object: Object3D;
  /** Attached to the boat; off (intensity 0) by day. */
  readonly headlight: SpotLight;
  readonly buoyancy: Buoyancy;
  readonly foils: SailboatFoils;
  /** Reads the helm keys, sets the foil angles and turns the sail and rudder meshes to match. */
  update(frameDelta: number): void;
  dispose(): void;
}

export interface SailboatOptions {
  world: World;
  scene: Scene;
  ocean: Ocean<WaveSurface>;
  wind: Wind;
  assetsPath: string;
}

const UP = new Vector3(0, 1, 0);
const trim = new Quaternion();

/** A mesh that turns about the vertical axis by a foil's angle, from where the model left it. */
class TurningPart {
  private readonly mesh: Object3D;
  private readonly restQuaternion: Quaternion;

  constructor(mesh: Object3D) {
    this.mesh = mesh;
    this.restQuaternion = mesh.quaternion.clone();
  }

  turnTo(angle: number): void {
    this.mesh.quaternion.copy(this.restQuaternion).premultiply(trim.setFromAxisAngle(UP, angle));
  }
}

export async function createSailboat(options: SailboatOptions): Promise<Sailboat> {
  const gltf = await new GLTFLoader().loadAsync(`${options.assetsPath}boat.glb`);
  const boat = gltf.scene;
  boat.updateMatrixWorld(true);
  const hull = findMesh(boat, 'hull');
  const mainsail = findMesh(boat, 'mainsail');
  const jib = findMesh(boat, 'jib');
  const rudder = findMesh(boat, 'rudder');
  moveOriginTo(rudder, SAILBOAT_LAYOUT.rudder.pivot);

  const hullGeometry = hull.geometry.clone().applyMatrix4(relativeMatrix(hull, boat));
  const physics = createSailboatPhysics({ world: options.world, ocean: options.ocean, wind: options.wind, hullGeometry, object: boat });
  hullGeometry.dispose();
  options.scene.add(boat);

  const headlight = createHeadlight();
  boat.add(headlight, headlight.target);

  const controls = new SailboatControls(physics.foils, window);
  const turningParts = [
    { part: new TurningPart(mainsail), foil: physics.foils.mainsail },
    { part: new TurningPart(jib), foil: physics.foils.jib },
    { part: new TurningPart(rudder), foil: physics.foils.rudder },
  ];

  return {
    body: physics.body,
    object: boat,
    headlight,
    buoyancy: physics.buoyancy,
    foils: physics.foils,
    update(frameDelta: number): void {
      controls.update(frameDelta);
      for (const { part, foil } of turningParts) part.turnTo(foil.angle);
    },
    dispose(): void {
      controls.dispose();
      options.world.removeBody(physics.body);
      options.scene.remove(boat);
    },
  };
}

function findMesh(root: Object3D, name: string): Mesh {
  const found = root.getObjectByName(name);
  if (!(found instanceof Mesh)) throw new Error(`boat.glb has no mesh named "${name}"`);
  return found;
}

/** Transform from `object`'s frame to `root`'s frame. */
function relativeMatrix(object: Object3D, root: Object3D): Matrix4 {
  return new Matrix4().copy(root.matrixWorld).invert().multiply(object.matrixWorld);
}

/** Moves a mesh's origin to `pivot` (given in its parent's frame) without moving its vertices in the world. */
function moveOriginTo(mesh: Mesh, pivot: Vector3): void {
  const offset = pivot.clone().sub(mesh.position);
  mesh.geometry.translate(-offset.x, -offset.y, -offset.z);
  mesh.position.add(offset);
  mesh.updateMatrixWorld();
}

/** The searchlight the old demo carried: on the cabin roof, pointing ahead. */
function createHeadlight(): SpotLight {
  const headlight = new SpotLight(0xffffff, 0, 100, Math.PI / 4, 0.5, 0);
  headlight.position.set(0, 2, 3.3);
  headlight.target.position.set(0, 0, 40);
  return headlight;
}
