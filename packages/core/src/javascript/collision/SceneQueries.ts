import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Body } from '../../Body.js';
import type { Collider, ColliderPose } from '../../colliders/Collider.js';
import { EulerError } from '../../errors.js';
import type { OverlapHit, QueryFilter, QueryHit } from '../../queries.js';
import type { SolverBody } from '../SolverBody.js';
import { AabbTree } from './AabbTree.js';
import type { TreeLeaf } from './AabbTree.js';
import { supportShapeOf } from './gjk.js';
import type { SupportShape } from './gjk.js';
import { castRayAgainst, overlapsCollider, sweepAgainst } from './sweep.js';

const colliderPose = { position: new Vector3(), quaternion: new Quaternion(), rotation: new Matrix3() };
const rotationScratch = new Matrix4();

/**
 * Ray casts, shape casts and overlap tests against the bodies of the JavaScript backend, through
 * a bounding volume tree of the bodies' colliders. Bodies changed by hand are refitted in the tree
 * before the next query; awake bodies once a step, before the first query after it.
 */
export class SceneQueries {
  private readonly tree = new AabbTree<SolverBody>();
  private readonly leaves = new Map<SolverBody, TreeLeaf<SolverBody>>();
  /** Bodies added, moved by hand or given new colliders since the tree last saw them. */
  private readonly changed = new Set<SolverBody>();
  private readonly removed = new Set<SolverBody>();
  /** The step the tree last refitted the awake bodies after, and which they were: one may have fallen asleep since, somewhere else. */
  private refittedAfterStep = -1;
  private awakeAtRefit = new Set<SolverBody>();

  constructor(
    /** Every body that may move: static ones are refitted only when changed by hand. */
    private readonly bodies: () => readonly SolverBody[],
    private readonly stepCount: () => number,
  ) {}

  /** The body is new, or was moved or reshaped by hand. */
  bodyChanged(body: SolverBody): void {
    this.changed.add(body);
    this.removed.delete(body);
  }

  bodyRemoved(body: SolverBody): void {
    this.changed.delete(body);
    this.removed.add(body);
  }

  castRay(origin: Vector3, direction: Vector3, maxDistance: number, filter: QueryFilter, all: boolean): QueryHit[] {
    this.refit();
    const hits: QueryHit[] = [];
    this.tree.castRay(origin, direction, maxDistance, (body, reach) => {
      let nearest = reach;
      forEachFoundCollider(body, filter, (collider, pose) => {
        const hit = castRayAgainst(origin, direction, nearest, collider, pose);
        if (!hit || hit.distance > nearest) return;
        if (!all) {
          nearest = hit.distance;
          hits.length = 0;
        }
        hits.push({ body: body.source, collider, ...hit });
      });
      return all ? maxDistance : nearest;
    });
    return hits.sort((first, second) => first.distance - second.distance);
  }

  castShape(shape: Collider, position: Vector3, quaternion: Quaternion, direction: Vector3, maxDistance: number, filter: QueryFilter): QueryHit | undefined {
    this.refit();
    const { support, bounds } = placedQueryShape(shape, position, quaternion);
    const center = bounds.getCenter(new Vector3());
    const halfSize = bounds.getSize(new Vector3()).multiplyScalar(0.5);
    let nearest: QueryHit | undefined;
    // the swept shape's bounds reach a body's where a ray from their centre meets the body's bounds grown by their half size
    this.tree.castBox(center, halfSize, direction, maxDistance, (body, reach) => {
      forEachFoundCollider(body, filter, (collider, pose) => {
        const hit = sweepAgainst(support, bounds, direction, nearest?.distance ?? reach, collider, pose);
        if (hit && hit.distance <= (nearest?.distance ?? reach)) nearest = { body: body.source, collider, ...hit };
      });
      return nearest?.distance ?? reach;
    });
    return nearest;
  }

  overlap(shape: Collider, position: Vector3, quaternion: Quaternion, filter: QueryFilter): OverlapHit[] {
    this.refit();
    const { support, bounds } = placedQueryShape(shape, position, quaternion);
    const hits: OverlapHit[] = [];
    this.tree.query(bounds, (body) => {
      forEachFoundCollider(body, filter, (collider, pose) => {
        if (overlapsCollider(support, bounds, collider, pose)) hits.push({ body: body.source, collider });
      });
    });
    return hits;
  }

  /** Brings the tree up to date: bodies changed by hand, and the awake ones after a step. */
  private refit(): void {
    for (const body of this.removed) this.removeLeaf(body);
    this.removed.clear();
    const step = this.stepCount();
    if (step !== this.refittedAfterStep) {
      this.refittedAfterStep = step;
      const awake = new Set<SolverBody>();
      for (const body of this.bodies()) {
        if (body.type === 'static' || body.isSleeping) continue;
        awake.add(body);
        this.refitBody(body);
      }
      for (const body of this.awakeAtRefit) if (!awake.has(body) && this.leaves.has(body)) this.refitBody(body);
      this.awakeAtRefit = awake;
    }
    for (const body of this.changed) this.refitBody(body);
    this.changed.clear();
  }

  private refitBody(body: SolverBody): void {
    const leaf = this.leaves.get(body);
    if (body.colliders.length === 0) {
      if (leaf) this.removeLeaf(body);
      return;
    }
    boundsOf(body, bodyBounds);
    if (leaf) this.tree.move(leaf, bodyBounds);
    else this.leaves.set(body, this.tree.insert(body, bodyBounds));
  }

  private removeLeaf(body: SolverBody): void {
    const leaf = this.leaves.get(body);
    if (!leaf) return;
    this.tree.remove(leaf);
    this.leaves.delete(body);
  }
}

const bodyBounds = new Box3();
const colliderBounds = new Box3();

/** The box around all of a body's colliders as it is now. */
function boundsOf(body: SolverBody, target: Box3): Box3 {
  target.makeEmpty();
  for (const collider of body.colliders) {
    collider.poseIn(body, colliderPose);
    target.union(collider.bounds(colliderPose, colliderBounds));
  }
  return target;
}

/** The support shape and bounds of a shape used in a query, placed as a body at `position` and `quaternion` would place it. */
function placedQueryShape(shape: Collider, position: Vector3, quaternion: Quaternion): { support: SupportShape; bounds: Box3 } {
  const pose: ColliderPose = {
    position: shape.offset.clone().applyQuaternion(quaternion).add(position),
    quaternion: quaternion.clone().multiply(shape.rotation),
    rotation: new Matrix3(),
  };
  pose.rotation.setFromMatrix4(rotationScratch.makeRotationFromQuaternion(pose.quaternion));
  const support = supportShapeOf(shape, pose);
  if (!support) throw new EulerError(`A ${shape.shape} collider can't be cast or tested for overlaps; use a convex shape`);
  return { support, bounds: shape.bounds(pose, new Box3()) };
}

/** Calls `visit` with each of the body's colliders, and its pose, that the filter lets through. */
function forEachFoundCollider(body: SolverBody, filter: QueryFilter, visit: (collider: Collider, pose: ColliderPose) => void): void {
  if (isExcluded(body.source, filter.exclude)) return;
  for (const collider of body.colliders) {
    if (collider.sensor && !filter.includeSensors) continue;
    if (((filter.collidesWith ?? 0xffffffff) & collider.collisionGroups) === 0) continue;
    if (filter.filter && !filter.filter(body.source, collider)) continue;
    collider.poseIn(body, colliderPose);
    visit(collider, colliderPose);
  }
}

function isExcluded(body: Body, exclude: QueryFilter['exclude']): boolean {
  if (!exclude) return false;
  return Array.isArray(exclude) ? (exclude as readonly Body[]).includes(body) : exclude === body;
}
