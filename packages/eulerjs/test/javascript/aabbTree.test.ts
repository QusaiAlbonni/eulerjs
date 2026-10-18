import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AabbTree } from '../../src/javascript/collision/AabbTree.js';
import type { TreeLeaf } from '../../src/javascript/collision/AabbTree.js';
import { raySpanInBox } from '../../src/javascript/collision/sweep.js';

function randomSource(seed: number): () => number {
  let state = seed;
  return () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

function randomBox(random: () => number, spread = 50): Box3 {
  const center = new Vector3(random(), random(), random()).multiplyScalar(spread);
  const half = new Vector3(Math.abs(random()), Math.abs(random()), Math.abs(random())).multiplyScalar(2);
  return new Box3(center.clone().sub(half), center.clone().add(half));
}

describe('bounding volume tree', () => {
  it('finds exactly the boxes a query box or a ray reaches, through inserts, moves and removals', () => {
    const random = randomSource(13);
    const tree = new AabbTree<number>();
    const boxes = new Map<number, Box3>();
    const leaves = new Map<number, TreeLeaf<number>>();
    for (let item = 0; item < 400; item++) {
      const box = randomBox(random);
      boxes.set(item, box);
      leaves.set(item, tree.insert(item, box));
    }
    // move some far, some a little; remove some
    for (let item = 0; item < 400; item += 3) {
      const box = item % 2 === 0 ? randomBox(random) : boxes.get(item)!.clone().translate(new Vector3(0.05, 0, 0));
      boxes.set(item, box);
      tree.move(leaves.get(item)!, box);
    }
    for (let item = 1; item < 400; item += 7) {
      tree.remove(leaves.get(item)!);
      boxes.delete(item);
    }
    for (let trial = 0; trial < 50; trial++) {
      const query = randomBox(random);
      const found = new Set<number>();
      tree.query(query, (item) => found.add(item));
      // every box that really overlaps is found; the rest may be, by their padding, but no further
      for (const [item, box] of boxes) {
        if (box.intersectsBox(query)) expect(found.has(item)).toBe(true);
        if (found.has(item)) expect(box.clone().expandByScalar(0.2).intersectsBox(query)).toBe(true);
      }
      const origin = new Vector3(random(), random(), random()).multiplyScalar(60);
      const direction = new Vector3(random(), random(), random()).normalize();
      const crossed = new Set<number>();
      tree.castRay(origin, direction, 80, (item) => {
        crossed.add(item);
        return 80;
      });
      for (const [item, box] of boxes) {
        const span = raySpanInBox(origin, direction, box);
        if (span && span.enter <= 80) expect(crossed.has(item)).toBe(true);
      }
    }
  });

  it('stays shallow however the boxes come', () => {
    const tree = new AabbTree<number>();
    // boxes added in a line, the worst order for an unbalanced tree
    let deepest = 0;
    const leaves: TreeLeaf<number>[] = [];
    for (let item = 0; item < 1024; item++) leaves.push(tree.insert(item, new Box3(new Vector3(item, 0, 0), new Vector3(item + 0.5, 1, 1))));
    for (const leaf of leaves) {
      let depth = 0;
      for (let node: TreeLeaf<number> | undefined = leaf; node; node = node.parent) depth++;
      deepest = Math.max(deepest, depth);
    }
    // a balanced tree of 1024 leaves is 11 deep; within a few levels of that
    expect(deepest).toBeLessThan(25);
  });

  it('holds an unbounded box such as a ground plane', () => {
    const tree = new AabbTree<string>();
    tree.insert('ground', new Box3(new Vector3(-Infinity, -Infinity, -Infinity), new Vector3(Infinity, Infinity, Infinity)));
    tree.insert('crate', new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1)));
    const found: string[] = [];
    tree.query(new Box3(new Vector3(5, 5, 5), new Vector3(6, 6, 6)), (item) => found.push(item));
    expect(found).toEqual(['ground']);
  });
});
