import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { BoxCollider, CapsuleCollider, ConeCollider, ConvexCollider, CylinderCollider, SphereCollider } from 'eulerjs';
import type { Collider, ColliderPose } from 'eulerjs';
import { shapeDistance, supportShapeOf, triangleShape } from '../../src/javascript/collision/gjk.js';
import { expectVectorClose } from '../helpers.js';

const pose = (position: Vector3, quaternion = new Quaternion()): ColliderPose => ({
  position,
  quaternion,
  rotation: new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(quaternion)),
});

function distanceBetween(colliderA: Collider, poseA: ColliderPose, colliderB: Collider, poseB: ColliderPose) {
  return shapeDistance(supportShapeOf(colliderA, poseA)!, supportShapeOf(colliderB, poseB)!);
}

const unitBox = new BoxCollider({ size: new Vector3(1, 1, 1) });

describe('GJK distances', () => {
  it('measures spheres and capsules exactly, round surfaces and all', () => {
    const ball = new SphereCollider({ radius: 0.5 });
    const apart = distanceBetween(ball, pose(new Vector3(3, 0, 0)), ball, pose(new Vector3()));
    expect(apart.distance).toBeCloseTo(2, 12);
    expectVectorClose(apart.normal, new Vector3(1, 0, 0), 1e-12);
    expectVectorClose(apart.pointA, new Vector3(2.5, 0, 0), 1e-12);
    const limb = new CapsuleCollider({ radius: 0.25, length: 1 });
    // a capsule standing up, a ball level with its middle
    expect(distanceBetween(ball, pose(new Vector3(2, 0.2, 0)), limb, pose(new Vector3())).distance).toBeCloseTo(2 - 0.75, 12);
    // a ball above its top end
    expect(distanceBetween(ball, pose(new Vector3(0, 3, 0)), limb, pose(new Vector3())).distance).toBeCloseTo(3 - 0.75 - 0.5, 12);
  });

  it('measures boxes face to face, edge to edge and corner to corner', () => {
    expect(distanceBetween(unitBox, pose(new Vector3(2, 0.3, 0.1)), unitBox, pose(new Vector3())).distance).toBeCloseTo(1, 12);
    // turned 45° about z and moved along the diagonal: its edge 0.5√2 from its centre
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    const diagonal = new Vector3(1, 0, 0).multiplyScalar(2);
    expect(distanceBetween(unitBox, pose(diagonal, turned), unitBox, pose(new Vector3())).distance).toBeCloseTo(2 - 0.5 - 0.5 * Math.SQRT2, 12);
    // corner to corner along (1, 1, 1)
    const corner = new Vector3(2, 2, 2);
    const result = distanceBetween(unitBox, pose(corner), unitBox, pose(new Vector3()));
    expect(result.distance).toBeCloseTo(Math.sqrt(3), 12);
    expectVectorClose(result.pointB, new Vector3(0.5, 0.5, 0.5), 1e-9);
  });

  it('measures cylinders and cones on their round sides, flat ends, rims and tips', () => {
    const drum = new CylinderCollider({ radius: 0.5, height: 2 });
    expect(distanceBetween(unitBox, pose(new Vector3(2, 0.4, 0)), drum, pose(new Vector3())).distance).toBeCloseTo(1, 12);
    expect(distanceBetween(unitBox, pose(new Vector3(0.2, 2, 0)), drum, pose(new Vector3())).distance).toBeCloseTo(0.5, 12);
    const ball = new SphereCollider({ radius: 0.1 });
    // off the rim, along the diagonal of the side and the end
    expect(distanceBetween(ball, pose(new Vector3(1.5, 2, 0)), drum, pose(new Vector3())).distance).toBeCloseTo(Math.SQRT2 - 0.1, 12);
    const cone = new ConeCollider({ radius: 0.5, height: 1 });
    expect(distanceBetween(ball, pose(new Vector3(0, 1.5, 0)), cone, pose(new Vector3())).distance).toBeCloseTo(1 - 0.1, 12);
    expect(distanceBetween(ball, pose(new Vector3(0.2, -1.5, 0)), cone, pose(new Vector3())).distance).toBeCloseTo(1 - 0.1, 12);
    // out from the middle of its slant side, square to it
    const slant = new Vector3(1, 0.5, 0).normalize();
    const onSlant = new Vector3(0.25, 0, 0);
    expect(distanceBetween(ball, pose(onSlant.clone().addScaledVector(slant, 1)), cone, pose(new Vector3())).distance).toBeCloseTo(1 - 0.1, 9);
  });

  it('measures a hull, and a triangle', () => {
    const cube = new ConvexCollider({ points: [-1, 1].flatMap((signX) => [-1, 1].flatMap((signY) => [-1, 1].map((signZ) => new Vector3(signX, signY, signZ).multiplyScalar(0.5)))) });
    expect(distanceBetween(cube, pose(new Vector3(0, 3, 0)), unitBox, pose(new Vector3())).distance).toBeCloseTo(2, 12);
    const triangle = triangleShape(new Vector3(-1, 0, -1), new Vector3(0, 0, 1), new Vector3(1, 0, -1));
    expect(shapeDistance(supportShapeOf(unitBox, pose(new Vector3(0, 1, 0)))!, triangle).distance).toBeCloseTo(0.5, 12);
    expect(shapeDistance(supportShapeOf(new SphereCollider({ radius: 0.5 }), pose(new Vector3(3, 0, -1)))!, triangle).distance).toBeCloseTo(1.5, 12);
  });

  it('says when shapes overlap or touch, and not when they are a hair apart', () => {
    expect(distanceBetween(unitBox, pose(new Vector3(0.9, 0.2, 0)), unitBox, pose(new Vector3())).overlapping).toBe(true);
    expect(distanceBetween(unitBox, pose(new Vector3(0.3, 0.1, 0.2)), unitBox, pose(new Vector3())).overlapping).toBe(true);
    const ball = new SphereCollider({ radius: 0.5 });
    expect(distanceBetween(ball, pose(new Vector3(0.95, 0, 0)), ball, pose(new Vector3())).overlapping).toBe(true);
    const hair = distanceBetween(unitBox, pose(new Vector3(1.000001, 0, 0)), unitBox, pose(new Vector3()));
    expect(hair.overlapping).toBe(false);
    expect(hair.distance).toBeCloseTo(1e-6, 12);
  });

  it('agrees with sampled nearest points for boxes in many random poses', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const stick = new BoxCollider({ size: new Vector3(2, 0.2, 0.4) });
    for (let trial = 0; trial < 40; trial++) {
      const turnA = new Quaternion(random(), random(), random(), random()).normalize();
      const turnB = new Quaternion(random(), random(), random(), random()).normalize();
      const poseA = pose(new Vector3(random() * 3, random() * 3, random() * 3), turnA);
      const poseB = pose(new Vector3(random() * 3, random() * 3, random() * 3), turnB);
      const result = distanceBetween(stick, poseA, unitBox, poseB);
      if (result.overlapping) continue;
      // the nearest points really are on each shape, and that far apart
      expect(result.pointA.distanceTo(result.pointB)).toBeCloseTo(result.distance, 9);
      // and no sampled pair of surface points is closer
      const support = (collider: Collider, at: ColliderPose, direction: Vector3) => supportShapeOf(collider, at)!.support(direction, new Vector3());
      for (let sample = 0; sample < 50; sample++) {
        const direction = new Vector3(random(), random(), random());
        const onA = support(stick, poseA, direction);
        const onB = support(unitBox, poseB, direction.clone().negate());
        expect(onA.distanceTo(onB)).toBeGreaterThanOrEqual(result.distance - 1e-9);
      }
    }
  });
});
