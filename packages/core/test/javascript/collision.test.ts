import { BoxGeometry, Mesh, Object3D, Quaternion, SphereGeometry, Vector3 } from 'three';
import type { Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, Collider, MassProperties, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import type { ColliderPose } from '@eulerjs/core';
import { collide, registerCollisionTest } from '../../src/javascript/collision/narrowphase.js';
import type { ContactPoint } from '../../src/javascript/collision/narrowphase.js';
import { Matrix3, Matrix4 } from 'three';

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

function ground(world: World, options: { friction?: number; restitution?: number; tilt?: number } = {}): Body {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), options.tilt ?? 0);
  return world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: options.friction, restitution: options.restitution, rotation })] }));
}

function ball(world: World, position: Vector3, options: { radius?: number; restitution?: number; velocity?: Vector3; canSleep?: boolean } = {}): Body {
  const radius = options.radius ?? 0.5;
  return world.addBody(
    new Body({
      massProperties: MassProperties.sphere(radius, 1),
      position,
      velocity: options.velocity,
      canSleep: options.canSleep,
      colliders: [new SphereCollider({ radius, restitution: options.restitution })],
    }),
  );
}

function crate(world: World, position: Vector3, options: { size?: Vector3; friction?: number; quaternion?: Quaternion } = {}): Body {
  const size = options.size ?? new Vector3(1, 1, 1);
  return world.addBody(
    new Body({ massProperties: MassProperties.box(size, 10), position, quaternion: options.quaternion, colliders: [new BoxCollider({ size, friction: options.friction })] }),
  );
}

const pose = (position: Vector3, quaternion = new Quaternion()): ColliderPose => ({
  position,
  quaternion,
  rotation: new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(quaternion)),
});

describe('contact points', () => {
  it('sphere on sphere: along the line of centres, as deep as the overlap', () => {
    const contacts: ContactPoint[] = [];
    collide(new SphereCollider({ radius: 1 }), pose(new Vector3(1.5, 0, 0)), new SphereCollider({ radius: 1 }), pose(new Vector3()), contacts);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.depth).toBeCloseTo(0.5, 12);
    expect(contacts[0]!.normal.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-12);
  });

  it('box on plane: one contact per corner below the surface', () => {
    const contacts: ContactPoint[] = [];
    collide(new BoxCollider({ size: new Vector3(1, 1, 1) }), pose(new Vector3(0, 0.4, 0)), new PlaneCollider(), pose(new Vector3()), contacts);
    expect(contacts).toHaveLength(4);
    for (const contact of contacts) expect(contact.depth).toBeCloseTo(0.1, 12);
  });

  it('box on box, face to face: a patch of four points', () => {
    const contacts: ContactPoint[] = [];
    const box = new BoxCollider({ size: new Vector3(1, 1, 1) });
    collide(box, pose(new Vector3(0.2, 0.95, 0.1)), box, pose(new Vector3()), contacts);
    expect(contacts).toHaveLength(4);
    for (const contact of contacts) {
      expect(contact.depth).toBeCloseTo(0.05, 9);
      expect(contact.normal.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    }
  });

  it('box on box, edge across edge: one point between the edges', () => {
    const contacts: ContactPoint[] = [];
    const box = new BoxCollider({ size: new Vector3(1, 1, 1) });
    const turnedAboutX = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 4);
    const turnedAboutZ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    // two boxes balanced on edges that cross at right angles, overlapping by 0.05
    const height = Math.SQRT2 - 0.05;
    collide(box, pose(new Vector3(0, height, 0), turnedAboutZ), box, pose(new Vector3(), turnedAboutX), contacts);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.depth).toBeCloseTo(0.05, 6);
    expect(contacts[0]!.pointA.distanceTo(new Vector3(0, height - Math.SQRT1_2, 0))).toBeLessThan(1e-6);
  });

  it('sphere against box, inside and outside', () => {
    const box = new BoxCollider({ size: new Vector3(2, 2, 2) });
    const outside: ContactPoint[] = [];
    collide(new SphereCollider({ radius: 0.5 }), pose(new Vector3(0, 1.3, 0)), box, pose(new Vector3()), outside);
    expect(outside[0]!.depth).toBeCloseTo(0.2, 12);
    const inside: ContactPoint[] = [];
    collide(new SphereCollider({ radius: 0.5 }), pose(new Vector3(0.9, 0, 0)), box, pose(new Vector3()), inside);
    expect(inside[0]!.normal.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-12);
    expect(inside[0]!.depth).toBeCloseTo(0.6, 12);
  });

  it('flips the result when the registered test is for the other order', () => {
    const contacts: ContactPoint[] = [];
    collide(new PlaneCollider(), pose(new Vector3()), new SphereCollider({ radius: 1 }), pose(new Vector3(0, 0.5, 0)), contacts);
    expect(contacts[0]!.normal.distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-12);
    expect(contacts[0]!.pointA.y).toBeCloseTo(0, 12);
  });

  it('lets plugins add shapes', () => {
    class PointCollider extends Collider {
      readonly shape = 'point';
      get boundingRadius(): number {
        return 0;
      }
      bounds(colliderPose: ColliderPose, target: Box3): Box3 {
        return target.setFromPoints([colliderPose.position]);
      }
      massProperties(): undefined {
        return undefined;
      }
    }
    let called = false;
    registerCollisionTest('point', 'plane', () => {
      called = true;
    });
    collide(new PointCollider(), pose(new Vector3()), new PlaneCollider(), pose(new Vector3()), []);
    expect(called).toBe(true);
  });
});

describe('collisions in a world', () => {
  it.each([0.5, 0.8])('bounces a ball with restitution %s back to e² of its drop height', (restitution) => {
    const world = new World({ substeps: 8 });
    ground(world);
    const body = ball(world, new Vector3(0, 3.5, 0), { restitution });
    let fallen = false;
    let peak = 0;
    runFor(world, 3, () => {
      if (body.velocity.y < -1) fallen = true;
      if (fallen && body.velocity.y > 0) peak = Math.max(peak, body.position.y - 0.5);
    });
    expect(Math.abs(peak / (3 * restitution ** 2) - 1)).toBeLessThan(0.03);
  });

  it('rests a box placed on the ground perfectly still', () => {
    const world = new World({ substeps: 8 });
    ground(world);
    const body = crate(world, new Vector3(0, 0.5, 0));
    runFor(world, 10);
    expect(body.position.y).toBeCloseTo(0.5, 3);
    expect(Math.hypot(body.position.x, body.position.z)).toBeLessThan(1e-4);
    expect(body.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-4);
    expect(body.velocity.length()).toBeLessThan(1e-6);
  });

  it('lands a dropped box with a small shift, and no creep after it', () => {
    const world = new World({ substeps: 8 });
    ground(world);
    const body = crate(world, new Vector3(0, 1, 0));
    runFor(world, 2);
    const landedAt = body.position.clone();
    runFor(world, 10);
    expect(Math.hypot(landedAt.x, landedAt.z)).toBeLessThan(0.005);
    expect(body.position.distanceTo(landedAt)).toBeLessThan(1e-5);
  });

  it('holds a block on a slope while tan θ < μ', () => {
    const world = new World({ substeps: 8 });
    const tilt = 0.3; // tan 0.3 ≈ 0.31
    const slope = ground(world, { tilt, friction: 0.6 });
    const along = new Vector3(Math.cos(tilt), Math.sin(tilt), 0);
    const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
    const block = crate(world, up.clone().multiplyScalar(0.5), { quaternion: slope.colliders[0]!.rotation, friction: 0.6 });
    runFor(world, 0.5);
    const startAlong = block.position.dot(along);
    runFor(world, 3);
    expect(Math.abs(block.position.dot(along) - startAlong)).toBeLessThan(0.01);
  });

  it('slides a block down a slope with acceleration g (sin θ - μ cos θ) once tan θ > μ', () => {
    const world = new World({ substeps: 8 });
    const tilt = 0.5;
    const friction = 0.3;
    const slope = ground(world, { tilt, friction });
    const downhill = new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
    const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
    const block = crate(world, up.clone().multiplyScalar(0.5), { quaternion: slope.colliders[0]!.rotation, friction });
    runFor(world, 0.5);
    const speedBefore = block.velocity.dot(downhill);
    runFor(world, 1);
    const acceleration = block.velocity.dot(downhill) - speedBefore;
    const expected = 9.81 * (Math.sin(tilt) - friction * Math.cos(tilt));
    expect(Math.abs(acceleration / expected - 1)).toBeLessThan(0.03);
  });

  it('swaps the velocities of equal balls in an elastic head-on collision, conserving momentum', () => {
    const world = new World({ gravity: new Vector3(), substeps: 8 });
    const left = ball(world, new Vector3(-2, 0, 0), { velocity: new Vector3(2, 0, 0), restitution: 1 });
    const right = ball(world, new Vector3(2, 0, 0), { velocity: new Vector3(-1, 0, 0), restitution: 1 });
    runFor(world, 3);
    expect(left.velocity.x).toBeCloseTo(-1, 2);
    expect(right.velocity.x).toBeCloseTo(2, 2);
    expect(left.velocity.x + right.velocity.x).toBeCloseTo(1, 9);
  });

  it('makes equal balls move on together after a perfectly inelastic collision', () => {
    const world = new World({ gravity: new Vector3(), substeps: 8 });
    const left = ball(world, new Vector3(-2, 0, 0), { velocity: new Vector3(2, 0, 0) });
    const right = ball(world, new Vector3(2, 0, 0));
    runFor(world, 3);
    expect(left.velocity.x).toBeCloseTo(1, 2);
    expect(right.velocity.x).toBeCloseTo(1, 2);
  });

  it('stops both ends of an edge that strikes a wall, without rolling over it', () => {
    // a tall box, its centre of mass halfway up, flying edge first into a frictionless wall at 40°:
    // the edge's two ends must share the blow so that neither goes into the wall, which leaves
    // the box no turn about the wall's horizontal line, only about the vertical
    const world = new World({ gravity: new Vector3() });
    world.addBody(new Body({ type: 'static', position: new Vector3(0, 0, 12), colliders: [new BoxCollider({ size: new Vector3(200, 20, 4), friction: 0 })] }));
    const heading = (40 * Math.PI) / 180;
    const direction = new Vector3(Math.cos(heading), 0, Math.sin(heading));
    const box = world.addBody(
      new Body({ position: new Vector3(-6, 0, 4), quaternion: new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), direction), colliders: [new BoxCollider({ size: new Vector3(1.8, 0.7, 4), friction: 0 })], mass: 1000, canSleep: false }),
    );
    box.velocity.copy(direction).multiplyScalar(20);
    let struck = false;
    for (let step = 0; step < 60 && !struck; step++) {
      world.fixedStep();
      struck = world.contacts.length > 0;
    }
    expect(struck).toBe(true);
    expect(Math.abs(box.angularVelocity.x)).toBeLessThan(0.02);
    expect(Math.abs(box.angularVelocity.y)).toBeGreaterThan(1);
  });

  it('brings a stack of three boxes completely to rest', () => {
    const world = new World({ substeps: 8 });
    ground(world);
    const boxes = [0, 1, 2].map((level) => crate(world, new Vector3(0, 0.5 + level * 1.001, 0)));
    runFor(world, 15);
    const top = boxes.at(-1)!;
    // each contact gives about half a millimetre under the boxes above
    expect(Math.abs(top.position.y - 2.5)).toBeLessThan(0.002);
    expect(Math.hypot(top.position.x, top.position.z)).toBeLessThan(1e-3);
    for (const box of boxes) expect(box.velocity.length()).toBeLessThan(1e-4);
  });

  it('lands a tilted box flat on the ground', () => {
    const world = new World({ substeps: 8 });
    ground(world);
    const body = crate(world, new Vector3(0, 2, 0), { quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0.5, 0).normalize(), 0.7) });
    runFor(world, 8);
    expect(body.position.y).toBeCloseTo(0.5, 2);
    // one face down: the up axis is one of the box axes
    const up = new Vector3(0, 1, 0);
    const alignment = Math.max(...[new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((axis) => Math.abs(axis.applyQuaternion(body.quaternion).dot(up))));
    expect(alignment).toBeGreaterThan(0.999);
  });

  it('rests a ball on a box', () => {
    const world = new World({ substeps: 8 });
    ground(world);
    crate(world, new Vector3(0, 0.5, 0));
    const body = ball(world, new Vector3(0.1, 2, 0), { radius: 0.3 });
    runFor(world, 3);
    expect(body.position.y).toBeCloseTo(1.3, 2);
  });

  it('respects collision groups', () => {
    const world = new World({ substeps: 4 });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ collisionGroups: 2 })] }));
    const ghost = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 1, 0), colliders: [new SphereCollider({ radius: 0.5, collidesWith: 1 })] }));
    runFor(world, 2);
    expect(ghost.position.y).toBeLessThan(-5);
  });

  it('reports the contacts that pushed, with an impulse that holds up the weight', () => {
    const world = new World({ substeps: 8 });
    ground(world);
    ball(world, new Vector3(0, 0.5, 0), { canSleep: false });
    runFor(world, 2);
    expect(world.contacts).toHaveLength(1);
    const contact = world.contacts[0]!;
    // m g over the step
    expect(contact.normalImpulse / world.timestep).toBeCloseTo(9.81, 1);
    expect(contact.normal.y).toBeCloseTo(1, 9);
  });

  it('lets a kinematic paddle push a dynamic body without being pushed back', () => {
    const world = new World({ gravity: new Vector3(), substeps: 8 });
    const paddle = world.addBody(new Body({ type: 'kinematic', velocity: new Vector3(1, 0, 0), position: new Vector3(-2, 0, 0), colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
    const puck = ball(world, new Vector3(0, 0, 0));
    runFor(world, 3);
    expect(paddle.position.x).toBeCloseTo(1, 9);
    expect(puck.position.x).toBeGreaterThan(paddle.position.x);
  });
});

describe('colliders from objects', () => {
  it("fits 'box' and 'sphere' around the mesh, centred on it", () => {
    const world = new World();
    const boxBody = world.addBody(new Mesh(new BoxGeometry(1, 2, 3).translate(0, 1, 0)), { collider: 'box' });
    const box = boxBody.colliders[0] as BoxCollider;
    expect(box).toBeInstanceOf(BoxCollider);
    expect(box.halfExtents.distanceTo(new Vector3(0.5, 1, 1.5))).toBeLessThan(1e-9);
    expect(box.offset.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    const sphereBody = world.addBody(new Mesh(new SphereGeometry(0.7, 32, 16)), { collider: 'sphere' });
    expect((sphereBody.colliders[0] as SphereCollider).radius).toBeCloseTo(0.7, 6);
  });

  it('takes collider instances, and gets the mass properties from them when there are no meshes', () => {
    const sphere = new SphereCollider({ radius: 1 });
    const body = new World().addBody(new Object3D(), { collider: sphere, mass: 2 });
    expect(body.colliders).toEqual([sphere]);
    expect(body.massProperties!.inertia.elements[0]).toBeCloseTo(0.8, 12);
    const fromDensity = new World().addBody(new Object3D(), { collider: [new BoxCollider({ size: new Vector3(1, 2, 3) })] });
    expect(fromDensity.mass).toBeCloseTo(6000, 9);
  });

  it('makes static ground from a collider alone', () => {
    const floor = new World().addBody(new Object3D(), { type: 'static', collider: new PlaneCollider() });
    expect(floor.colliders[0]).toBeInstanceOf(PlaneCollider);
  });

  it('refuses shapes it cannot fit or weigh', () => {
    expect(() => new World().addBody(new Object3D(), { collider: 'box' })).toThrow(/has none/);
    expect(() => new World().addBody(new Object3D(), { collider: new PlaneCollider() })).toThrow(/solid colliders/);
  });

  it('adds and removes colliders on a body', () => {
    const body = new Body({ type: 'static' });
    const plane = body.addCollider(new PlaneCollider());
    body.addCollider(plane);
    expect(body.colliders).toHaveLength(1);
    body.removeCollider(plane);
    expect(body.colliders).toHaveLength(0);
  });

  it('validates collider sizes', () => {
    expect(() => new SphereCollider({ radius: 0 })).toThrow(RangeError);
    expect(() => new BoxCollider({ size: new Vector3(1, 0, 1) })).toThrow(RangeError);
  });
});
