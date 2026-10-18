import { BoxGeometry, Group, Matrix3, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Body, InvalidMassError, MassProperties, World } from 'eulerjs';
import type { Behavior } from 'eulerjs';
import { diagonal, expectMatrixClose, expectVectorClose } from './helpers.js';

const box = () => MassProperties.box(new Vector3(2, 4, 6), 48);

describe('Body construction', () => {
  it('requires mass properties for a dynamic body', () => {
    expect(() => new Body()).toThrow(InvalidMassError);
  });

  it('rejects mass properties that cannot rotate, such as a lone point mass', () => {
    expect(() => new Body({ massProperties: MassProperties.point(1, new Vector3()) })).toThrow(/positive definite/);
  });

  it('overrides the mass and scales the inertia to match', () => {
    const body = new Body({ massProperties: box(), mass: 480 });
    expect(body.mass).toBe(480);
    expectMatrixClose(body.massProperties!.inertia, diagonal(2080, 1600, 800));
  });

  it('takes its initial pose from the bound object, parents included', () => {
    const parent = new Group();
    parent.position.set(10, 0, 0);
    parent.rotation.y = Math.PI / 2;
    const child = new Object3D();
    child.position.set(0, 0, 1);
    parent.add(child);
    const body = new Body({ massProperties: box(), object: child });
    expectVectorClose(body.position, new Vector3(11, 0, 0), 1e-12);
    expect(body.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2))).toBeLessThan(1e-9);
  });

  it('lets explicit options override the bound object pose', () => {
    const object = new Object3D();
    object.position.set(1, 2, 3);
    const body = new Body({ massProperties: box(), object, position: new Vector3(4, 5, 6) });
    expectVectorClose(body.position, new Vector3(4, 5, 6));
  });

  it('reports infinite mass and zero inverse mass for immovable bodies', () => {
    const ground = new Body({ type: 'static' });
    expect(ground.mass).toBe(Infinity);
    expect(ground.inverseMass).toBe(0);
  });
});

describe('Body mass', () => {
  it('setMass rescales the inertia instead of keeping the old one', () => {
    const body = new Body({ massProperties: box() });
    body.setMass(480);
    expect(body.inverseMass).toBeCloseTo(1 / 480, 15);
    expectMatrixClose(body.massProperties!.inertia, diagonal(2080, 1600, 800));
  });

  it('setMass needs existing mass properties', () => {
    expect(() => new Body({ type: 'kinematic' }).setMass(1)).toThrow(InvalidMassError);
  });
});

describe('Body frames', () => {
  const rotatedBody = () =>
    new Body({
      massProperties: MassProperties.box(new Vector3(1, 1, 1), 1, new Vector3(0, 1, 0)),
      position: new Vector3(3, 0, 0),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2),
    });

  it('converts points between the body frame and world space', () => {
    const body = rotatedBody();
    const worldPoint = body.localToWorld(new Vector3(1, 0, 0));
    expectVectorClose(worldPoint, new Vector3(3, 1, 0), 1e-12);
    expectVectorClose(body.worldToLocal(worldPoint), new Vector3(1, 0, 0), 1e-12);
  });

  it('rotates directions without translating them', () => {
    expectVectorClose(rotatedBody().directionToWorld(new Vector3(1, 0, 0)), new Vector3(0, 1, 0), 1e-12);
  });

  it('places the centre of mass using the full pose', () => {
    // local centre of mass (0, 1, 0) turned a quarter about z lands at (-1, 0, 0) from the origin
    expectVectorClose(rotatedBody().worldCenterOfMass, new Vector3(2, 0, 0), 1e-12);
  });

  it('gives the velocity of a point on a spinning, moving body', () => {
    const body = new Body({ massProperties: box(), velocity: new Vector3(1, 0, 0), angularVelocity: new Vector3(0, 0, 2) });
    expectVectorClose(body.pointVelocity(new Vector3(0, 1, 0)), new Vector3(-1, 0, 0), 1e-12);
  });

  it('teleports with setPose without interpolating from the old pose', () => {
    const body = new Body({ massProperties: box() });
    body.setPose(new Vector3(5, 0, 0), new Quaternion());
    expectVectorClose(body.previousPosition, new Vector3(5, 0, 0));
    expectVectorClose(body.worldCenterOfMass, new Vector3(5, 0, 0));
  });
});

describe('Body inertia in world space', () => {
  it('turns the inverse inertia tensor with the body: R I⁻¹ Rᵀ', () => {
    // an uneven box, off its axes, so every element of the tensor matters
    const tilted = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
    const massProperties = MassProperties.box(new Vector3(1, 2, 3), 5);
    const unevenInertia = massProperties.inertia.clone().premultiply(new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(tilted)));
    const symmetric = unevenInertia.clone().multiply(new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(tilted)).transpose());
    const body = new Body({ massProperties: new MassProperties(5, new Vector3(), symmetric) });
    for (const angle of [0.3, 1.7, 2.9]) {
      const rotation = new Quaternion().setFromAxisAngle(new Vector3(-2, 1, 0.5).normalize(), angle);
      body.setPose(new Vector3(), rotation);
      const turn = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(rotation));
      const expected = turn.clone().multiply(symmetric.clone().invert()).multiply(turn.clone().transpose());
      expectMatrixClose(body.worldInverseInertia, expected, 1e-12);
    }
  });
});

describe('Body impulses and forces', () => {
  it('changes velocity by J / m and spin by I⁻¹ (r × J)', () => {
    const body = new Body({ massProperties: box() });
    body.applyImpulse(new Vector3(0, 48, 0), new Vector3(1, 0, 0));
    expectVectorClose(body.velocity, new Vector3(0, 1, 0), 1e-12);
    expectVectorClose(body.angularVelocity, new Vector3(0, 0, 48 / 80), 1e-12);
  });

  it('accumulates torque from forces applied away from the centre of mass', () => {
    const body = new Body({ massProperties: box() });
    body.applyForce(new Vector3(0, 0, 2), new Vector3(0, 3, 0));
    body.applyTorque(new Vector3(1, 0, 0));
    expectVectorClose(body.torque, new Vector3(7, 0, 0), 1e-12);
    body.clearForces();
    expect(body.force.length() + body.torque.length()).toBe(0);
  });

  it('ignores forces, torques and impulses on immovable bodies', () => {
    const platform = new Body({ type: 'kinematic' });
    platform.applyForce(new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    platform.applyTorque(new Vector3(1, 0, 0));
    platform.applyImpulse(new Vector3(1, 0, 0));
    expect(platform.force.length() + platform.torque.length() + platform.velocity.length()).toBe(0);
  });
});

describe('Body behaviours', () => {
  it('attaches, runs every step and detaches', () => {
    const world = new World();
    const body = world.addBody(new Body({ massProperties: box() }));
    const behavior: Behavior = { attach: vi.fn(), fixedUpdate: vi.fn(), detach: vi.fn() };
    expect(body.addBehavior(behavior)).toBe(behavior);
    expect(behavior.attach).toHaveBeenCalledWith(body);
    world.fixedStep();
    expect(behavior.fixedUpdate).toHaveBeenCalledWith(body, world.timestep, world);
    body.removeBehavior(behavior);
    expect(behavior.detach).toHaveBeenCalledWith(body);
    world.fixedStep();
    expect(behavior.fixedUpdate).toHaveBeenCalledTimes(1);
    expect(body.behaviors).toHaveLength(0);
  });

  it('ignores removing a behaviour that was never added', () => {
    const body = new Body({ massProperties: box() });
    expect(() => body.removeBehavior({ fixedUpdate: () => {} })).not.toThrow();
  });
});

describe('Body object sync', () => {
  it('interpolates the bound object between the last two steps', () => {
    const object = new Object3D();
    const world = new World({ gravity: new Vector3(), timestep: 0.1 });
    const body = world.addBody(new Body({ massProperties: box(), object, velocity: new Vector3(1, 0, 0) }));
    world.fixedStep();
    body.syncObject(0.5);
    expectVectorClose(object.position, new Vector3(0.05, 0, 0), 1e-12);
    body.syncObject(1);
    expectVectorClose(object.position, new Vector3(0.1, 0, 0), 1e-12);
  });

  it('accounts for a transformed parent, so the object lands at the body pose in world space', () => {
    const parent = new Group();
    parent.position.set(0, 10, 0);
    parent.rotation.x = 0.4;
    const object = new Object3D();
    parent.add(object);
    const body = new Body({ massProperties: box(), position: new Vector3(1, 2, 3) });
    Object.defineProperty(body, 'object', { value: object });
    body.syncObject();
    expectVectorClose(object.getWorldPosition(new Vector3()), new Vector3(1, 2, 3), 1e-9);
  });

  it('does nothing without a bound object', () => {
    expect(() => new Body({ massProperties: box() }).syncObject()).not.toThrow();
  });

  it('builds mass properties from a mesh and keeps the mesh frame as the body frame', () => {
    const geometry = new BoxGeometry(1, 1, 1).translate(0, -2, 0);
    const body = new Body({ massProperties: MassProperties.fromMesh(geometry, { mass: 1 }), position: new Vector3(0, 5, 0) });
    expectVectorClose(body.worldCenterOfMass, new Vector3(0, 3, 0), 1e-9);
  });
});
