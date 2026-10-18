import { CapsuleGeometry, ConeGeometry, CylinderGeometry, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  analyzeTopology,
  Body,
  BoxCollider,
  CapsuleCollider,
  ConeCollider,
  CylinderCollider,
  FixedJoint,
  HeightfieldCollider,
  InvalidMassError,
  MassProperties,
  PlaneCollider,
  SphereCollider,
  World,
} from '@eulerjs/core';
import { expectMatrixClose, expectVectorClose } from './helpers.js';

describe('bodies weighed from their colliders', () => {
  it('weigh their solid colliders at the density, a ton per cubic metre unless told', () => {
    const size = new Vector3(2, 1, 1);
    const body = new Body({ colliders: [new BoxCollider({ size })], density: 500 });
    expect(body.mass).toBeCloseTo(1000, 9);
    expectMatrixClose(body.massProperties!.inertia, MassProperties.box(size, 1000).inertia);
    expect(new Body({ colliders: [new BoxCollider({ size })] }).mass).toBeCloseTo(2000, 9);
  });

  it('take a total mass instead, shared by volume, and leave sensors out', () => {
    const body = new Body({
      colliders: [
        new SphereCollider({ radius: 0.5, offset: new Vector3(-1, 0, 0) }),
        new SphereCollider({ radius: 0.5, offset: new Vector3(1, 0, 0) }),
        new BoxCollider({ size: new Vector3(10, 10, 10), offset: new Vector3(0, 5, 0), sensor: true }),
      ],
      mass: 10,
    });
    expect(body.mass).toBeCloseTo(10, 9);
    // two equal balls: the centre of mass halfway between, whatever the sensor
    expectVectorClose(body.massProperties!.centerOfMass, new Vector3(), 1e-9);
  });

  it('refuse a dynamic body with nothing solid to weigh, but not a static one', () => {
    expect(() => new Body({ colliders: [new PlaneCollider()] })).toThrow(InvalidMassError);
    expect(() => new Body({ colliders: [new SphereCollider({ radius: 1, sensor: true })] })).toThrow(InvalidMassError);
    expect(() => new Body({ type: 'static', colliders: [new PlaneCollider()] })).not.toThrow();
  });
});

describe('collider shorthands', () => {
  it('fit a cylinder, a cone and a capsule round three.js geometries of those shapes', () => {
    const world = new World();
    const barrel = world.addBody(new Mesh(new CylinderGeometry(0.4, 0.4, 1, 24)), { collider: 'cylinder' });
    const cone = world.addBody(new Mesh(new ConeGeometry(0.35, 0.8, 20).translate(0, 0.35, 0)), { collider: 'cone' });
    const pillGeometry = new CapsuleGeometry(0.3, 1, 4, 16);
    const pill = world.addBody(new Mesh(pillGeometry), { collider: 'capsule' });
    const barrelCollider = barrel.colliders[0] as CylinderCollider;
    expect(barrelCollider).toBeInstanceOf(CylinderCollider);
    expect(barrelCollider.radius).toBeCloseTo(0.4, 6);
    expect(barrelCollider.height).toBeCloseTo(1, 6);
    const coneCollider = cone.colliders[0] as ConeCollider;
    expect(coneCollider).toBeInstanceOf(ConeCollider);
    expect(coneCollider.radius).toBeCloseTo(0.35, 6);
    expect(coneCollider.height).toBeCloseTo(0.8, 6);
    // where the geometry was moved to
    expectVectorClose(coneCollider.offset, new Vector3(0, 0.35, 0), 1e-6);
    const pillCollider = pill.colliders[0] as CapsuleCollider;
    expect(pillCollider).toBeInstanceOf(CapsuleCollider);
    expect(pillCollider.radius).toBeCloseTo(0.3, 6);
    expect(pillCollider.length).toBeCloseTo(1, 6);
    // weighed by its mesh where that is closed, as three.js's capsule is in r166, and by its
    // collider where it isn't, as in r186
    const pillMass = analyzeTopology(pillGeometry).isClosed
      ? MassProperties.fromMesh(pillGeometry, { density: 1000 }).mass
      : 1000 * pillCollider.massProperties({ density: 1 })!.mass;
    expect(pill.mass).toBeCloseTo(pillMass, 6);
  });
});

describe('heightfield geometry', () => {
  it('is the surface the heightfield collides with, triangle for triangle', () => {
    const heights = Array.from({ length: 9 }, (_unused, row) => Array.from({ length: 13 }, (_unused2, column) => Math.sin(row * 0.9) * Math.cos(column * 0.7) + 0.1 * row));
    const terrain = new HeightfieldCollider({ heights, cellSize: 0.5 });
    const geometry = terrain.toGeometry();
    const positions = geometry.getAttribute('position');
    const index = geometry.getIndex()!;
    expect(positions.count).toBe(9 * 13);
    expect(index.count).toBe(8 * 12 * 6);
    const corners = [new Vector3(), new Vector3(), new Vector3()];
    const normal = new Vector3();
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 0.98 + 0.01;
    for (let trial = 0; trial < 200; trial++) {
      const across = (random() - 0.5) * terrain.width;
      const along = (random() - 0.5) * terrain.depth;
      // the triangle under the point, and its height there
      let found: number | undefined;
      for (let triangle = 0; triangle < index.count / 3 && found === undefined; triangle++) {
        for (let corner = 0; corner < 3; corner++) corners[corner]!.fromBufferAttribute(positions, index.getX(3 * triangle + corner));
        const [first, second, third] = corners as [Vector3, Vector3, Vector3];
        const area = (second.x - first.x) * (third.z - first.z) - (third.x - first.x) * (second.z - first.z);
        const weightSecond = ((across - first.x) * (third.z - first.z) - (third.x - first.x) * (along - first.z)) / area;
        const weightThird = ((second.x - first.x) * (along - first.z) - (across - first.x) * (second.z - first.z)) / area;
        if (weightSecond < 0 || weightThird < 0 || weightSecond + weightThird > 1) continue;
        found = first.y + weightSecond * (second.y - first.y) + weightThird * (third.y - first.y);
        // wound to face up, as a ground mesh should
        normal.crossVectors(second.clone().sub(first), third.clone().sub(first));
        expect(normal.y).toBeGreaterThan(0);
      }
      expect(found).toBeDefined();
      // as near as the geometry's 32-bit floats hold it
      expect(found!).toBeCloseTo(terrain.surfaceHeight(across, along)!, 6);
    }
  });
});

describe('sensor contents', () => {
  it('lists what is inside a sensor now, asleep or awake, and forgets what has left', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    const zone = new BoxCollider({ size: new Vector3(4, 2, 4), offset: new Vector3(0, 1, 0), sensor: true });
    world.addBody(new Body({ type: 'static', colliders: [zone] }));
    const inside = world.addBody(new Body({ position: new Vector3(0, 1, 0), colliders: [new SphereCollider({ radius: 0.3 })] }));
    const outside = world.addBody(new Body({ position: new Vector3(6, 1, 0), colliders: [new SphereCollider({ radius: 0.3 })] }));
    expect(world.inSensor(zone)).toHaveLength(0);
    for (let step = 0; step < 240; step++) world.fixedStep();
    expect(inside.isSleeping).toBe(true);
    expect(world.inSensor(zone).map((hit) => hit.body)).toEqual([inside]);
    expect(world.inSensor(zone).map((hit) => hit.body)).not.toContain(outside);
    world.removeBody(inside);
    expect(world.inSensor(zone)).toHaveLength(0);
  });
});

describe("joints that collide 'unlessOverlapping'", () => {
  it('leave out collisions between bodies made overlapping, and keep them between ones made apart', () => {
    const world = new World({ gravity: new Vector3() });
    const box = (center: Vector3) => world.addBody(new Body({ position: center, colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
    const overlapping = world.addJoint(new FixedJoint({ bodyA: box(new Vector3(0, 0, 0)), bodyB: box(new Vector3(0.8, 0, 0)), anchor: new Vector3(0.4, 0, 0), collideConnected: 'unlessOverlapping' }));
    const apart = world.addJoint(new FixedJoint({ bodyA: box(new Vector3(5, 0, 0)), bodyB: box(new Vector3(6.5, 0, 0)), anchor: new Vector3(5.75, 0, 0), collideConnected: 'unlessOverlapping' }));
    expect(overlapping.collideConnected).toBe(false);
    expect(apart.collideConnected).toBe(true);
    expect(overlapping.collideConnectedSetting).toBe('unlessOverlapping');
  });
});
