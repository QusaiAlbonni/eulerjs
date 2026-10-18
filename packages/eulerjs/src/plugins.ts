import type { Body } from './Body.js';
import type { World } from './World.js';

/**
 * World-level extension. Every hook is optional and runs once per fixed step, in this order:
 * beforeStep, then every body's behaviours, then applyForces, then the backend simulates, then afterStep.
 */
export interface Plugin {
  readonly name: string;
  /** Called once by `world.use(plugin)`. */
  install?(world: World): void;
  beforeStep?(world: World, timestep: number): void;
  /** Add forces to bodies here; the backend simulates them right after. */
  applyForces?(world: World, timestep: number): void;
  afterStep?(world: World, timestep: number): void;
  /** Called by `world.removePlugin(plugin)` and `world.dispose()`. */
  dispose?(world: World): void;
}

/** Per-body extension, e.g. buoyancy or a sail. Runs every fixed step while the body is in a world. */
export interface Behavior {
  /** Called by `body.addBehavior(behavior)`. */
  attach?(body: Body): void;
  fixedUpdate(body: Body, timestep: number, world: World): void;
  /** Called by `body.removeBehavior(behavior)`. */
  detach?(body: Body): void;
}
