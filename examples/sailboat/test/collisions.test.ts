import type { Vector3 } from 'three';
import { BoxGeometry, IcosahedronGeometry, Mesh } from 'three';
import { Body, ConvexCollider } from 'eulerjs';
import type { BoxCollider } from 'eulerjs';
import { Buoyancy } from '@eulerjs/marine';
import { describe, expect, it } from 'vitest';
import { SailingScenario } from './sailboatScenario.js';

/**
 * The sailboat running into things: buoyancy, sails, keel and rudder acting on the same body
 * as its contacts with a rock and with another floating body.
 */

/** A boat on a beam reach on flat water, already up to speed. */
function boatUnderSail(): SailingScenario {
  const scenario = new SailingScenario({ headingOffWind: 90 });
  scenario.run(15);
  return scenario;
}

/** The corners of the boat's hull collider. */
function hullCorners(scenario: SailingScenario): readonly Vector3[] {
  return (scenario.boat.body.colliders[0] as ConvexCollider).vertices;
}

/** Straight ahead of the boat, `distance` metres away, at the waterline. */
function pointAhead(scenario: SailingScenario, distance: number): Vector3 {
  const heading = scenario.boat.body.velocity.clone().setY(0).normalize();
  return scenario.boat.body.position.clone().addScaledVector(heading, distance).setY(0);
}

/** How deep the deepest corner of the hull is inside a convex collider of `body`, or 0 if none is. */
function hullDepthInsideHull(scenario: SailingScenario, body: Body, obstacle: ConvexCollider): number {
  let deepest = 0;
  for (const corner of hullCorners(scenario)) {
    const local = body.worldToLocal(scenario.boat.body.localToWorld(corner.clone()));
    const outside = Math.max(...obstacle.faces.map((face) => face.normal.dot(local) - face.offset));
    deepest = Math.max(deepest, -outside);
  }
  return deepest;
}

/** How deep the deepest corner of the hull is inside a box collider of `body`, or 0 if none is. */
function hullDepthInsideBox(scenario: SailingScenario, body: Body, box: BoxCollider): number {
  let deepest = 0;
  for (const corner of hullCorners(scenario)) {
    const local = body.worldToLocal(scenario.boat.body.localToWorld(corner.clone())).sub(box.offset);
    const depth = Math.min(box.halfExtents.x - Math.abs(local.x), box.halfExtents.y - Math.abs(local.y), box.halfExtents.z - Math.abs(local.z));
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

describe('a sailboat that hits things', () => {
  it('stops at a rock without going into it, and stays upright and afloat', () => {
    const scenario = boatUnderSail();
    const boat = scenario.boat.body;
    const cruisingSpeed = boat.velocity.length();
    const floatingHeight = boat.position.y;
    expect(cruisingSpeed).toBeGreaterThan(2);
    const rockShape = ConvexCollider.fromGeometry(new IcosahedronGeometry(3, 1));
    const rock = scenario.world.addBody(new Body({ type: 'static', position: pointAhead(scenario, 12), colliders: [rockShape] }));

    let deepest = 0;
    let worstHeel = 0;
    let worstHeightChange = 0;
    let hitAt: number | undefined;
    let speedAfterHit: number | undefined;
    scenario.run(8, () => {
      deepest = Math.max(deepest, hullDepthInsideHull(scenario, rock, rockShape));
      worstHeel = Math.max(worstHeel, scenario.heelDegrees);
      worstHeightChange = Math.max(worstHeightChange, Math.abs(boat.position.y - floatingHeight));
      if (hitAt === undefined && scenario.world.contacts.length > 0) hitAt = scenario.world.time;
      if (hitAt !== undefined && speedAfterHit === undefined && scenario.world.time > hitAt + 1) speedAfterHit = boat.velocity.length();
    });

    expect(hitAt).toBeDefined();
    expect(deepest).toBeLessThan(0.02);
    // the rock takes the boat's way off; the sails then press it along the rock, and it may work
    // its way round it and sail on
    expect(speedAfterHit!).toBeLessThan(cruisingSpeed / 3);
    expect(worstHeel).toBeLessThan(25);
    expect(worstHeightChange).toBeLessThan(0.2);
    expect([...boat.position.toArray(), ...boat.velocity.toArray()].every(Number.isFinite)).toBe(true);
  }, 60_000);

  it('shoves a floating raft out of its way', () => {
    const scenario = boatUnderSail();
    const boat = scenario.boat.body;
    const heading = boat.velocity.clone().setY(0).normalize();
    const cruisingSpeed = boat.velocity.length();
    // wide and flat, so it floats level: 3 × 0.6 × 3 m of wood
    const raftMesh = new Mesh(new BoxGeometry(3, 0.6, 3));
    raftMesh.position.copy(pointAhead(scenario, 9));
    const raft = scenario.world.addBody(raftMesh, { density: 300, shape: 'voxels', collider: 'box' });
    const raftBuoyancy = raft.addBehavior(new Buoyancy({ ocean: scenario.ocean }));
    scenario.run(3);
    const raftFloatingHeight = raft.position.y;
    const raftStart = raft.position.clone();

    let deepest = 0;
    let raftFastest = 0;
    let lowestSubmersion = 1;
    let highestSubmersion = 0;
    scenario.run(10, () => {
      deepest = Math.max(deepest, hullDepthInsideBox(scenario, raft, raft.colliders[0] as BoxCollider));
      raftFastest = Math.max(raftFastest, raft.velocity.dot(heading));
      lowestSubmersion = Math.min(lowestSubmersion, raftBuoyancy.submergedFraction);
      highestSubmersion = Math.max(highestSubmersion, raftBuoyancy.submergedFraction);
    });

    expect(deepest).toBeLessThan(0.03);
    expect(raftFastest).toBeGreaterThan(0.5);
    expect(raft.position.clone().sub(raftStart).dot(heading)).toBeGreaterThan(1);
    expect(boat.velocity.length()).toBeLessThan(cruisingSpeed);
    // pushed, not run over: the raft stays afloat and the boat on top of the water
    expect(Math.abs(raft.position.y - raftFloatingHeight)).toBeLessThan(0.3);
    expect(lowestSubmersion).toBeGreaterThan(0.05);
    expect(highestSubmersion).toBeLessThan(0.95);
    expect(scenario.heelDegrees).toBeLessThan(25);
  }, 60_000);
});
