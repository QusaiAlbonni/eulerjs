import type { Box3 } from 'three';

export interface BroadphaseEntry<Item> {
  readonly item: Item;
  readonly bounds: Box3;
}

export type Axis = 'x' | 'y' | 'z';
const AXES = ['x', 'y', 'z'] as const;

/** The axis entries are swept along, and the other two. */
export interface SweepAxes {
  readonly along: Axis;
  readonly first: Axis;
  readonly second: Axis;
}

/**
 * Sweep and prune: calls `onPair` for every two entries whose bounds overlap. Entries are sorted
 * by where their bounds start along the axis they are most spread out along, so each is only
 * compared with the neighbours its bounds reach. Unbounded entries, such as a ground plane, start
 * at minus infinity and so are compared with everything after them.
 *
 * `entries` is sorted in place. Bodies move little from one step to the next, so passing the same
 * array every step leaves it nearly sorted, and sorting it again costs next to nothing.
 */
export function findOverlappingPairs<Item>(entries: BroadphaseEntry<Item>[], onPair: (first: Item, second: Item) => void): void {
  const axes = sortForSweep(entries);
  const along = axes.along;
  for (let first = 0; first < entries.length; first++) {
    const bounds = entries[first]!.bounds;
    for (let second = first + 1; second < entries.length; second++) {
      const other = entries[second]!.bounds;
      if (other.min[along] > bounds.max[along]) break;
      if (overlapAcross(bounds, other, axes)) onPair(entries[first]!.item, entries[second]!.item);
    }
  }
}

/** Sorts `entries` in place by where their bounds start along the axis they are most spread out along, which it returns with the other two. */
export function sortForSweep<Item>(entries: BroadphaseEntry<Item>[]): SweepAxes {
  const axes = sweepAxesAlong(AXES[widestAxis(entries)]!);
  sortAlong(entries, axes.along);
  return axes;
}

/** The axis to sweep along, and the other two. */
export function sweepAxesAlong(along: Axis): SweepAxes {
  const [first, second] = AXES.filter((other) => other !== along) as [Axis, Axis];
  return { along, first, second };
}

/** The axis entries' centres are most spread out along. */
export function widestAxisOf<Item>(entries: readonly BroadphaseEntry<Item>[]): Axis {
  return AXES[widestAxis(entries)]!;
}

/** Inversions an insertion sort may undo before a full sort takes over. */
const MOST_INSERTION_MOVES = 4096;
let sortKeys = new Float64Array(0);

/**
 * Sorts `entries` in place by where their bounds start along `along`, keeping entries that start
 * at the same place in the order they were in: as a stable sort by that does, and so in the same
 * order. Nearly sorted, as they are from one step to the next, an insertion sort puts them in
 * order in a pass; if they turn out far from it, a full sort does.
 */
export function sortAlong<Item>(entries: BroadphaseEntry<Item>[], along: Axis): void {
  const count = entries.length;
  if (sortKeys.length < count) sortKeys = new Float64Array(Math.max(count, 2 * sortKeys.length));
  const keys = sortKeys;
  for (let index = 0; index < count; index++) keys[index] = entries[index]!.bounds.min[along];
  let moves = 0;
  for (let index = 1; index < count; index++) {
    const key = keys[index]!;
    // two unbounded entries both start at minus infinity, and their difference is not a number:
    // they count as starting at the same place, as the full sort's comparison has it
    if (!(keys[index - 1]! - key > 0)) continue;
    const entry = entries[index]!;
    let place = index;
    while (place > 0 && keys[place - 1]! - key > 0) {
      keys[place] = keys[place - 1]!;
      entries[place] = entries[place - 1]!;
      place--;
      if (++moves > MOST_INSERTION_MOVES) break;
    }
    keys[place] = key;
    entries[place] = entry;
    if (moves > MOST_INSERTION_MOVES) {
      // far from sorted: the rest by a full sort, which is stable too
      entries.sort((one, other) => one.bounds.min[along] - other.bounds.min[along] || 0);
      return;
    }
  }
}

/** Whether two bounds overlap across the sweep, on the two axes other than the one swept along: touching counts. */
export function overlapAcross(bounds: Box3, other: Box3, axes: SweepAxes): boolean {
  if (other.min[axes.first] > bounds.max[axes.first] || other.max[axes.first] < bounds.min[axes.first]) return false;
  return !(other.min[axes.second] > bounds.max[axes.second] || other.max[axes.second] < bounds.min[axes.second]);
}

/** Whether two bounds overlap, touching counting, as the sweep finds them: on every axis. */
export function boundsOverlap(bounds: Box3, other: Box3, axes: SweepAxes): boolean {
  if (other.min[axes.along] > bounds.max[axes.along] || other.max[axes.along] < bounds.min[axes.along]) return false;
  return overlapAcross(bounds, other, axes);
}

/** Index of the axis along which the bounded entries' centres vary most. */
function widestAxis<Item>(entries: readonly BroadphaseEntry<Item>[]): number {
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let squareX = 0;
  let squareY = 0;
  let squareZ = 0;
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    const { min, max } = entries[index]!.bounds;
    if (!Number.isFinite(min.x + min.y + min.z + max.x + max.y + max.z)) continue;
    count++;
    const centerX = (min.x + max.x) / 2;
    const centerY = (min.y + max.y) / 2;
    const centerZ = (min.z + max.z) / 2;
    sumX += centerX;
    squareX += centerX * centerX;
    sumY += centerY;
    squareY += centerY * centerY;
    sumZ += centerZ;
    squareZ += centerZ * centerZ;
  }
  if (count < 2) return 0;
  const variances = [squareX / count - (sumX / count) ** 2, squareY / count - (sumY / count) ** 2, squareZ / count - (sumZ / count) ** 2];
  return variances.indexOf(Math.max(...variances));
}
