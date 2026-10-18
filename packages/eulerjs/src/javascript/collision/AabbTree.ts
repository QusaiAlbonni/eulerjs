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

  /** Adds `item` with its bounds; keep the leaf to move or remove it. */
  insert(item: Item, box: Box3): TreeLeaf<Item> {
    const leaf: TreeNode<Item> = { box: box.clone().expandByScalar(PADDING), parent: undefined, left: undefined, right: undefined, height: 0, item };
    this.insertLeaf(leaf);
    return leaf;
  }

  remove(leaf: TreeLeaf<Item>): void {
    this.removeLeaf(leaf);
    leaf.item = undefined;
  }

  /** Gives the leaf its item's new bounds, moving it in the tree only if they leave its padded box. */
  move(leaf: TreeLeaf<Item>, box: Box3): void {
    if (leaf.box.containsBox(box)) return;
    this.removeLeaf(leaf);
    leaf.box.copy(box).expandByScalar(PADDING);
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
    const stack = this.stack;
    stack.length = 0;
    stack.push(this.root);
    while (stack.length > 0) {
      const node = stack.pop()!;
      const box = node.box;
      // the slab test: where the ray is inside the box along each axis, overlapped
      const enter = slabEnter(origin, inverseX, inverseY, inverseZ, box.min.x - growX, box.min.y - growY, box.min.z - growZ, box.max.x + growX, box.max.y + growY, box.max.z + growZ);
      if (enter > reach) continue;
      if (node.height === 0) {
        reach = Math.min(reach, visit(node.item!, reach));
        continue;
      }
      stack.push(node.left!, node.right!);
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
    const parent: TreeNode<Item> = { box: sibling.box.clone().union(leaf.box), parent: oldParent, left: sibling, right: leaf, height: sibling.height + 1, item: undefined };
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
      node.box.copy(node.left!.box).union(node.right!.box);
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
    node.box.copy(short.box).union(given.box);
    tall.height = 1 + Math.max(node.height, kept.height);
    tall.box.copy(node.box).union(kept.box);
    return tall;
  }
}

/** Where the ray last entered and first leaves the slabs tested so far, along it. */
let slabEnterDistance = 0;
let slabExitDistance = Infinity;

/** Narrows the stretch of the ray inside the slabs to this axis's, given the ray's start and inverse direction along it; false once nothing is left. */
function clipToSlab(start: number, inverse: number, low: number, high: number): boolean {
  if (!Number.isFinite(inverse)) return start >= low && start <= high;
  const toLow = (low - start) * inverse;
  const toHigh = (high - start) * inverse;
  const near = toLow < toHigh ? toLow : toHigh;
  const far = toLow < toHigh ? toHigh : toLow;
  if (near > slabEnterDistance) slabEnterDistance = near;
  if (far < slabExitDistance) slabExitDistance = far;
  return slabEnterDistance <= slabExitDistance;
}

/**
 * How far along a ray from `origin` it enters the box from `minimum` to `maximum`, given the
 * inverses of its direction's components: Infinity if it misses, 0 if it starts inside.
 */
function slabEnter(
  origin: Vector3,
  inverseX: number,
  inverseY: number,
  inverseZ: number,
  minimumX: number,
  minimumY: number,
  minimumZ: number,
  maximumX: number,
  maximumY: number,
  maximumZ: number,
): number {
  slabEnterDistance = 0;
  slabExitDistance = Infinity;
  if (!clipToSlab(origin.x, inverseX, minimumX, maximumX)) return Infinity;
  if (!clipToSlab(origin.y, inverseY, minimumY, maximumY)) return Infinity;
  if (!clipToSlab(origin.z, inverseZ, minimumZ, maximumZ)) return Infinity;
  return slabEnterDistance;
}
