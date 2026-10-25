import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, CapsuleCollider, ConvexCollider, CylinderCollider, HeightfieldCollider, JavaScriptBackend, MassProperties, SphereCollider, World } from '@eulerjs/core';
import type { ColliderPose, JavaScriptBackendOptions } from '@eulerjs/core';
import type { ContactPoint } from '../../src/javascript/collision/narrowphase.js';
import { triangleTestFor } from '../../src/javascript/collision/triangle.js';
import { expectVectorClose } from '../helpers.js';

const pose = (position: Vector3, quaternion = new Quaternion()): ColliderPose => ({
  position,
  quaternion,
  rotation: new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(quaternion)),
});

/** A ground triangle in the y = 0 plane, wound anticlockwise seen from above. */
const ground = [new Vector3(-5, 0, -5), new Vector3(0, 0, 5), new Vector3(5, 0, -5)] as const;

function againstGround(collider: Parameters<typeof triangleTestFor>[0], at: ColliderPose, oneSided = false, margin = 0): ContactPoint[] {
  const contacts: ContactPoint[] = [];
  triangleTestFor(collider, at)!(...ground, contacts, margin, oneSided);
  return contacts;
}

/** Heights of a plane rising `slope` metres per metre along x. */
function sloped(rows: number, columns: number, cellSize: number, slope: number): number[][] {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, (_unused, column) => slope * (column * cellSize - ((columns - 1) * cellSize) / 2)));
}

describe('triangle contact points', () => {
  it('meets a sphere at its nearest point, inside the face, on an edge or at a corner', () => {
    const ball = new SphereCollider({ radius: 0.5 });
    const onFace = againstGround(ball, pose(new Vector3(0, 0.4, 0)));
    expect(onFace).toHaveLength(1);
    expect(onFace[0]!.depth).toBeCloseTo(0.1, 12);
    expectVectorClose(onFace[0]!.normal, new Vector3(0, 1, 0), 1e-12);
    const atCorner = againstGround(ball, pose(new Vector3(5.3, 0, -5.3)));
    expect(atCorner[0]!.depth).toBeCloseTo(0.5 - 0.3 * Math.SQRT2, 12);
    expectVectorClose(atCorner[0]!.pointB, ground[2], 1e-12);
    expect(againstGround(ball, pose(new Vector3(0, 0.6, 0)))).toHaveLength(0);
  });

  it('pushes a sphere sunk below a one-sided triangle back up through its face, and a two-sided one out the way it is nearer', () => {
    const ball = new SphereCollider({ radius: 0.5 });
    const oneSided = againstGround(ball, pose(new Vector3(0, -0.2, 0)), true);
    expect(oneSided[0]!.depth).toBeCloseTo(0.7, 12);
    expectVectorClose(oneSided[0]!.normal, new Vector3(0, 1, 0), 1e-12);
    const twoSided = againstGround(ball, pose(new Vector3(0, -0.2, 0)));
    expect(twoSided[0]!.depth).toBeCloseTo(0.3, 12);
    expectVectorClose(twoSided[0]!.normal, new Vector3(0, -1, 0), 1e-12);
  });

  it('rests a box on a triangle on the four corners of its face, and a capsule on both ends', () => {
    const box = againstGround(new BoxCollider({ size: new Vector3(1, 1, 1) }), pose(new Vector3(0, 0.49, 0)));
    expect(box).toHaveLength(4);
    for (const contact of box) {
      expect(contact.depth).toBeCloseTo(0.01, 12);
      expectVectorClose(contact.normal, new Vector3(0, 1, 0), 1e-12);
    }
    const lyingDown = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const capsule = againstGround(new CapsuleCollider({ radius: 0.25, length: 1 }), pose(new Vector3(0, 0.24, 0), lyingDown));
    expect(capsule).toHaveLength(2);
    for (const contact of capsule) expect(contact.depth).toBeCloseTo(0.01, 12);
  });

  it('clips a triangle that is smaller than the box face it touches', () => {
    // a small triangle pressed into the bottom of a big box: the contacts are the triangle's corners
    const big = new BoxCollider({ size: new Vector3(20, 1, 20) });
    const contacts = againstGround(big, pose(new Vector3(0, 0.49, 0)));
    expect(contacts).toHaveLength(3);
    expect(contacts.map((contact) => contact.pointB.x).sort((first, second) => first - second)).toEqual([-5, 0, 5]);
  });

  it('catches the corner of a tilted hull on the triangle', () => {
    const cube = new ConvexCollider({ points: [-1, 1].flatMap((signX) => [-1, 1].flatMap((signY) => [-1, 1].map((signZ) => new Vector3(signX, signY, signZ).multiplyScalar(0.5)))) });
    // balanced on a corner: the corner 0.5√3 below the centre
    const onCorner = new Quaternion().setFromUnitVectors(new Vector3(1, 1, 1).normalize(), new Vector3(0, 1, 0));
    const contacts = againstGround(cube, pose(new Vector3(0, 0.5 * Math.sqrt(3) - 0.01, 0), onCorner));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.depth).toBeCloseTo(0.01, 9);
  });
});

describe('heightfields', () => {
  it('interpolates the surface between its points and reports its size', () => {
    const field = new HeightfieldCollider({ heights: [[0, 1], [2, 3]], cellSize: 2 });
    expect(field.width).toBe(2);
    expect(field.depth).toBe(2);
    expect(field.surfaceHeight(-1, -1)).toBe(0);
    expect(field.surfaceHeight(1, 1)).toBe(3);
    // halfway along the diagonal, and a plane in between since these heights are planar
    expect(field.surfaceHeight(0, 0)).toBeCloseTo(1.5, 12);
    expect(field.surfaceHeight(0.5, -0.5)).toBeCloseTo(1.5 + 0.25 + 0.5 * -1, 12);
    expect(field.surfaceHeight(2, 0)).toBeUndefined();
  });

  it('rejects grids that are too small, ragged or not finite', () => {
    expect(() => new HeightfieldCollider({ heights: [[0, 0]], cellSize: 1 })).toThrow(RangeError);
    expect(() => new HeightfieldCollider({ heights: [[0, 0], [0]], cellSize: 1 })).toThrow(RangeError);
    expect(() => new HeightfieldCollider({ heights: [[0, 0], [0, Number.NaN]], cellSize: 1 })).toThrow(RangeError);
    expect(() => new HeightfieldCollider({ heights: [[0, 0], [0, 0]], cellSize: 0 })).toThrow(RangeError);
    expect(() => new HeightfieldCollider({ heights: [[0, 0], [0, 0]], cellSize: 1, cellDepth: 0 })).toThrow(RangeError);
  });

  it('spaces its rows by cellDepth where that is given', () => {
    // three columns 2 m apart along x, five rows 0.5 m apart along z, rising 1 m a row
    const heights = Array.from({ length: 5 }, (_unused, row) => [row, row, row]);
    const field = new HeightfieldCollider({ heights, cellSize: 2, cellDepth: 0.5 });
    expect(field.width).toBe(4);
    expect(field.depth).toBe(2);
    expectVectorClose(field.pointAt(4, 2, new Vector3()), new Vector3(2, 4, 1), 1e-12);
    expect(field.surfaceHeight(0.3, 0.25)).toBeCloseTo(2.5, 12);
    expect(field.surfaceHeight(0, 1.1)).toBeUndefined();
    expect(field.surfaceHeight(1.9, 0)).toBeCloseTo(2, 12);
  });
});

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('heightfields in a world (%s)', (solver) => {
  const terrainWorld = (heights: number[][], cellSize: number, friction = 0.5) => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', colliders: [new HeightfieldCollider({ heights, cellSize, friction })] }));
    return world;
  };

  it('rests a ball, a box, a capsule and a cylinder on flat terrain as on the ground, asleep', () => {
    const world = terrainWorld(sloped(11, 11, 2, 0), 2);
    const ball = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(1.3, 1, 0.7), colliders: [new SphereCollider({ radius: 0.5 })] }));
    const crate = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: new Vector3(-3, 1, 1), colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
    const capsule = new CapsuleCollider({ radius: 0.25, length: 1 });
    const limb = world.addBody(new Body({ massProperties: capsule.massProperties({ density: 500 }), position: new Vector3(3, 1, -3), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), colliders: [capsule] }));
    const drumShape = new CylinderCollider({ radius: 0.5, height: 1 });
    const drum = world.addBody(new Body({ massProperties: drumShape.massProperties({ density: 500 }), position: new Vector3(-3, 1, -4), colliders: [drumShape] }));
    for (let step = 0; step < 300; step++) world.fixedStep();
    expect(ball.position.y).toBeCloseTo(0.5, 2);
    expect(crate.position.y).toBeCloseTo(0.5, 2);
    expect(limb.position.y).toBeCloseTo(0.25, 2);
    expect(drum.position.y).toBeCloseTo(0.5, 2);
    for (const body of [ball, crate, limb, drum]) expect(body.isSleeping).toBe(true);
  });

  it('rolls a ball down a sloped heightfield at 5/7 g sin θ, across the cells', () => {
    const slope = 0.25;
    const world = terrainWorld(sloped(9, 41, 1, slope), 1, 0.9);
    const tilt = Math.atan(slope);
    const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
    const startX = 12;
    const ball = world.addBody(
      new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(startX, slope * startX, 0.3).addScaledVector(up, 0.5), canSleep: false, colliders: [new SphereCollider({ radius: 0.5, friction: 0.9, rollingResistance: 0 })] }),
    );
    const downhill = new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
    for (let step = 0; step < 30; step++) world.fixedStep();
    const speedBefore = ball.velocity.dot(downhill);
    for (let step = 0; step < 60; step++) world.fixedStep();
    expect(Math.abs((ball.velocity.dot(downhill) - speedBefore) / ((5 / 7) * 9.81 * Math.sin(tilt)) - 1)).toBeLessThan(0.01);
    const field = new HeightfieldCollider({ heights: sloped(9, 41, 1, slope), cellSize: 1 });
    // still on the surface: its centre a radius from it, measured square to the slope
    const surface = field.surfaceHeight(ball.position.x, ball.position.z)!;
    expect((ball.position.y - surface) * Math.cos(tilt)).toBeCloseTo(0.5, 2);
  });

  it('rests a box on cells longer along x than along z where the surface is', () => {
    // a gentle rise along z, its cells 2 m by 0.5 m
    const heights = Array.from({ length: 21 }, (_unused, row) => Array.from({ length: 6 }, () => 0.05 * row));
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    const field = new HeightfieldCollider({ heights, cellSize: 2, cellDepth: 0.5, friction: 0.9 });
    world.addBody(new Body({ type: 'static', colliders: [field] }));
    const crate = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: new Vector3(0.7, 2, 1.3), colliders: [new BoxCollider({ size: new Vector3(1, 1, 1), friction: 0.9 })] }));
    for (let step = 0; step < 300; step++) world.fixedStep();
    const tilt = Math.atan(0.05 / 0.5);
    expect((crate.position.y - field.surfaceHeight(crate.position.x, crate.position.z)!) * Math.cos(tilt)).toBeCloseTo(0.5, 2);
    expect(crate.velocity.length()).toBeLessThan(0.01);
  });

  it('holds a box still on a hillside gentler than its friction angle', () => {
    const slope = 0.3;
    const world = terrainWorld(sloped(9, 21, 1, slope), 1, 0.6);
    const tilt = Math.atan(slope);
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt);
    const crate = world.addBody(
      new Body({
        massProperties: MassProperties.box(new Vector3(1, 1, 1), 10),
        position: new Vector3(2.4, slope * 2.4, 0.4).add(new Vector3(0, 0.5, 0).applyQuaternion(turned)),
        quaternion: turned,
        canSleep: false,
        colliders: [new BoxCollider({ size: new Vector3(1, 1, 1), friction: 0.6 })],
      }),
    );
    for (let step = 0; step < 60; step++) world.fixedStep();
    const settled = crate.position.clone();
    for (let step = 0; step < 180; step++) world.fixedStep();
    expect(crate.position.distanceTo(settled)).toBeLessThan(0.002);
  });

  it('pushes a body that ends up below the terrain back out on top', () => {
    const world = terrainWorld(sloped(5, 5, 2, 0), 2);
    const ball = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0.5, -0.3, 0.5), colliders: [new SphereCollider({ radius: 0.5 })] }));
    for (let step = 0; step < 120; step++) world.fixedStep();
    expect(ball.position.y).toBeCloseTo(0.5, 2);
  });
});
