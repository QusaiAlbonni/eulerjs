import { ConeGeometry, CylinderGeometry, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, ConeCollider, CylinderCollider, HeightfieldCollider, JavaScriptBackend, MassProperties, PlaneCollider, SphereCollider, World } from 'eulerjs';
import type { ColliderPose, JavaScriptBackendOptions } from 'eulerjs';
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
const cylinder = new CylinderCollider({ radius: 0.5, height: 2 });
const cone = new ConeCollider({ radius: 0.5, height: 1 });

function contactsBetween(first: Parameters<typeof collide>[0], firstPose: ColliderPose, second: Parameters<typeof collide>[2], secondPose: ColliderPose, margin = 0): ContactPoint[] {
  const contacts: ContactPoint[] = [];
  collide(first, firstPose, second, secondPose, contacts, margin);
  return contacts;
}

describe('cylinder and cone mass properties', () => {
  it('match a finely divided mesh of the same shape', () => {
    const cylinderMesh = MassProperties.fromMesh(new CylinderGeometry(0.5, 0.5, 2, 512), { mass: 3 });
    const cylinderExact = cylinder.massProperties({ mass: 3 });
    expectMatrixClose(cylinderExact.inertia, cylinderMesh.inertia, 1e-4);
    expectVectorClose(cylinderExact.centerOfMass, cylinderMesh.centerOfMass, 1e-9);
    const coneMesh = MassProperties.fromMesh(new ConeGeometry(0.5, 1, 512), { mass: 2 });
    const coneExact = cone.massProperties({ mass: 2 });
    expectMatrixClose(coneExact.inertia, coneMesh.inertia, 1e-4);
    // a quarter of the way up from the base
    expectVectorClose(coneExact.centerOfMass, new Vector3(0, -0.25, 0), 1e-12);
    expectVectorClose(coneExact.centerOfMass, coneMesh.centerOfMass, 1e-5);
  });

  it('weigh their volume times the density, and turn and move with the collider', () => {
    expect(cylinder.massProperties({ density: 1000 }).mass).toBeCloseTo(1000 * Math.PI * 0.25 * 2, 9);
    expect(cone.massProperties({ density: 1000 }).mass).toBeCloseTo((1000 * Math.PI * 0.25 * 1) / 3, 9);
    const moved = new ConeCollider({ radius: 0.5, height: 1, rotation: lyingDown, offset: new Vector3(1, 0, 0) }).massProperties({ mass: 2 });
    // turned to point along -x, so the centre of mass is a quarter of the height toward +x of the offset
    expectVectorClose(moved.centerOfMass, new Vector3(1.25, 0, 0), 1e-12);
    const upright = cone.massProperties({ mass: 2 });
    expect(moved.inertia.elements[0]).toBeCloseTo(upright.inertia.elements[4]!, 12);
  });

  it('reject a radius or height that is not positive', () => {
    expect(() => new CylinderCollider({ radius: 0, height: 1 })).toThrow(RangeError);
    expect(() => new ConeCollider({ radius: 1, height: -1 })).toThrow(RangeError);
  });
});

describe('cylinder and cone contact points', () => {
  it('stands a cylinder on a patch at the rim of its end, and lays one on the line along its side', () => {
    const standing = contactsBetween(cylinder, pose(new Vector3(0, 0.99, 0)), new PlaneCollider(), pose(new Vector3()));
    expect(standing).toHaveLength(4);
    for (const contact of standing) {
      expect(contact.depth).toBeCloseTo(0.01, 12);
      expect(Math.hypot(contact.pointA.x, contact.pointA.z)).toBeCloseTo(0.5, 12);
    }
    const lying = contactsBetween(cylinder, pose(new Vector3(0, 0.49, 0), lyingDown), new PlaneCollider(), pose(new Vector3()));
    expect(lying).toHaveLength(2);
    const ends = lying.map((contact) => contact.pointA.x).sort();
    expect(ends[0]).toBeCloseTo(-1, 12);
    expect(ends[1]).toBeCloseTo(1, 12);
    for (const contact of lying) expect(contact.depth).toBeCloseTo(0.01, 12);
  });

  it('tips a cone on its rim, and lays one on its side from the tip to the rim', () => {
    const tilted = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    const onRim = contactsBetween(cone, pose(new Vector3(0, 0.6, 0), tilted), new PlaneCollider(), pose(new Vector3()));
    expect(onRim).toHaveLength(1);
    // the slant makes atan(r / h) with the axis: lying on its side, the axis is tilted that much from the ground
    const slantAngle = Math.atan(0.5 / 1);
    const onSide = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2 + slantAngle);
    // the tip and the lowest point of the base rim are both half the height times sin(slant) below the centre
    const center = new Vector3(0, 0.5 * Math.sin(slantAngle) - 0.001, 0);
    const lying = contactsBetween(cone, pose(center, onSide), new PlaneCollider(), pose(new Vector3()));
    expect(lying).toHaveLength(2);
    for (const contact of lying) expect(contact.depth).toBeCloseTo(0.001, 9);
  });

  it('meets a sphere at the nearest point of a cylinder: its side, its end or its rim', () => {
    const ball = new SphereCollider({ radius: 0.25 });
    const side = contactsBetween(ball, pose(new Vector3(0.7, 0.3, 0)), cylinder, pose(new Vector3()));
    expect(side).toHaveLength(1);
    expect(side[0]!.depth).toBeCloseTo(0.05, 12);
    expectVectorClose(side[0]!.normal, new Vector3(1, 0, 0), 1e-12);
    const end = contactsBetween(ball, pose(new Vector3(0.1, 1.2, 0)), cylinder, pose(new Vector3()));
    expect(end[0]!.depth).toBeCloseTo(0.05, 12);
    expectVectorClose(end[0]!.normal, new Vector3(0, 1, 0), 1e-12);
    const rim = contactsBetween(ball, pose(new Vector3(0.5 + 0.1, 1 + 0.1, 0)), cylinder, pose(new Vector3()));
    expect(rim[0]!.depth).toBeCloseTo(0.25 - Math.SQRT2 * 0.1, 12);
    expectVectorClose(rim[0]!.pointB, new Vector3(0.5, 1, 0), 1e-12);
    const inside = contactsBetween(ball, pose(new Vector3(0.4, 0, 0)), cylinder, pose(new Vector3()));
    expect(inside[0]!.depth).toBeCloseTo(0.25 + 0.1, 12);
    expectVectorClose(inside[0]!.normal, new Vector3(1, 0, 0), 1e-12);
  });

  it('collides with other shapes as a prism around the round shape, which holds them no closer than it would', () => {
    const box = new BoxCollider({ size: new Vector3(2, 2, 2) });
    // the box's top face at y = 1, the cylinder lying on it touching at its lowest line
    const touching = contactsBetween(cylinder, pose(new Vector3(0, 1.49, 0), lyingDown), box, pose(new Vector3()));
    expect(touching.length).toBeGreaterThanOrEqual(2);
    // the prism's flat sides touch the circle and its corners stand out of it by up to 2% of the radius
    const cornerReach = 0.5 / Math.cos(Math.PI / 16) - 0.5;
    const deepest = Math.max(...touching.map((contact) => contact.depth));
    expect(deepest).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(deepest).toBeLessThanOrEqual(0.01 + cornerReach + 1e-9);
    expect(contactsBetween(cone, pose(new Vector3(0, 1.6, 0)), box, pose(new Vector3()))).toHaveLength(0);
  });
});

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('cylinders and cones in a world (%s)', (solver) => {
  const world = (gravityTilt = 0, friction = 0.5) => {
    const created = new World({ backend: new JavaScriptBackend({ solver }) });
    created.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction, rotation: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), gravityTilt) })] }));
    return created;
  };

  it('rolls a cylinder down a slope at g sin θ / (1 + I / m r²), two thirds of g sin θ', () => {
    const tilt = 0.25;
    const slope = world(tilt, 0.9);
    const shape = new CylinderCollider({ radius: 0.5, height: 1, friction: 0.9 });
    const massProperties = shape.massProperties({ density: 500 });
    const up = new Vector3(0, Math.cos(tilt), Math.sin(tilt));
    const body = slope.addBody(new Body({ massProperties, position: up.clone().multiplyScalar(0.5), quaternion: lyingDown, colliders: [shape], canSleep: false }));
    const downhill = new Vector3(0, -Math.sin(tilt), Math.cos(tilt));
    for (let step = 0; step < 30; step++) slope.fixedStep();
    const speedBefore = body.velocity.dot(downhill);
    for (let step = 0; step < 60; step++) slope.fixedStep();
    const acceleration = body.velocity.dot(downhill) - speedBefore;
    expect(Math.abs(acceleration / ((2 / 3) * 9.81 * Math.sin(tilt)) - 1)).toBeLessThan(0.01);
    // rolling on its side, not sinking in or lifting off
    expect(body.position.clone().sub(body.position.clone().projectOnPlane(up)).length()).toBeCloseTo(0.5, 3);
  });

  it.each(['plane', 'heightfield'])('rolls a cone round its tip on a %s without gaining energy', (ground) => {
    const floor = new World({ backend: new JavaScriptBackend({ solver }) });
    const flat = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 0));
    floor.addBody(new Body({ type: 'static', colliders: [ground === 'plane' ? new PlaneCollider({ friction: 0.8 }) : new HeightfieldCollider({ heights: flat, cellSize: 1, friction: 0.8 })] }));
    const shape = new ConeCollider({ radius: 0.35, height: 0.8, friction: 0.7 });
    // on its side, the line from its tip to its rim flat on the ground
    const halfAngle = Math.atan2(0.35, 0.8);
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2 + halfAngle);
    const body = floor.addBody(new Body({ position: new Vector3(0.3, 0.3, 0.3), quaternion, colliders: [shape], density: 400, canSleep: ground === 'heightfield' }));
    for (let step = 0; step < 60; step++) floor.fixedStep();
    const inertia = new Matrix3();
    const energy = (): number => {
      inertia.copy(body.worldInverseInertia).invert();
      const spin = body.angularVelocity;
      return 0.5 * body.mass * body.velocity.lengthSq() + 0.5 * spin.dot(spin.clone().applyMatrix3(inertia)) + body.mass * 9.81 * body.position.y;
    };
    const resting = energy();
    // set it rolling about the line it lies on
    body.angularVelocity.copy(body.directionToWorld(new Vector3(0, 1, 0)).setY(0).normalize().multiplyScalar(2));
    const tip = (): Vector3 => body.pointToWorld(new Vector3(0, 0.4, 0), new Vector3());
    const tipBefore = tip();
    const rolling = energy() - resting;
    let settled = rolling;
    for (let step = 0; step < 600; step++) {
      floor.fixedStep();
      // it may lose some, never gain
      expect(energy() - resting).toBeLessThan(rolling * 1.01);
      // nor, on the exact round contacts of a plane, once it has settled into rolling (a hull
      // rises and falls as it rolls over its edges)
      if (step === 60) settled = energy() - resting;
      if (step > 60 && ground === 'plane') expect(energy() - resting).toBeLessThan(settled + 0.01 * rolling);
    }
    if (ground === 'heightfield') {
      // which collides as its hull, a prism that loses some energy each time it rolls over an edge, and stops
      expect(body.isSleeping).toBe(true);
      return;
    }
    expect(energy() - resting).toBeGreaterThan(rolling * 0.2);
    // rolling without slipping, round its tip, which stays put
    expect(tip().distanceTo(tipBefore)).toBeLessThan(0.05);
  });

  it('lets cones dropped on rolling hills come to rest and fall asleep', () => {
    const hills = new World({ backend: new JavaScriptBackend({ solver }) });
    const heights = Array.from({ length: 41 }, (_unused, row) => Array.from({ length: 41 }, (_unused2, column) => 3 * Math.sin(row / 7) * Math.cos(column / 9) + 0.08 * (row + column)));
    const terrain = new HeightfieldCollider({ heights, cellSize: 1, friction: 0.8 });
    hills.addBody(new Body({ type: 'static', colliders: [terrain] }));
    const cones = Array.from({ length: 16 }, (_unused, dropped) => {
      const across = 8 * Math.sin(dropped * 1.3);
      const along = 8 * Math.cos(dropped * 0.7);
      const position = new Vector3(across, terrain.surfaceHeight(across, along)! + 2, along);
      const quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 1).normalize(), dropped);
      return hills.addBody(new Body({ position, quaternion, colliders: [new ConeCollider({ radius: 0.35, height: 0.8, friction: 0.7 })], density: 400 }));
    });
    for (let step = 0; step < 60 * 20; step++) hills.fixedStep();
    // a cone lying on its side would roll round its tip for ever on round contacts; on the
    // heightfield it collides as its hull, which rolls to a stop, and it must not rock on its edges
    expect(cones.filter((cone) => !cone.isSleeping)).toHaveLength(0);
  });

  it('stands a cylinder and a cone on their bases, and lays a fallen cylinder on its side, all asleep', () => {
    const floor = world();
    const standing = floor.addBody(new Body({ massProperties: cylinder.massProperties({ density: 500 }), position: new Vector3(0, 1.02, 0), colliders: [cylinder] }));
    const upright = floor.addBody(new Body({ massProperties: cone.massProperties({ density: 500 }), position: new Vector3(3, 0.52, 0), colliders: [cone] }));
    const tipped = floor.addBody(
      new Body({ massProperties: cylinder.massProperties({ density: 500 }), position: new Vector3(-3, 1.5, 0), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.2), colliders: [cylinder] }),
    );
    for (let step = 0; step < 300; step++) floor.fixedStep();
    expect(standing.position.y).toBeCloseTo(1, 2);
    expect(standing.directionToWorld(new Vector3(0, 1, 0)).y).toBeCloseTo(1, 4);
    expect(upright.position.y).toBeCloseTo(0.5, 2);
    expect(tipped.position.y).toBeCloseTo(0.5, 2);
    expect(Math.abs(tipped.directionToWorld(new Vector3(0, 1, 0)).y)).toBeLessThan(1e-2);
    for (const body of [standing, upright, tipped]) expect(body.isSleeping).toBe(true);
  });

  it('rests a cylinder on a box and a ball on a cylinder', () => {
    const floor = world();
    const box = floor.addBody(new Body({ type: 'static', position: new Vector3(0, 0.5, 0), colliders: [new BoxCollider({ size: new Vector3(3, 1, 3) })] }));
    const log = floor.addBody(new Body({ massProperties: cylinder.massProperties({ density: 500 }), position: new Vector3(0, 1.55, 0), quaternion: lyingDown, colliders: [cylinder] }));
    const drum = floor.addBody(new Body({ massProperties: cylinder.massProperties({ density: 500 }), position: new Vector3(5, 1.02, 0), colliders: [cylinder] }));
    const ball = floor.addBody(new Body({ massProperties: MassProperties.sphere(0.25, 1), position: new Vector3(5, 2.3, 0), colliders: [new SphereCollider({ radius: 0.25 })] }));
    for (let step = 0; step < 300; step++) floor.fixedStep();
    expect(box.position.y).toBe(0.5);
    // on the prism, which stands no lower than the round shape would
    expect(log.position.y).toBeGreaterThan(1.5 - 0.002);
    expect(log.position.y).toBeLessThan(1.5 + 0.02);
    expect(ball.position.y).toBeCloseTo(2.25, 2);
    expect(log.isSleeping && drum.isSleeping && ball.isSleeping).toBe(true);
  });
});
