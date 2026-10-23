import { Vector3 } from 'three';
import type { ContactPoint } from './narrowphase.js';

/**
 * Most points a manifold keeps: the four that span the patch and the four deepest of the rest.
 * One flat face clipped against another keeps only the four (see `FACE_PATCH_POINTS`).
 */
const MAX_POINTS = 8;
/**
 * Most points a patch of one face against another keeps: the four that span it, which hold a box
 * or a cylinder up as well as any more could and leave a stack steadier than eight. A body
 * across several triangles keeps up to `MAX_POINTS`, the extra ones keeping it from rocking.
 */
export const FACE_PATCH_POINTS = 4;
const EXTREME_POINTS = 4;
/** Points whose normals are within about 10° of each other are one patch, which may be thinned out. */
const SAME_PATCH_COSINE = Math.cos((10 * Math.PI) / 180);

const offset = new Vector3();
const otherOffset = new Vector3();
const across = new Vector3();

/**
 * Thins a big patch of contact points, in place: the four that span it (the deepest, the one
 * furthest from it, then the two that span the most area with them) and the deepest four of the
 * rest. A cylinder's end clipped against a face, or a body over several triangles, gives a dozen
 * or more points, each costing a constraint, where these eight do the same job. Points facing
 * different ways, as on a ridge, are all kept.
 */
export function reduceManifold(points: ContactPoint[], most = MAX_POINTS): void {
  if (points.length <= most) return;
  const firstNormal = points[0]!.normal;
  if (points.some((point) => point.normal.dot(firstNormal) < SAME_PATCH_COSINE)) return;
  const kept: ContactPoint[] = [];
  let deepest = points[0]!;
  for (const point of points) if (point.depth > deepest.depth) deepest = point;
  kept.push(deepest);
  const furthest = pickBest(points, kept, (point) => point.pointA.distanceToSquared(deepest.pointA));
  kept.push(furthest);
  // the third spans the widest triangle with the first two
  const baseline = new Vector3().subVectors(furthest.pointA, deepest.pointA);
  const third = pickBest(points, kept, (point) => across.crossVectors(baseline, offset.subVectors(point.pointA, deepest.pointA)).lengthSq());
  kept.push(third);
  // the fourth reaches furthest out on the other side of the baseline from the third
  const thirdSide = across.crossVectors(baseline, offset.subVectors(third.pointA, deepest.pointA)).clone();
  const fourth = pickBest(points, kept, (point) => -thirdSide.dot(otherOffset.crossVectors(baseline, offset.subVectors(point.pointA, deepest.pointA))));
  kept.push(fourth);
  // and the deepest of the rest, which do most of the pushing
  const rest = points.filter((point) => !kept.includes(point)).sort((first, second) => second.depth - first.depth);
  kept.push(...rest.slice(0, Math.max(0, most - EXTREME_POINTS)));
  points.length = 0;
  points.push(...kept);
}

/** The point not yet kept that scores highest. */
function pickBest(points: readonly ContactPoint[], kept: readonly ContactPoint[], score: (point: ContactPoint) => number): ContactPoint {
  let best: ContactPoint | undefined;
  let bestScore = -Infinity;
  for (const point of points) {
    if (kept.includes(point)) continue;
    const pointScore = score(point);
    if (pointScore > bestScore) {
      bestScore = pointScore;
      best = point;
    }
  }
  return best!;
}
