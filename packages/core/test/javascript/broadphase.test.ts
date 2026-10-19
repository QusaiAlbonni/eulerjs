import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { sortAlong } from '../../src/javascript/collision/broadphase.js';

// The pair search sorts its entries every step; the order it leaves them in decides the order
// contacts are solved in, so it must be exactly the order a stable sort gives, ties and all.

interface Entry {
  readonly item: number;
  readonly bounds: Box3;
}

/** A random number generator that gives the same numbers every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const entryAt = (item: number, start: number): Entry => ({ item, bounds: new Box3(new Vector3(start, 0, 0), new Vector3(start + 1, 1, 1)) });
const stablySorted = (entries: readonly Entry[]) => [...entries].sort((one, other) => one.bounds.min.x - other.bounds.min.x || 0).map((entry) => entry.item);

describe('sorting the pair search’s entries', () => {
  const random = seeded(7);
  const cases: [string, () => Entry[]][] = [
    ['nearly sorted, as from one step to the next', () => Array.from({ length: 500 }, (_unused, index) => entryAt(index, index + (random() - 0.5) * 3))],
    ['shuffled, as on the first step', () => Array.from({ length: 3000 }, (_unused, index) => entryAt(index, random() * 1000))],
    ['with many starting at the same place', () => Array.from({ length: 400 }, (_unused, index) => entryAt(index, Math.floor(random() * 20)))],
    [
      'with unbounded entries, which start at minus infinity',
      () => [entryAt(0, 5), { item: 1, bounds: new Box3(new Vector3(-Infinity, -Infinity, -Infinity), new Vector3(Infinity, 0, Infinity)) }, entryAt(2, -3), { item: 3, bounds: new Box3(new Vector3(-Infinity, 0, 0), new Vector3(0, 1, 1)) }, entryAt(4, -3)],
    ],
  ];
  it.each(cases)('leaves them as a stable sort does, %s', (_name, make) => {
    const entries = make();
    const expected = stablySorted(entries);
    sortAlong(entries, 'x');
    expect(entries.map((entry) => entry.item)).toEqual(expected);
  });
});
