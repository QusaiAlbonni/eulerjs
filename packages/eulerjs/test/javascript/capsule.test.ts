import { BoxGeometry, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, CapsuleCollider, ConvexCollider, MassProperties, PlaneCollider, SphereCollider, World } from 'eulerjs';
import type { ColliderPose } from 'eulerjs';
import { collide } from '../../src/javascript/collision/narrowphase.js';
import type { ContactPoint } from '../../src/javascript/collision/narrowphase.js';
import { expectMatrixClose, expectVectorClose } from '../helpers.js';

const pose = (position: Vector3, quaternion = new Quaternion()): ColliderPose => ({
  position,
  quaternion,
  rotation: new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(quaternion)),
});
/** Turned to lie along x. */
const lyingDown = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
const capsule = new CapsuleCollider({ radius: 0.25, length: 1 });

function contactsBetween(first: Parameters<typeof collide>[0], firstPose: ColliderPose, second: Parameters<typeof collide>[2], secondPose: ColliderPose, margin = 0): ContactPoint[] {
  const contacts: ContactPoint[] = [];
  collide(first, firstPose, second, secondPose, contacts, margin);
  return contacts;
}

const sortedPoints = (contacts: ContactPoint[]) =>
  contacts.map((contact) => contact.pointA.toArray().map((value) => Math.round(value * 1e6) / 1e6)).sort((first, second) => first[0]! - second[0]! || first[2]! - second[2]!);

describe('capsule contact points', () => {
  it('rests on a plane on both ends when lying down, on one when standing', () => {
    const lying = contactsBetween(capsule, pose(new Vector3(0, 0.24, 0), lyingDown), new PlaneCollider(), pose(new Vector3()));
    expect(lying).toHaveLength(2);
    for (const contact of lying) {
      expect(contact.depth).toBeCloseTo(0.01, 12);
      expectVectorClose(contact.normal, new Vector3(0, 1, 0), 1e-12);
    }
    expect(sortedPoints(lying).map((point) => point[0])).toEqual([-0.5, 0.5]);
    const standing = contactsBetween(capsule, pose(new Vector3(0, 0.74, 0)), new PlaneCollider(), pose(new Vector3()));
    expect(standing).toHaveLength(1);
    expect(standing[0]!.depth).toBeCloseTo(0.01, 12);
  });

  it('meets a sphere at the nearest point of its middle segment', () => {
    const [contact, ...rest] = contactsBetween(capsule, pose(new Vector3(), lyingDown), new SphereCollider({ radius: 0.5 }), pose(new Vector3(0.3, -0.7, 0)));
    expect(rest).toHaveLength(0);
    // the segment point nearest (0.3, -0.7) is (0.3, 0): 0.7 apart, radii 0.75
    expect(contact!.depth).toBeCloseTo(0.05, 12);
    expectVectorClose(contact!.normal, new Vector3(0, 1, 0), 1e-12);
    expectVectorClose(contact!.pointA, new Vector3(0.3, -0.25, 0), 1e-12);
  });

  it('crosses another capsule at one point, and lies along one on two', () => {
    const across = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const crossing = contactsBetween(capsule, pose(new Vector3(0.2, 0, 0), lyingDown), capsule, pose(new Vector3(0, -0.45, 0.1), across));
    expect(crossing).toHaveLength(1);
    expect(crossing[0]!.depth).toBeCloseTo(0.05, 12);
    expectVectorClose(crossing[0]!.pointA, new Vector3(0, -0.25, 0), 1e-12);
    const alongside = contactsBetween(capsule, pose(new Vector3(0, 0, 0), lyingDown), capsule, pose(new Vector3(0, -0.45, 0), lyingDown));
    expect(alongside).toHaveLength(2);
    for (const contact of alongside) expect(contact.depth).toBeCloseTo(0.05, 12);
  });

  it('finds where two capsules cross at a shallow angle, deeper than at either end', () => {
    // 4° apart, close enough to parallel to rest on both ends, yet deepest where they cross
    const shallow = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (4 * Math.PI) / 180).multiply(lyingDown);
    const contacts = contactsBetween(capsule, pose(new Vector3(), lyingDown), capsule, pose(new Vector3(0, -0.45, 0), shallow));
    expect(contacts).toHaveLength(3);
    const deepest = contacts.reduce((best, contact) => (contact.depth > best.depth ? contact : best));
    expect(deepest.depth).toBeCloseTo(0.05, 12);
    expectVectorClose(deepest.pointA, new Vector3(0, -0.25, 0), 1e-12);
  });

  it('lies on a box on both ends, and across a box edge at the crossing', () => {
    const box = new BoxCollider({ size: new Vector3(2, 1, 2) });
    const lying = contactsBetween(capsule, pose(new Vector3(0, 0.74, 0), lyingDown), box, pose(new Vector3()));
    expect(lying).toHaveLength(2);
    for (const contact of lying) expect(contact.depth).toBeCloseTo(0.01, 9);
    // sloping down across the box's top edge at x = 1, y = 0.5, both ends clear: only the middle touches
    const slope = new Vector3(1, -0.4, 0).normalize();
    const center = new Vector3(1, 0.7, 0);
    const acrossEdge = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), slope);
    const overEdge = contactsBetween(capsule, pose(center, acrossEdge), box, pose(new Vector3()));
    expect(overEdge).toHaveLength(1);
    const edgeDistance = new Vector3(1, 0.5, 0).sub(center).cross(slope).length();
    expect(overEdge[0]!.depth).toBeCloseTo(0.25 - edgeDistance, 6);
    expectVectorClose(overEdge[0]!.pointB, new Vector3(1, 0.5, 0), 1e-6);
  });

  it('meets a convex hull of a box just as it meets the box', () => {
    const box = new BoxCollider({ size: new Vector3(2, 1, 2) });
    const hull = ConvexCollider.fromGeometry(new BoxGeometry(2, 1, 2));
    for (const capsulePose of [pose(new Vector3(0, 0.74, 0), lyingDown), pose(new Vector3(0.4, 0.95, -0.3), new Quaternion().setFromAxisAngle(new Vector3(1, 0.3, 0.2).normalize(), 0.8))]) {
      const withBox = contactsBetween(capsule, capsulePose, box, pose(new Vector3()), 0.05);
      const withHull = contactsBetween(capsule, capsulePose, hull, pose(new Vector3()), 0.05);
      expect(withHull.length).toBe(withBox.length);
      expect(sortedPoints(withHull)).toEqual(sortedPoints(withBox));
    }
  });

  it('reports nothing for shapes that are apart', () => {
    expect(contactsBetween(capsule, pose(new Vector3(0, 2, 0)), new PlaneCollider(), pose(new Vector3()))).toHaveLength(0);
    expect(contactsBetween(capsule, pose(new Vector3(3, 0, 0)), new BoxCollider({ size: new Vector3(1, 1, 1) }), pose(new Vector3()))).toHaveLength(0);
    expect(contactsBetween(capsule, pose(new Vector3(3, 0, 0)), capsule, pose(new Vector3()))).toHaveLength(0);
  });
});

describe('capsule mass properties', () => {
  it('matches the capsule filled with small cubes', () => {
    const radius = 0.25;
    const halfLength = 0.5;
    const cellSize = 0.01;
    const cells: Vector3[] = [];
    for (let east = -radius; east < radius; east += cellSize) {
      for (let up = -halfLength - radius; up < halfLength + radius; up += cellSize) {
        for (let north = -radius; north < radius; north += cellSize) {
          const cell = new Vector3(east + cellSize / 2, up + cellSize / 2, north + cellSize / 2);
          const nearestOnAxis = new Vector3(0, Math.min(Math.max(cell.y, -halfLength), halfLength), 0);
          if (cell.distanceTo(nearestOnAxis) <= radius) cells.push(cell);
        }
      }
    }
    const filled = MassProperties.fromCells(cells, cellSize, { mass: 3 });
    const exact = new CapsuleCollider({ radius, length: 2 * halfLength }).massProperties({ mass: 3 });
    expectMatrixClose(exact.inertia, filled.inertia, 0.01);
  });

  it('is a sphere when it has no length, and turns with the collider', () => {
    const ball = MassProperties.capsule(0.5, 0, 2);
    expectMatrixClose(ball.inertia, MassProperties.sphere(0.5, 2).inertia, 1e-12);
    const upright = new CapsuleCollider({ radius: 0.2, length: 1 }).massProperties({ density: 1000 });
    const lying = new CapsuleCollider({ radius: 0.2, length: 1, rotation: lyingDown }).massProperties({ density: 1000 });
    expect(lying.mass).toBeCloseTo(1000 * (Math.PI * 0.04 + (4 / 3) * Math.PI * 0.008), 9);
    expect(lying.inertia.elements[0]).toBeCloseTo(upright.inertia.elements[4]!, 9);
    expect(lying.inertia.elements[4]).toBeCloseTo(upright.inertia.elements[0]!, 9);
  });

  it('rejects a radius that is not positive and a negative length', () => {
    expect(() => new CapsuleCollider({ radius: 0, length: 1 })).toThrow(RangeError);
    expect(() => new CapsuleCollider({ radius: 1, length: -1 })).toThrow(RangeError);
  });
});

describe('capsules in a world', () => {
  it('comes to rest lying on the ground on both ends, and falls asleep', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    const shape = new CapsuleCollider({ radius: 0.25, length: 1 });
    const body = world.addBody(new Body({ massProperties: shape.massProperties({ density: 500 }), position: new Vector3(0, 1, 0), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.3), colliders: [shape] }));
    for (let step = 0; step < 240; step++) world.fixedStep();
    expect(body.position.y).toBeCloseTo(0.25, 3);
    // lying along the ground: its axis is level
    expect(Math.abs(body.directionToWorld(new Vector3(0, 1, 0)).y)).toBeLessThan(1e-3);
    expect(body.isSleeping).toBe(true);
  });

  it('rolls down a slope on its side at g sin θ / (1 + I / m r²), like a cylinder with rounded ends', () => {
    const world = new World();
    const tilt = 0.25;
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9, rotation: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt) })] }));
    const shape = new CapsuleCollider({ radius: 0.25, length: 1, friction: 0.9 });
    const massProperties = shape.massProperties({ density: 500 });
    const up = new Vector3(0, Math.cos(tilt), Math.sin(tilt));
    // lying across the slope, along x, so it rolls down toward +z
    const body = world.addBody(new Body({ massProperties, position: up.clone().multiplyScalar(0.25), quaternion: lyingDown, colliders: [shape], canSleep: false }));
    const downhill = new Vector3(0, -Math.sin(tilt), Math.cos(tilt));
    for (let step = 0; step < 30; step++) world.fixedStep();
    const speedBefore = body.velocity.dot(downhill);
    for (let step = 0; step < 60; step++) world.fixedStep();
    const acceleration = body.velocity.dot(downhill) - speedBefore;
    const rollingInertia = massProperties.inertia.elements[4]!;
    const expected = (9.81 * Math.sin(tilt)) / (1 + rollingInertia / (massProperties.mass * 0.25 ** 2));
    expect(Math.abs(acceleration / expected - 1)).toBeLessThan(0.01);
  });
});
