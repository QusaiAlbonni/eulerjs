import { Vector3 } from 'three';
import { WALKWAY_LANES } from '../city/createCity.js';
import { STRIDE_LENGTH } from './walkCycle.js';

/**
 * Where people walk: round the blocks on the pavement, in two lanes each way, everyone in a lane
 * at the same pace. Nothing here depends on the physics engine, so any engine can drive the same
 * walkers along the same routes.
 */

/**
 * Walking speed in each lane, in m/s. Everyone in a lane walks at the same pace, so nobody walks
 * into the back of anyone; the two lanes go opposite ways, so nobody meets anyone head on.
 */
const LANE_SPEEDS = [1.3, 1.45] as const;
/** People start at least this far apart along their lane, in metres. */
const STARTING_GAP = 1.2;
/** People turn the corners of their walk this far ahead of them, in metres, so they don't snap round. */
const LOOK_AHEAD = 1.5;

export interface Route {
  readonly block: Vector3;
  /** Which of the block's walkways: 0 the inner, 1 the outer. */
  readonly lane: 0 | 1;
  readonly speed: number;
  /** +1 one way round the block, -1 the other. */
  readonly direction: number;
  /** How far along the loop round the block, in metres. */
  distance: number;
  /** Where in the stride, in radians: one full stride per 2π. */
  phase: number;
}

/** Where a walker is and how it moves: its feet's spot on the ground, the way it faces, and its walking velocity. */
export interface WalkerPlacement {
  readonly position: Vector3;
  heading: number;
  readonly velocity: Vector3;
}

const ahead = new Vector3();

/** Routes for `count` people round `blocks`, each starting clear of everyone else in its lane. */
export function startingRoutes(count: number, blocks: readonly Vector3[], random: () => number): Route[] {
  const routes: Route[] = [];
  while (routes.length < count) {
    const lane = random() < 0.5 ? 0 : 1;
    const block = blocks[Math.floor(random() * blocks.length)]!;
    const distance = random() * loopLength(lane);
    const crowded = routes.some((route) => route.block === block && route.lane === lane && distanceRound(route.distance, distance, loopLength(lane)) < STARTING_GAP);
    if (!crowded) routes.push({ block, lane, speed: LANE_SPEEDS[lane], direction: lane === 0 ? 1 : -1, distance, phase: random() * 2 * Math.PI });
  }
  return routes;
}

/** Walks the route on by `timestep` seconds: along the loop, and through the stride. */
export function advanceRoute(route: Route, timestep: number): void {
  route.distance += route.speed * timestep * route.direction;
  route.phase += ((2 * Math.PI * route.speed) / STRIDE_LENGTH) * timestep;
}

/** Puts the walker's spot, heading and velocity where their distance along their route is. */
export function placeOnRoute(route: Route, placement: WalkerPlacement): void {
  const halfSize = WALKWAY_LANES[route.lane];
  pointOnLoop(route.block, halfSize, route.distance, placement.position);
  pointOnLoop(route.block, halfSize, route.distance + LOOK_AHEAD * route.direction, ahead);
  ahead.sub(placement.position).setY(0);
  placement.heading = Math.atan2(ahead.x, ahead.z);
  placement.velocity.copy(ahead).normalize().multiplyScalar(route.speed);
}

export function newPlacement(): WalkerPlacement {
  return { position: new Vector3(), heading: 0, velocity: new Vector3() };
}

/** How far apart two places on a loop of `length` are, the short way round. */
function distanceRound(first: number, second: number, length: number): number {
  const apart = (((first - second) % length) + length) % length;
  return Math.min(apart, length - apart);
}

function loopLength(lane: 0 | 1): number {
  return 8 * WALKWAY_LANES[lane];
}

/** The point `distance` metres round the square of half-size `halfSize` about `center`. */
function pointOnLoop(center: Vector3, halfSize: number, distance: number, target: Vector3): Vector3 {
  const side = 2 * halfSize;
  const length = 4 * side;
  const along = ((distance % length) + length) % length;
  const edge = Math.floor(along / side);
  const into = along - edge * side - halfSize;
  const corners = [
    [halfSize, into],
    [-into, halfSize],
    [-halfSize, -into],
    [into, -halfSize],
  ] as const;
  const [east, north] = corners[edge]!;
  return target.set(center.x + east, 0, center.z + north);
}
