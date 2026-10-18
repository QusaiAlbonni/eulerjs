import type { Quaternion, Vector3 } from 'three';
import type { Body } from './Body.js';
import type { Collider } from './colliders/Collider.js';

/** Which colliders a scene query finds. */
export interface QueryFilter {
  /** Only colliders in one of these collision groups (their `collisionGroups`). Defaults to every group. */
  collidesWith?: number | undefined;
  /** Whether sensors are found too. Defaults to false. */
  includeSensors?: boolean | undefined;
  /** A body, or bodies, to ignore: say, the one doing the looking. */
  exclude?: Body | readonly Body[] | undefined;
  /** Return false to skip a collider. */
  filter?: ((body: Body, collider: Collider) => boolean) | undefined;
}

export interface RayCastOptions extends QueryFilter {
  /** How far the ray reaches, in metres. Defaults to Infinity. */
  maxDistance?: number | undefined;
}

export interface ShapeCastOptions extends QueryFilter {
  /** How the shape is turned. Defaults to unturned. */
  quaternion?: Quaternion | undefined;
  /** How far the shape travels, in metres. Defaults to Infinity. */
  maxDistance?: number | undefined;
}

export interface OverlapOptions extends QueryFilter {
  /** How the shape is turned. Defaults to unturned. */
  quaternion?: Quaternion | undefined;
}

/** Where a ray, or a shape swept along a line, first touches a collider. */
export interface QueryHit {
  readonly body: Body;
  readonly collider: Collider;
  /** How far along the direction the ray or shape travelled before touching: 0 if it started inside. */
  readonly distance: number;
  /** The touching point, on the surface of the collider hit. */
  readonly point: Vector3;
  /** The surface normal of the collider hit there, pointing back toward the ray or shape. */
  readonly normal: Vector3;
}

/** A collider that a shape overlaps. */
export interface OverlapHit {
  readonly body: Body;
  readonly collider: Collider;
}
