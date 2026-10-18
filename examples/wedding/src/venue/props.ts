import { BoxGeometry, CylinderGeometry, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three';
import type { BufferGeometry, Material, Object3D, Quaternion, Scene } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Body } from '@eulerjs/core';
import type { Collider, World } from '@eulerjs/core';

/** What every part of the venue is added to. */
export interface Venue {
  readonly world: World;
  readonly scene: Scene;
}

/** A mesh that casts and receives shadows. */
export function shaded(geometry: BufferGeometry, material: Material): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A box, as geometry, with its centre at `center`. */
export function boxAt(sizeX: number, sizeY: number, sizeZ: number, center: Vector3): BufferGeometry {
  return new BoxGeometry(sizeX, sizeY, sizeZ).translate(center.x, center.y, center.z);
}

/** A cylinder standing along y, as geometry, with its centre at `center`. */
export function cylinderAt(radius: number, height: number, center: Vector3, segments = 20, topRadius = radius): BufferGeometry {
  return new CylinderGeometry(topRadius, radius, height, segments).translate(center.x, center.y, center.z);
}

/** Several pieces of geometry as one, to draw as one mesh. */
export function merged(...pieces: BufferGeometry[]): BufferGeometry {
  return mergeGeometries(pieces.map((piece) => piece.toNonIndexed()));
}

/** Several pieces of geometry as one, each its own group, to draw with a material apiece: one mesh, one body. */
export function mergedInGroups(...pieces: BufferGeometry[]): BufferGeometry {
  return mergeGeometries(
    pieces.map((piece) => piece.toNonIndexed()),
    true,
  );
}

export interface PropOptions {
  /** Drawn where the body is; its frame is the body's. */
  object: Object3D;
  colliders: Collider[];
  /** In kg. */
  mass: number;
  position: Vector3;
  quaternion?: Quaternion | undefined;
}

/** Something loose that can be knocked over, pushed or picked up. */
export function addProp(venue: Venue, options: PropOptions): Body {
  venue.scene.add(options.object);
  return venue.world.addBody(new Body({ colliders: options.colliders, mass: options.mass, position: options.position, quaternion: options.quaternion, object: options.object }));
}

export interface Placement {
  position: Vector3;
  quaternion: Quaternion;
}

export interface InstancedPropsOptions {
  geometry: BufferGeometry;
  /** One material, or one for each of the geometry's groups. */
  material: Material | Material[];
  placements: readonly Placement[];
  /** The colliders of each one, made afresh for each. */
  colliders: () => Collider[];
  /** Of each one, in kg. */
  mass: number;
}

const unscaled = new Vector3(1, 1, 1);

/**
 * Many loose things that look alike, drawn as one InstancedMesh: each is a body of its own, which
 * the world draws as its instance. Hundreds of chairs cost one draw call instead of hundreds.
 */
export function addInstancedProps(venue: Venue, options: InstancedPropsOptions): Body[] {
  const mesh = new InstancedMesh(options.geometry, options.material, options.placements.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const matrix = new Matrix4();
  options.placements.forEach((placement, index) => mesh.setMatrixAt(index, matrix.compose(placement.position, placement.quaternion, unscaled)));
  venue.scene.add(mesh);
  return venue.world.addInstances(mesh, { mass: options.mass, collider: options.colliders });
}

/** Something fixed: it never moves, however hard it is hit. */
export function addFixture(venue: Venue, object: Object3D, colliders: Collider[], position: Vector3, quaternion?: Quaternion): Body {
  object.position.copy(position);
  if (quaternion) object.quaternion.copy(quaternion);
  venue.scene.add(object);
  return venue.world.addBody(new Body({ type: 'static', colliders, position, quaternion, object }));
}
