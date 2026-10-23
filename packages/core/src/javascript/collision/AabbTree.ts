import { Box3 } from 'three';
import type { Vector3 } from 'three';

/**
 * A dynamic bounding volume tree (after Box2D's b2DynamicTree): boxes in a balanced binary tree,
 * each parent's box holding its children's, so that a ray or a box finds what it may touch by
 * visiting a few branches rather than every leaf. Leaves keep a box padded a little beyond the
 * one they were given, so an item that moves a little needn't be moved in the tree.
 */

interface TreeNode<Item> {
  readonly box: Box3;
  /** The box again, as plain numbers on the node, for the sweeps' inner loop: kept with it by `mirror`. */
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  parent: TreeNode<Item> | undefined;
  left: TreeNode<Item> | undefined;
  right: TreeNode<Item> | undefined;
  /** 0 for a leaf. */
  height: number;
  item: Item | undefined;
}

export type TreeLeaf<Item> = TreeNode<Item>;

/** How far past an item's box its leaf's reaches, in metres, so small moves don't touch the tree. */
const PADDING = 0.1;

const merged = new Box3();

/** Copies `node`'s box, or `box` as it has just been given, into the numbers on the node. */
function mirror<Node extends TreeNode<unknown>>(node: Node, box: Box3 = node.box): Node {
  node.minX = box.min.x;
  node.minY = box.min.y;
  node.minZ = box.min.z;
  node.maxX = box.max.x;
  node.maxY = box.max.y;
  node.maxZ = box.max.z;
  return node;
}

/** Half the surface area of a box: the cost of a node, by how likely a ray is to pass through it. */
function halfArea(box: Box3): number {
  const sizeX = box.max.x - box.min.x;
  const sizeY = box.max.y - box.min.y;
  const sizeZ = box.max.z - box.min.z;
  // an unbounded box, such as a plane's, costs the most
  const area = sizeX * sizeY + sizeY * sizeZ + sizeZ * sizeX;
  return Number.isFinite(area) ? area : Number.MAX_VALUE;
}

export class AabbTree<Item> {
  private root: TreeNode<Item> | undefined;
  /** Reused by every traversal; queries don't run inside one another's visits. */
  private readonly stack: TreeNode<Item>[] = [];
  /** Where the ray enters each node on the stack, for the sweeps. */
  private readonly entries: number[] = [];
  /** How many leaves there are, and how many have gone in (or moved) since the tree was last built afresh. */
  private leafCount = 0;
  private insertedSinceRebuild = 0;

  /**
   * Adds `item` with its bounds, padded by `padding` so that small moves needn't move it in the
   * tree (none for an item that won't move: a ray then passes through fewer boxes); keep the leaf
   * to move or remove it.
   */
  insert(item: Item, box: Box3, padding = PADDING): TreeLeaf<Item> {
    const leaf: TreeNode<Item> = mirror({ box: box.clone().expandByScalar(padding), minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, parent: undefined, left: undefined, right: undefined, height: 0, item });
    this.insertLeaf(leaf);
    this.leafCount++;
    this.insertedSinceRebuild++;
    return leaf;
  }

  remove(leaf: TreeLeaf<Item>): void {
    this.removeLeaf(leaf);
    leaf.item = undefined;
    this.leafCount--;
  }

  /**
   * Builds the tree afresh, top down, if many leaves have gone in or moved since it last was: one
   * built a leaf at a time depends on the order they came in, and can leave a ray many more boxes
   * to pass through. The leaves stay as they are; only the branches above them change.
   */
  rebuildIfWorthwhile(): void {
    if (this.leafCount < 8 || this.insertedSinceRebuild * 4 < this.leafCount) return;
    this.insertedSinceRebuild = 0;
    const leaves: TreeNode<Item>[] = [];
    const unbounded: TreeNode<Item>[] = [];
    const pending = this.root ? [this.root] : [];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node.height > 0) pending.push(node.left!, node.right!);
      else if (Number.isFinite(node.minX + node.minY + node.minZ + node.maxX + node.maxY + node.maxZ)) leaves.push(node);
      else unbounded.push(node);
    }
    let root = leaves.length > 0 ? buildTopDown(leaves, 0, leaves.length) : undefined;
    // the unbounded, a plane's, a ray always enters: over the rest, one by one
    for (const leaf of unbounded) root = root ? joined(root, leaf) : leaf;
    if (root) root.parent = undefined;
    this.root = root;
  }

  /** Gives the leaf its item's new bounds, moving it in the tree only if they leave its padded box. */
  move(leaf: TreeLeaf<Item>, box: Box3): void {
    if (leaf.box.containsBox(box)) return;
    this.insertedSinceRebuild++;
    this.removeLeaf(leaf);
    mirror(leaf, leaf.box.copy(box).expandByScalar(PADDING));
    this.insertLeaf(leaf);
  }

  /**
   * Calls `visit` for every item whose box a ray from `origin` along the unit `direction` passes
   * through within `maxDistance`, nearer branches first. `visit` returns how far the ray still
   * needs to reach: less, once it has found something nearer.
   */
  castRay(origin: Vector3, direction: Vector3, maxDistance: number, visit: (item: Item, reach: number) => number): void {
    this.sweep(origin, undefined, direction, maxDistance, visit);
  }

  /** Calls `visit` for every item whose box overlaps `box`. */
  query(box: Box3, visit: (item: Item) => void): void {
    if (!this.root) return;
    const stack: TreeNode<Item>[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!node.box.intersectsBox(box)) continue;
      if (node.height === 0) visit(node.item!);
      else stack.push(node.left!, node.right!);
    }
  }

  /** Calls `visit` for every item whose box a box of half size `halfSize`, slid from `origin` along `direction` within `maxDistance`, passes through. */
  castBox(origin: Vector3, halfSize: Vector3, direction: Vector3, maxDistance: number, visit: (item: Item, reach: number) => number): void {
    this.sweep(origin, halfSize, direction, maxDistance, visit);
  }

  /** A ray, or a box of half size `halfSize` if given, through the tree, nearer branches first. */
  private sweep(origin: Vector3, halfSize: Vector3 | undefined, direction: Vector3, maxDistance: number, visit: (item: Item, reach: number) => number): void {
    if (!this.root) return;
    const inverseX = 1 / direction.x;
    const inverseY = 1 / direction.y;
    const inverseZ = 1 / direction.z;
    const growX = halfSize?.x ?? 0;
    const growY = halfSize?.y ?? 0;
    const growZ = halfSize?.z ?? 0;
    let reach = maxDistance;
    const originX = origin.x;
    const originY = origin.y;
    const originZ = origin.z;
    // along an axis the ray doesn't move along, it is inside the slab all the way or not at all
    const alongX = Number.isFinite(inverseX);
    const alongY = Number.isFinite(inverseY);
    const alongZ = Number.isFinite(inverseZ);
    /** The slab test: how far along the ray it enters a node's box, where it is inside the box along every axis at once; Infinity if never, 0 if it starts inside. */
    const enterOf = (node: TreeNode<Item>): number => {
      let enter = 0;
      let exit = Infinity;
      if (alongX) {
        const toLow = (node.minX - growX - originX) * inverseX;
        const toHigh = (node.maxX + growX - originX) * inverseX;
        if (toLow < toHigh) {
          if (toLow > enter) enter = toLow;
          if (toHigh < exit) exit = toHigh;
        } else {
          if (toHigh > enter) enter = toHigh;
          if (toLow < exit) exit = toLow;
        }
      } else if (originX < node.minX - growX || originX > node.maxX + growX) return Infinity;
      if (alongY) {
        const toLow = (node.minY - growY - originY) * inverseY;
        const toHigh = (node.maxY + growY - originY) * inverseY;
        if (toLow < toHigh) {
          if (toLow > enter) enter = toLow;
          if (toHigh < exit) exit = toHigh;
        } else {
          if (toHigh > enter) enter = toHigh;
          if (toLow < exit) exit = toLow;
        }
      } else if (originY < node.minY - growY || originY > node.maxY + growY) return Infinity;
      if (alongZ) {
        const toLow = (node.minZ - growZ - originZ) * inverseZ;
        const toHigh = (node.maxZ + growZ - originZ) * inverseZ;
        if (toLow < toHigh) {
          if (toLow > enter) enter = toLow;
          if (toHigh < exit) exit = toHigh;
        } else {
          if (toHigh > enter) enter = toHigh;
          if (toLow < exit) exit = toLow;
        }
      } else if (originZ < node.minZ - growZ || originZ > node.maxZ + growZ) return Infinity;
      return enter <= exit ? enter : Infinity;
    };
    const stack = this.stack;
    const entries = this.entries;
    stack.length = 0;
    entries.length = 0;
    stack.push(this.root);
    entries.push(enterOf(this.root));
    while (stack.length > 0) {
      const node = stack.pop()!;
      // where the ray enters it, as found when it was pushed: a nearer find since may rule it out
      if (entries.pop()! > reach) continue;
      if (node.height === 0) {
        reach = Math.min(reach, visit(node.item!, reach));
        continue;
      }
      // the nearer child on top, to be looked in first: what it finds cuts the further one short
      const left = node.left!;
      const right = node.right!;
      const enterLeft = enterOf(left);
      const enterRight = enterOf(right);
      if (enterLeft <= enterRight) {
        if (enterRight <= reach) {
          stack.push(right);
          entries.push(enterRight);
        }
        if (enterLeft <= reach) {
          stack.push(left);
          entries.push(enterLeft);
        }
      } else {
        if (enterLeft <= reach) {
          stack.push(left);
          entries.push(enterLeft);
        }
        if (enterRight <= reach) {
          stack.push(right);
          entries.push(enterRight);
        }
      }
    }
  }

  private insertLeaf(leaf: TreeNode<Item>): void {
    if (!this.root) {
      this.root = leaf;
      leaf.parent = undefined;
      return;
    }
    // walk down to the sibling whose box grows least, as Box2D does
    let sibling = this.root;
    while (sibling.height > 0) {
      const left = sibling.left!;
      const right = sibling.right!;
      const area = halfArea(sibling.box);
      const combinedArea = halfArea(merged.copy(sibling.box).union(leaf.box));
      // the cost of a new parent here, and the least any parent further down adds
      const costHere = 2 * combinedArea;
      const inheritance = 2 * (combinedArea - area);
      const costLeft = this.descendCost(left, leaf.box) + inheritance;
      const costRight = this.descendCost(right, leaf.box) + inheritance;
      if (costHere < costLeft && costHere < costRight) break;
      sibling = costLeft < costRight ? left : right;
    }
    const oldParent = sibling.parent;
    const parent: TreeNode<Item> = mirror({ box: sibling.box.clone().union(leaf.box), minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, parent: oldParent, left: sibling, right: leaf, height: sibling.height + 1, item: undefined });
    sibling.parent = parent;
    leaf.parent = parent;
    if (!oldParent) this.root = parent;
    else if (oldParent.left === sibling) oldParent.left = parent;
    else oldParent.right = parent;
    this.refitFrom(parent.parent);
  }

  private descendCost(child: TreeNode<Item>, box: Box3): number {
    const combined = halfArea(merged.copy(child.box).union(box));
    return child.height === 0 ? combined : combined - halfArea(child.box);
  }

  private removeLeaf(leaf: TreeNode<Item>): void {
    if (leaf === this.root) {
      this.root = undefined;
      return;
    }
    const parent = leaf.parent!;
    const grandparent = parent.parent;
    const sibling = parent.left === leaf ? parent.right! : parent.left!;
    sibling.parent = grandparent;
    if (!grandparent) this.root = sibling;
    else if (grandparent.left === parent) grandparent.left = sibling;
    else grandparent.right = sibling;
    leaf.parent = undefined;
    this.refitFrom(grandparent);
  }

  /** Refits and rebalances the ancestors of a change, from `node` up to the root. */
  private refitFrom(start: TreeNode<Item> | undefined): void {
    let node = start;
    while (node) {
      node = this.balance(node);
      node.height = 1 + Math.max(node.left!.height, node.right!.height);
      mirror(node, node.box.copy(node.left!.box).union(node.right!.box));
      node = node.parent;
    }
  }

  /** Rotates a child up if one side of `node` is two levels taller than the other (an AVL rotation); returns the node now in its place. */
  private balance(node: TreeNode<Item>): TreeNode<Item> {
    if (node.height < 2) return node;
    const left = node.left!;
    const right = node.right!;
    const lean = right.height - left.height;
    if (lean > 1) return this.rotateUp(node, right, left);
    if (lean < -1) return this.rotateUp(node, left, right);
    return node;
  }

  /** Puts the taller child `tall` in `node`'s place, `node` taking `tall`'s shorter child. */
  private rotateUp(node: TreeNode<Item>, tall: TreeNode<Item>, short: TreeNode<Item>): TreeNode<Item> {
    const tallLeft = tall.left!;
    const tallRight = tall.right!;
    tall.parent = node.parent;
    if (!tall.parent) this.root = tall;
    else if (tall.parent.left === node) tall.parent.left = tall;
    else tall.parent.right = tall;
    node.parent = tall;
    // tall keeps its taller child and gives node the shorter one
    const [kept, given] = tallLeft.height > tallRight.height ? [tallLeft, tallRight] : [tallRight, tallLeft];
    tall.left = node;
    tall.right = kept;
    if (node.left === tall) node.left = given;
    else node.right = given;
    given.parent = node;
    node.height = 1 + Math.max(short.height, given.height);
    mirror(node, node.box.copy(short.box).union(given.box));
    tall.height = 1 + Math.max(node.height, kept.height);
    mirror(tall, tall.box.copy(node.box).union(kept.box));
    return tall;
  }
}

/** How many bins the top-down build sorts leaves into along an axis, to choose where to split them. */
const BINS = 12;
const binCounts = new Int32Array(BINS);
const binBounds = new Float64Array(BINS * 6);
const belowBounds = new Float64Array(BINS * 6);
const runningBounds = new Float64Array(6);

/** A new branch over `left` and `right`. */
function joined<Item>(left: TreeNode<Item>, right: TreeNode<Item>): TreeNode<Item> {
  const parent: TreeNode<Item> = mirror({ box: left.box.clone().union(right.box), minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, parent: undefined, left, right, height: 1 + Math.max(left.height, right.height), item: undefined });
  left.parent = parent;
  right.parent = parent;
  return parent;
}

function centreOf(node: TreeNode<unknown>, axis: number): number {
  return axis === 0 ? node.minX + node.maxX : axis === 1 ? node.minY + node.maxY : node.minZ + node.maxZ;
}

/** Half the surface area of the box held in `bounds` from `at`: min x, y, z, then max x, y, z. */
function halfAreaOf(bounds: Float64Array, at: number): number {
  const sizeX = bounds[at + 3]! - bounds[at]!;
  const sizeY = bounds[at + 4]! - bounds[at + 1]!;
  const sizeZ = bounds[at + 5]! - bounds[at + 2]!;
  return sizeX * sizeY + sizeY * sizeZ + sizeZ * sizeX;
}

function emptyBounds(bounds: Float64Array, at: number): void {
  bounds.fill(Infinity, at, at + 3);
  bounds.fill(-Infinity, at + 3, at + 6);
}

/** Grows the box in `bounds` (from 0) to hold the one in `other` from `at`. */
function unionInto(bounds: Float64Array, other: Float64Array, at: number): void {
  for (let value = 0; value < 3; value++) {
    bounds[value] = Math.min(bounds[value]!, other[at + value]!);
    bounds[3 + value] = Math.max(bounds[3 + value]!, other[at + 3 + value]!);
  }
}

function growBounds(bounds: Float64Array, at: number, node: TreeNode<unknown>): void {
  bounds[at] = Math.min(bounds[at]!, node.minX);
  bounds[at + 1] = Math.min(bounds[at + 1]!, node.minY);
  bounds[at + 2] = Math.min(bounds[at + 2]!, node.minZ);
  bounds[at + 3] = Math.max(bounds[at + 3]!, node.maxX);
  bounds[at + 4] = Math.max(bounds[at + 4]!, node.maxY);
  bounds[at + 5] = Math.max(bounds[at + 5]!, node.maxZ);
}

/**
 * A tree over `leaves` from `start` to `end`, built from the top: each group split in two where
 * the surface area heuristic says a ray will pass through least, among the bin boundaries along
 * the axis their centres spread furthest on (as Box2D rebuilds its static tree).
 */
function buildTopDown<Item>(leaves: TreeNode<Item>[], start: number, end: number): TreeNode<Item> {
  if (end - start === 1) return leaves[start]!;
  // where the leaves' centres spread, and along which axis furthest
  let axis = 0;
  let lowest = 0;
  let spread = -1;
  for (let candidate = 0; candidate < 3; candidate++) {
    let low = Infinity;
    let high = -Infinity;
    for (let index = start; index < end; index++) {
      const centre = centreOf(leaves[index]!, candidate);
      if (centre < low) low = centre;
      if (centre > high) high = centre;
    }
    if (high - low > spread) {
      spread = high - low;
      axis = candidate;
      lowest = low;
    }
  }
  let middle = (start + end) >> 1;
  if (spread > 0) {
    // into bins by centre, then the split between bins that costs least
    binCounts.fill(0);
    for (let bin = 0; bin < BINS; bin++) emptyBounds(binBounds, bin * 6);
    const binOf = (node: TreeNode<Item>) => Math.min(BINS - 1, Math.floor(((centreOf(node, axis) - lowest) / spread) * BINS));
    for (let index = start; index < end; index++) {
      const bin = binOf(leaves[index]!);
      binCounts[bin]!++;
      growBounds(binBounds, bin * 6, leaves[index]!);
    }
    // the bounds of bins 0 to `bin`, for the side below each boundary
    emptyBounds(runningBounds, 0);
    for (let bin = 0; bin < BINS; bin++) {
      unionInto(runningBounds, binBounds, bin * 6);
      belowBounds.set(runningBounds, bin * 6);
    }
    // and from the top down, the side above, the cost of each split with it
    let bestCost = Infinity;
    let bestBoundary = -1;
    emptyBounds(runningBounds, 0);
    let countAbove = 0;
    for (let boundary = BINS - 1; boundary >= 1; boundary--) {
      unionInto(runningBounds, binBounds, boundary * 6);
      countAbove += binCounts[boundary]!;
      const countBelow = end - start - countAbove;
      if (countAbove === 0 || countBelow === 0) continue;
      const cost = halfAreaOf(belowBounds, (boundary - 1) * 6) * countBelow + halfAreaOf(runningBounds, 0) * countAbove;
      if (cost < bestCost) {
        bestCost = cost;
        bestBoundary = boundary;
      }
    }
    if (bestBoundary > 0) {
      // the leaves below the boundary first, then those above
      let low = start;
      let high = end - 1;
      while (low <= high) {
        if (binOf(leaves[low]!) < bestBoundary) low++;
        else {
          const swap = leaves[low]!;
          leaves[low] = leaves[high]!;
          leaves[high] = swap;
          high--;
        }
      }
      middle = low;
    }
  }
  return joined(buildTopDown(leaves, start, middle), buildTopDown(leaves, middle, end));
}
