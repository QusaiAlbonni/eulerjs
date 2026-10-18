import { Box3, Quaternion, Ray, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  Body,
  BoxCollider,
  CapsuleCollider,
  ConeCollider,
  ConvexCollider,
  CylinderCollider,
  HeightfieldCollider,
  MassProperties,
  PlaneCollider,
  SphereCollider,
  World,
} from '@eulerjs/core';
import type { Collider } from '@eulerjs/core';
import { expectVectorClose } from '../helpers.js';

const down = new Vector3(0, -1, 0);
const along = new Vector3(1, 0, 0);

function staticWorld(...colliders: { collider: Collider; position?: Vector3; quaternion?: Quaternion }[]): { world: World; bodies: Body[] } {
  const world = new World({ gravity: new Vector3() });
  const bodies = colliders.map(({ collider, position, quaternion }) => world.addBody(new Body({ type: 'static', position, quaternion, colliders: [collider] })));
  return { world, bodies };
}

describe('ray casts', () => {
  it('meet each convex shape where it is, with its surface normal', () => {
    const cases: [Collider, Vector3, Vector3, number, Vector3][] = [
      // shape, ray origin, direction, expected distance, expected normal
      [new SphereCollider({ radius: 0.5 }), new Vector3(-3, 0.3, 0), along, 3 - Math.sqrt(0.25 - 0.09), new Vector3(-Math.sqrt(0.16), 0.3, 0).normalize()],
      [new BoxCollider({ size: new Vector3(2, 1, 1) }), new Vector3(-3, 0.2, 0.1), along, 2, new Vector3(-1, 0, 0)],
      [new CapsuleCollider({ radius: 0.25, length: 1 }), new Vector3(0, 3, 0), down, 3 - 0.75, new Vector3(0, 1, 0)],
      [new CapsuleCollider({ radius: 0.25, length: 1 }), new Vector3(-2, 0.2, 0), along, 2 - 0.25, new Vector3(-1, 0, 0)],
      [new CylinderCollider({ radius: 0.5, height: 2 }), new Vector3(-3, 0.7, 0.3), along, 3 - 0.4, new Vector3(-0.4, 0, 0.3).normalize()],
      [new CylinderCollider({ radius: 0.5, height: 2 }), new Vector3(0.2, 4, 0.1), down, 3, new Vector3(0, 1, 0)],
      [new ConeCollider({ radius: 0.5, height: 1 }), new Vector3(0.1, -3, 0), new Vector3(0, 1, 0), 2.5, new Vector3(0, -1, 0)],
      // down onto the slant of a cone at x = 0.25: halfway down, so y = 0
      [new ConeCollider({ radius: 0.5, height: 1 }), new Vector3(0.25, 3, 0), down, 3, new Vector3(1, 0.5, 0).normalize()],
    ];
    for (const [collider, origin, direction, distance, normal] of cases) {
      const { world, bodies } = staticWorld({ collider });
      const hit = world.castRay(origin, direction)!;
      expect(hit, `${collider.shape} from ${origin.toArray()}`).toBeDefined();
      expect(hit.distance, collider.shape).toBeCloseTo(distance, 6);
      expectVectorClose(hit.normal, normal, 1e-5);
      expectVectorClose(hit.point, origin.clone().addScaledVector(direction, distance), 1e-6);
      expect(hit.body).toBe(bodies[0]);
      expect(hit.collider).toBe(collider);
    }
  });

  it('agree with three.js on random rays at a turned box', () => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const size = new Vector3(2, 0.6, 1.2);
    for (let trial = 0; trial < 50; trial++) {
      const turn = new Quaternion(random(), random(), random(), random()).normalize();
      const center = new Vector3(random(), random(), random());
      const { world } = staticWorld({ collider: new BoxCollider({ size }), position: center, quaternion: turn });
      const origin = new Vector3(random(), random(), random()).multiplyScalar(4);
      const direction = center.clone().add(new Vector3(random(), random(), random()).multiplyScalar(0.8)).sub(origin).normalize();
      // the same ray in the box's frame, against three.js's axis-aligned box
      const inverse = turn.clone().invert();
      const localRay = new Ray(origin.clone().sub(center).applyQuaternion(inverse), direction.clone().applyQuaternion(inverse));
      const expected = localRay.intersectBox(new Box3(size.clone().multiplyScalar(-0.5), size.clone().multiplyScalar(0.5)), new Vector3());
      const hit = world.castRay(origin, direction);
      if (!expected) {
        expect(hit).toBeUndefined();
        continue;
      }
      expect(hit!.distance).toBeCloseTo(expected.distanceTo(localRay.origin), 6);
    }
  });

  it('meet a plane and a heightfield from above, and nothing from below the terrain', () => {
    const { world } = staticWorld({ collider: new PlaneCollider() });
    expect(world.castRay(new Vector3(0, 2, 0), new Vector3(1, -1, 0))!.distance).toBeCloseTo(2 * Math.SQRT2, 9);
    expect(world.castRay(new Vector3(0, 2, 0), new Vector3(1, 1, 0))).toBeUndefined();
    const heights = Array.from({ length: 5 }, (_unused, row) => Array.from({ length: 5 }, (_unused2, column) => 0.25 * (row + column)));
    const field = new HeightfieldCollider({ heights, cellSize: 1 });
    const terrain = staticWorld({ collider: field });
    const hit = terrain.world.castRay(new Vector3(0.3, 10, -0.6), down)!;
    expect(hit.distance).toBeCloseTo(10 - field.surfaceHeight(0.3, -0.6)!, 9);
    expectVectorClose(hit.normal, new Vector3(-0.25, 1, -0.25).normalize(), 1e-9);
    expect(terrain.world.castRay(new Vector3(0.3, -5, -0.6), new Vector3(0, 1, 0))).toBeUndefined();
  });

  it('meet a solid at once from inside it', () => {
    const { world } = staticWorld({ collider: new BoxCollider({ size: new Vector3(2, 2, 2) }) });
    const hit = world.castRay(new Vector3(0.2, 0.1, 0), along)!;
    expect(hit.distance).toBe(0);
  });

  it('find the nearest of several, or all of them in order, within the distance asked', () => {
    const ball = () => new SphereCollider({ radius: 0.5 });
    const { world, bodies } = staticWorld({ collider: ball(), position: new Vector3(6, 0, 0) }, { collider: ball(), position: new Vector3(2, 0, 0) }, { collider: ball(), position: new Vector3(4, 0, 0) });
    expect(world.castRay(new Vector3(), along)!.body).toBe(bodies[1]);
    expect(world.castRayAll(new Vector3(), along).map((hit) => hit.body)).toEqual([bodies[1], bodies[2], bodies[0]]);
    expect(world.castRayAll(new Vector3(), along, { maxDistance: 4 }).map((hit) => hit.body)).toEqual([bodies[1], bodies[2]]);
    expect(world.castRay(new Vector3(), along, { maxDistance: 1 })).toBeUndefined();
  });

  it('skip excluded bodies, other collision groups, sensors and whatever the filter turns down', () => {
    const near = new SphereCollider({ radius: 0.5, collisionGroups: 0b10 });
    const middle = new SphereCollider({ radius: 0.5, sensor: true });
    const far = new SphereCollider({ radius: 0.5 });
    const { world, bodies } = staticWorld({ collider: near, position: new Vector3(2, 0, 0) }, { collider: middle, position: new Vector3(4, 0, 0) }, { collider: far, position: new Vector3(6, 0, 0) });
    expect(world.castRay(new Vector3(), along)!.collider).toBe(near);
    expect(world.castRay(new Vector3(), along, { exclude: bodies[0] })!.collider).toBe(far);
    expect(world.castRay(new Vector3(), along, { collidesWith: 0b1 })!.collider).toBe(far);
    expect(world.castRay(new Vector3(), along, { exclude: [bodies[0]!], includeSensors: true })!.collider).toBe(middle);
    expect(world.castRay(new Vector3(), along, { filter: (body) => body === bodies[2] })!.collider).toBe(far);
  });

  it('see bodies where they are now: added, moved by hand or moved by the simulation', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    const ball = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 10, 0), canSleep: false, colliders: [new SphereCollider({ radius: 0.5 })] }));
    // before any step
    expect(world.castRay(new Vector3(0, 20, 0), down)!.distance).toBeCloseTo(9.5, 9);
    // moved by hand
    ball.position.set(0, 5, 0);
    expect(world.castRay(new Vector3(0, 20, 0), down)!.distance).toBeCloseTo(14.5, 9);
    // falling
    for (let step = 0; step < 30; step++) world.fixedStep();
    expect(world.castRay(new Vector3(0, 20, 0), down)!.distance).toBeCloseTo(20 - ball.position.y - 0.5, 9);
    // fast, sideways: still found where it has got to
    ball.velocity.set(30, 0, 0);
    for (let step = 0; step < 3; step++) world.fixedStep();
    expect(world.castRay(new Vector3(ball.position.x, 20, 0), down)!.body).toBe(ball);
  });

  it('refuse a direction of zero', () => {
    expect(() => new World().castRay(new Vector3(), new Vector3())).toThrow();
  });
});

describe('shape casts', () => {
  it('slide a sphere, a box and a capsule until they touch, wherever they first do', () => {
    const { world } = staticWorld({ collider: new BoxCollider({ size: new Vector3(2, 2, 2) }), position: new Vector3(5, 0, 0) });
    const ball = world.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(0, 0.3, 0), along)!;
    expect(ball.distance).toBeCloseTo(3.5, 6);
    expectVectorClose(ball.normal, new Vector3(-1, 0, 0), 1e-6);
    expect(ball.point.x).toBeCloseTo(4, 6);
    // a box turned 45° meets the face with its edge
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    const crate = world.castShape(new BoxCollider({ size: new Vector3(1, 1, 1) }), new Vector3(0, 0.2, 0), along, { quaternion: turned })!;
    expect(crate.distance).toBeCloseTo(4 - 0.5 * Math.SQRT2, 6);
    // a capsule lying along x, its end leading
    const lying = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const limb = world.castShape(new CapsuleCollider({ radius: 0.25, length: 1 }), new Vector3(0, 0, 0), along, { quaternion: lying })!;
    expect(limb.distance).toBeCloseTo(4 - 0.75, 6);
  });

  it('meet a box edge-on that a box sliding past only just catches', () => {
    // the moving box's top edge clips the fixed box's bottom edge by 1 cm
    const { world } = staticWorld({ collider: new BoxCollider({ size: new Vector3(1, 1, 1) }), position: new Vector3(5, 0.99, 0) });
    const hit = world.castShape(new BoxCollider({ size: new Vector3(1, 1, 1) }), new Vector3(), along)!;
    expect(hit.distance).toBeCloseTo(4, 6);
    expect(world.castShape(new BoxCollider({ size: new Vector3(1, 1, 1) }), new Vector3(0, -0.02, 0), along, { maxDistance: 10 })).toBeUndefined();
  });

  it('drop shapes onto a plane, a heightfield and round shapes', () => {
    const plane = staticWorld({ collider: new PlaneCollider() }).world;
    expect(plane.castShape(new CylinderCollider({ radius: 0.5, height: 1 }), new Vector3(0, 3, 0), down)!.distance).toBeCloseTo(2.5, 9);
    const terrain = staticWorld({ collider: new HeightfieldCollider({ heights: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 1)), cellSize: 1 }) }).world;
    expect(terrain.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(0.3, 5, 0.2), down)!.distance).toBeCloseTo(3.5, 6);
    const drum = staticWorld({ collider: new CylinderCollider({ radius: 1, height: 1 }) }).world;
    // a ball dropped onto the rim, off centre: it touches where it is a radius from the rim
    const hit = drum.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(1.3, 5, 0), down)!;
    expect(hit.distance).toBeCloseTo(5 - 0.5 - Math.sqrt(0.25 - 0.09), 6);
    expectVectorClose(hit.point, new Vector3(1, 0.5, 0), 1e-6);
  });

  it('touch at once when the shape starts overlapping, and miss what is out of the way', () => {
    const { world } = staticWorld({ collider: new BoxCollider({ size: new Vector3(2, 2, 2) }) });
    expect(world.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(1.2, 0, 0), along)!.distance).toBe(0);
    expect(world.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(-5, 3, 0), along)).toBeUndefined();
    expect(world.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(-5, 0, 0), along, { maxDistance: 3 })).toBeUndefined();
  });

  it('refuse shapes that are not convex solids', () => {
    expect(() => new World().castShape(new PlaneCollider(), new Vector3(), along)).toThrow();
  });
});

describe('overlap tests', () => {
  it('find every collider a shape overlaps or touches, and no others', () => {
    const box = () => new BoxCollider({ size: new Vector3(1, 1, 1) });
    const hull = new ConvexCollider({ points: [new Vector3(0, 1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(-1, -1, -1)] });
    const { world, bodies } = staticWorld(
      { collider: box(), position: new Vector3(1.4, 0, 0) },
      { collider: box(), position: new Vector3(-1.6, 0, 0) },
      { collider: hull, position: new Vector3(0, 0, 1.3) },
      { collider: new PlaneCollider(), position: new Vector3(0, -5, 0) },
    );
    const found = world.overlap(new SphereCollider({ radius: 1 }), new Vector3()).map((hit) => hit.body);
    expect(found).toContain(bodies[0]);
    expect(found).not.toContain(bodies[1]);
    expect(found).toContain(bodies[2]);
    expect(found).not.toContain(bodies[3]);
    expect(world.overlap(new SphereCollider({ radius: 1 }), new Vector3(0, -4.5, 0)).map((hit) => hit.body)).toContain(bodies[3]);
  });

  it('count a body sunk into terrain as overlapping it', () => {
    const { world, bodies } = staticWorld({ collider: new HeightfieldCollider({ heights: Array.from({ length: 4 }, () => [0, 0, 0, 0]), cellSize: 1 }) });
    expect(world.overlap(new SphereCollider({ radius: 0.2 }), new Vector3(0.1, -0.5, 0.2)).map((hit) => hit.body)).toEqual([bodies[0]]);
    expect(world.overlap(new SphereCollider({ radius: 0.2 }), new Vector3(0.1, 0.5, 0.2))).toHaveLength(0);
  });
});
