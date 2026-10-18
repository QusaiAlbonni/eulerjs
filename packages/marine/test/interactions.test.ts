import { BoxGeometry, Mesh, Quaternion, Vector3 } from 'three';
import { Body, BoxCollider, DistanceJoint, PlaneCollider, World } from 'eulerjs';
import type { ObjectBodyOptions } from 'eulerjs';
import { describe, expect, it } from 'vitest';
import { Buoyancy, Ocean, SpectralWaves, SumOfSines } from '@eulerjs/marine';
import type { WaveSurface } from '@eulerjs/marine';

/** Buoyancy working together with joints and contacts on the same bodies. */

const flatSea = () => new Ocean({ waves: new SumOfSines({ waveCount: 0 }) });

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

function floatingBox(world: World, ocean: Ocean<WaveSurface>, size: Vector3, position: Vector3, options: ObjectBodyOptions = {}): { body: Body; buoyancy: Buoyancy } {
  const mesh = new Mesh(new BoxGeometry(size.x, size.y, size.z));
  mesh.position.copy(position);
  const body = world.addBody(mesh, { shape: 'voxels', collider: 'box', canSleep: false, ...options });
  return { body, buoyancy: body.addBehavior(new Buoyancy({ ocean })) };
}

/** How deep the deepest corner of `box` is inside the box collider of `other`, or 0 if none is. */
function cornerDepthInside(box: Body, other: Body): number {
  const own = box.colliders[0] as BoxCollider;
  const theirs = other.colliders[0] as BoxCollider;
  let deepest = 0;
  for (const signs of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]] as const) {
    const corner = new Vector3(...signs).multiply(own.halfExtents).add(own.offset);
    const local = other.worldToLocal(box.localToWorld(corner)).sub(theirs.offset);
    const depth = Math.min(...(['x', 'y', 'z'] as const).map((axis) => theirs.halfExtents[axis] - Math.abs(local[axis])));
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

describe('buoyancy with joints and contacts', () => {
  it('holds a moored buoy under water with a rope tension of the buoyancy minus the weight', () => {
    const world = new World();
    const ocean = flatSea();
    const { body: buoy } = floatingBox(world, ocean, new Vector3(1, 1, 1), new Vector3(0, -2, 0), { density: 300 });
    const rope = world.addJoint(new DistanceJoint({ bodyA: buoy, anchorA: new Vector3(0, -0.5, 0), anchorB: new Vector3(0, -6, 0), length: 3, slack: true }));
    runFor(world, 10);
    let tension = 0;
    let samples = 0;
    runFor(world, 2, () => {
      tension += rope.tension;
      samples++;
    });
    const expected = (ocean.density - 300) * 9.81;
    expect(Math.abs(tension / samples / expected - 1)).toBeLessThan(0.01);
    expect(buoy.position.y).toBeCloseTo(-6 + 3 + 0.5, 3);
  });

  it('rests a sunken crate on the seabed with a contact force of its weight minus its buoyancy', () => {
    const world = new World();
    const ocean = flatSea();
    world.addBody(new Body({ type: 'static', position: new Vector3(0, -5, 0), colliders: [new PlaneCollider()] }));
    const { body: crate } = floatingBox(world, ocean, new Vector3(1, 1, 1), new Vector3(), { density: 2500 });
    runFor(world, 10);
    let impulse = 0;
    runFor(world, 1, () => {
      impulse += world.contacts.reduce((sum, contact) => sum + contact.normalImpulse, 0);
    });
    expect(Math.abs(impulse / ((2500 - ocean.density) * 9.81) - 1)).toBeLessThan(0.01);
    expect(crate.position.y).toBeCloseTo(-4.5, 3);
  });

  it('sinks a raft by the weight put on it, which rests on the raft without sinking into it', () => {
    const world = new World();
    const ocean = flatSea();
    const { body: raft } = floatingBox(world, ocean, new Vector3(4, 0.5, 4), new Vector3(), { density: 300 });
    runFor(world, 5);
    const heightUnloaded = raft.position.y;
    const crateMesh = new Mesh(new BoxGeometry(1, 1, 1));
    crateMesh.position.set(0.4, raft.position.y + 0.25 + 0.6, -0.3);
    const crate = world.addBody(crateMesh, { density: 500, collider: 'box', canSleep: false });
    let deepest = 0;
    runFor(world, 10, () => {
      deepest = Math.max(deepest, cornerDepthInside(crate, raft));
    });
    // 500 kg more on 16 m² of water
    const expectedSinking = 500 / (ocean.density * 16);
    expect(Math.abs((heightUnloaded - raft.position.y) / expectedSinking - 1)).toBeLessThan(0.05);
    expect(deepest).toBeLessThan(0.005);
    expect(raft.worldToLocal(crate.position.clone()).y).toBeCloseTo(0.75, 3);
    expect(raft.quaternion.angleTo(new Quaternion())).toBeLessThan((3 * Math.PI) / 180);
  });

  it('keeps crates pushed by waves and a steady force against a quay out of the quay, and afloat', () => {
    const world = new World();
    // a fresh breeze's sea, as tall as its wind raises it: the quay's contacts are what this is about
    const ocean = new Ocean({ waves: new SpectralWaves({ windSpeed: 10, heightScale: 1 }) });
    // reaches far below the deepest trough
    const quay = world.addBody(new Body({ type: 'static', position: new Vector3(4, -10, 0), colliders: [new BoxCollider({ size: new Vector3(1, 30, 40) })] }));
    const crates = [0, 1, 2].map((index) => floatingBox(world, ocean, new Vector3(1, 1, 1), new Vector3(-index * 1.6, 0, index * 0.3), { density: 300 }));
    let deepestInQuay = 0;
    let deepestInEachOther = 0;
    let fastest = 0;
    let lowestSubmersion = 1;
    let highestSubmersion = 0;
    runFor(world, 30, () => {
      for (const { body, buoyancy } of crates) {
        body.applyForce(new Vector3(60, 0, 0));
        deepestInQuay = Math.max(deepestInQuay, cornerDepthInside(body, quay));
        for (const { body: other } of crates) if (other !== body) deepestInEachOther = Math.max(deepestInEachOther, cornerDepthInside(body, other));
        fastest = Math.max(fastest, body.velocity.length());
        // the submersion is measured by each step, so there is none before the first
        if (world.stepCount === 0) continue;
        lowestSubmersion = Math.min(lowestSubmersion, buoyancy.submergedFraction);
        highestSubmersion = Math.max(highestSubmersion, buoyancy.submergedFraction);
      }
    });
    expect(deepestInQuay).toBeLessThan(0.02);
    expect(deepestInEachOther).toBeLessThan(0.02);
    expect(fastest).toBeLessThan(6);
    expect(lowestSubmersion).toBeGreaterThan(0);
    expect(highestSubmersion).toBeLessThan(1);
    // they all end up against the quay or each other
    for (const { body } of crates) expect(body.position.x).toBeGreaterThan(0);
    // the spectral sea's FFT runs every step: slow under coverage's instrumentation
  }, 90_000);
});
