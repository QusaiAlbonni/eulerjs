import { Scene, Vector3 } from 'three';
import type { Body, BoxCollider, ConvexCollider, World } from 'eulerjs';
import { describe, expect, it } from 'vitest';
import { createObstacles } from '../src/scene/obstacles.js';
import { SailingScenario } from './sailboatScenario.js';

const corners = [-1, 1].flatMap((east) => [-1, 1].flatMap((up) => [-1, 1].map((north) => new Vector3(east, up, north))));

/** How deep the deepest corner of a crate is inside a rock, or 0 if none is. */
function crateDepthInRock(crate: Body, rock: Body): number {
  const box = crate.colliders[0] as BoxCollider;
  const shape = rock.colliders[0] as ConvexCollider;
  let deepest = 0;
  for (const corner of corners) {
    const local = rock.worldToLocal(crate.localToWorld(corner.clone().multiply(box.halfExtents).add(box.offset)));
    deepest = Math.max(deepest, -Math.max(...shape.faces.map((face) => face.normal.dot(local) - face.offset)));
  }
  return deepest;
}

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    world.fixedStep();
    eachStep?.();
  }
}

describe('rocks and drifting crates around the sailboat', () => {
  it('lays out rocks that stand out of the water clear of the start, and crates that float', () => {
    const scenario = new SailingScenario({ waves: true });
    const { rocks, crates } = createObstacles(scenario.world, new Scene(), scenario.ocean);
    const rockStarts = rocks.map((rock) => rock.position.clone());
    for (const rock of rocks) {
      expect(Math.hypot(rock.position.x, rock.position.z)).toBeGreaterThan(30);
      rock.object!.updateMatrixWorld();
      const top = Math.max(...(rock.colliders[0] as ConvexCollider).vertices.map((vertex) => rock.localToWorld(vertex.clone()).y));
      expect(top).toBeGreaterThan(2);
    }

    let deepestInRock = 0;
    // steps each crate has been out of the water for, and under it, and the most of each
    const dryFor = crates.map(() => 0);
    const underFor = crates.map(() => 0);
    let longestDry = 0;
    let longestUnder = 0;
    runFor(scenario.world, 30, () => {
      crates.forEach(({ buoyancy }, index) => {
        dryFor[index] = buoyancy.submergedFraction === 0 ? dryFor[index]! + 1 : 0;
        underFor[index] = buoyancy.submergedFraction === 1 ? underFor[index]! + 1 : 0;
        longestDry = Math.max(longestDry, dryFor[index]!);
        longestUnder = Math.max(longestUnder, underFor[index]!);
      });
      for (const { body } of crates) {
        for (const rock of rocks) deepestInRock = Math.max(deepestInRock, crateDepthInRock(body, rock));
      }
    });

    rocks.forEach((rock, index) => expect(rock.position.equals(rockStarts[index]!)).toBe(true));
    expect(deepestInRock).toBeLessThan(0.02);
    // tossed about by the waves, hopping off a crest or washed over by one now and then, but
    // never for long, so never sunk. (Hopping more than real crates would: Buoyancy has no added
    // mass, the water a body must push aside to move, which in a tall sea lets a light crate
    // shoot up out of a crest.)
    expect(longestDry * scenario.world.timestep).toBeLessThan(1);
    expect(longestUnder * scenario.world.timestep).toBeLessThan(1);
    for (const { body } of crates) expect([...body.position.toArray(), ...body.velocity.toArray()].every(Number.isFinite)).toBe(true);
  }, 60_000);

  it('leaves the boat room to start', () => {
    const scenario = new SailingScenario();
    const { crates } = createObstacles(scenario.world, new Scene(), scenario.ocean);
    for (const { body } of crates) expect(body.position.distanceTo(scenario.boat.body.position)).toBeGreaterThan(10);
  });
});
