import type { Box3 } from 'three';

export interface BroadphaseEntry<Item> {
  readonly item: Item;
  readonly bounds: Box3;
}

const AXES = ['x', 'y', 'z'] as const;

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
  const axis = AXES[widestAxis(entries)]!;
  const [otherFirst, otherSecond] = AXES.filter((other) => other !== axis) as [typeof axis, typeof axis];
  // two unbounded entries both start at minus infinity, and their difference is not a number
  entries.sort((first, second) => first.bounds.min[axis] - second.bounds.min[axis] || 0);
  for (let first = 0; first < entries.length; first++) {
    const bounds = entries[first]!.bounds;
    for (let second = first + 1; second < entries.length; second++) {
      const other = entries[second]!.bounds;
      if (other.min[axis] > bounds.max[axis]) break;
      if (other.min[otherFirst] > bounds.max[otherFirst] || other.max[otherFirst] < bounds.min[otherFirst]) continue;
      if (other.min[otherSecond] > bounds.max[otherSecond] || other.max[otherSecond] < bounds.min[otherSecond]) continue;
      onPair(entries[first]!.item, entries[second]!.item);
    }
  }
}

/** Index of the axis along which the bounded entries' centres vary most. */
function widestAxis<Item>(entries: readonly BroadphaseEntry<Item>[]): number {
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  let count = 0;
  for (const { bounds } of entries) {
    const finite = Number.isFinite(bounds.min.x + bounds.min.y + bounds.min.z + bounds.max.x + bounds.max.y + bounds.max.z);
    if (!finite) continue;
    count++;
    AXES.forEach((axis, index) => {
      const center = (bounds.min[axis] + bounds.max[axis]) / 2;
      sums[index]! += center;
      squares[index]! += center * center;
    });
  }
  if (count < 2) return 0;
  const variances = sums.map((sum, index) => squares[index]! / count - (sum / count) ** 2);
  return variances.indexOf(Math.max(...variances));
}
