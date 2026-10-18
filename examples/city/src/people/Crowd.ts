import type { Vector3 } from 'three';
import type { Scene } from 'three';
import type { Body, Plugin, World } from '@eulerjs/core';
import { Pedestrian } from './Pedestrian.js';
import { advanceRoute, newPlacement, placeOnRoute, startingRoutes } from './routes.js';
import type { Route, WalkerPlacement } from './routes.js';
import { standingPose, walkPose } from './walkCycle.js';
import type { BodyPose } from './walkCycle.js';

export interface CrowdOptions {
  count: number;
  /** Centres of the blocks people walk round. */
  blocks: readonly Vector3[];
  scene?: Scene | undefined;
  /** For laying out the same crowd every time. */
  random: () => number;
}

/** A contact force on a walker above this, in newtons, knocks them over: a car, not a brush with a cone. */
const KNOCK_DOWN_FORCE = 1500;
/** A walker pushed this far from where they should be has lost their footing, in metres. */
const KNOCKED_OFF_BALANCE = 0.6;
/** How long someone lies there before getting back up, in seconds. */
const RECOVERY_TIME = 8;
interface Walker extends Route {
  readonly person: Pedestrian;
  /** Seconds left lying down; 0 while walking. */
  downFor: number;
  readonly pose: BodyPose;
  readonly placement: WalkerPlacement;
}

/**
 * People walking round the city blocks on the pavement, as ragdolls. Anyone hit hard enough goes
 * limp, falls, and gets back up where they were after a while.
 */
export class Crowd implements Plugin {
  readonly name = 'crowd';
  private readonly walkers: Walker[] = [];
  private readonly walkerOfPart = new Map<Body, Walker>();

  constructor(world: World, options: CrowdOptions) {
    for (const route of startingRoutes(options.count, options.blocks, options.random)) {
      const placement = newPlacement();
      placeOnRoute(route, placement);
      const pose = walkPose(route.phase, standingPose());
      const person = new Pedestrian(world, placement, pose, { scene: options.scene, shirtColor: Math.floor(options.random() * 0xffffff) });
      const walker: Walker = Object.assign(route, { person, downFor: 0, pose, placement });
      this.walkers.push(walker);
      for (const part of person.parts.values()) this.walkerOfPart.set(part, walker);
    }
  }

  get people(): readonly Pedestrian[] {
    return this.walkers.map((walker) => walker.person);
  }

  /** How many people are walking, and how many are lying down. */
  get counts(): { walking: number; down: number } {
    const walking = this.walkers.filter((walker) => walker.person.walking).length;
    return { walking, down: this.walkers.length - walking };
  }

  applyForces(_world: World, timestep: number): void {
    for (const walker of this.walkers) {
      if (!walker.person.walking) {
        walker.downFor -= timestep;
        if (walker.downFor <= 0) this.getUp(walker);
        continue;
      }
      advanceRoute(walker, timestep);
      placeOnRoute(walker, walker.placement);
      walkPose(walker.phase, walker.pose);
      walker.person.followPose(walker.placement, walker.pose);
    }
  }

  /** Knocks over anyone hit hard, or pushed off their path. */
  afterStep(world: World): void {
    for (const contact of world.contacts) {
      if (contact.normalImpulse / world.timestep < KNOCK_DOWN_FORCE) continue;
      const walker = this.walkerOfPart.get(contact.bodyA) ?? this.walkerOfPart.get(contact.bodyB);
      // the ground holding up a foot is no blow
      const other = this.walkerOfPart.has(contact.bodyA) ? contact.bodyB : contact.bodyA;
      if (walker && other.type !== 'static') this.knockDown(walker);
    }
    for (const walker of this.walkers) {
      if (!walker.person.walking) continue;
      const pelvis = walker.person.parts.get('pelvis')!;
      if (Math.hypot(pelvis.position.x - walker.placement.position.x, pelvis.position.z - walker.placement.position.z) > KNOCKED_OFF_BALANCE) this.knockDown(walker);
    }
  }

  private knockDown(walker: Walker): void {
    if (!walker.person.walking) return;
    walker.person.walking = false;
    walker.downFor = RECOVERY_TIME;
  }

  private getUp(walker: Walker): void {
    placeOnRoute(walker, walker.placement);
    walkPose(walker.phase, walker.pose);
    walker.person.standUp(walker.placement, walker.pose);
  }
}
