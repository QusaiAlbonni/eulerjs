import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, DistanceJoint, MassProperties, PlaneCollider, SphereCollider, World } from '@eulerjs/core';

/**
 * Integration, contacts, friction, joints, kinematic bodies and sleeping working on the same
 * bodies at once, each checked against the textbook answer for the combination.
 */

const gravity = 9.81;
const unitBox = new Vector3(1, 1, 1);

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

function ground(world: World, options: { friction?: number; tilt?: Quaternion } = {}): Body {
  return world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: options.friction, rotation: options.tilt })] }));
}

interface BallOptions {
  radius?: number;
  mass?: number;
  friction?: number;
  velocity?: Vector3;
  canSleep?: boolean;
  damping?: number;
}

function ball(world: World, position: Vector3, options: BallOptions = {}): Body {
  const radius = options.radius ?? 0.5;
  return world.addBody(
    new Body({
      massProperties: MassProperties.sphere(radius, options.mass ?? 1),
      position,
      velocity: options.velocity,
      canSleep: options.canSleep ?? false,
      linearDamping: options.damping,
      angularDamping: options.damping,
      colliders: [new SphereCollider({ radius, friction: options.friction })],
    }),
  );
}

function crate(world: World, position: Vector3, options: { mass?: number; friction?: number; quaternion?: Quaternion; canSleep?: boolean } = {}): Body {
  return world.addBody(
    new Body({
      massProperties: MassProperties.box(unitBox, options.mass ?? 10),
      position,
      quaternion: options.quaternion,
      canSleep: options.canSleep ?? false,
      colliders: [new BoxCollider({ size: unitBox, friction: options.friction })],
    }),
  );
}

const relativeError = (measured: number, expected: number) => Math.abs(measured / expected - 1);
const totalContactForce = (world: World, filter: (normal: Vector3) => boolean = () => true) =>
  world.contacts.filter((contact) => filter(contact.normal)).reduce((sum, contact) => sum + contact.normalImpulse, 0) / world.timestep;

describe('rotation and friction together', () => {
  it('turns a sliding ball into a rolling one at 5/7 of its speed, without it sinking into the ground', () => {
    const world = new World();
    ground(world, { friction: 0.3 });
    const body = ball(world, new Vector3(0, 0.5, 0), { velocity: new Vector3(5, 0, 0), friction: 0.3 });
    let lowest = Infinity;
    runFor(world, 3, () => {
      lowest = Math.min(lowest, body.position.y);
    });
    expect(relativeError(body.velocity.x, (5 * 5) / 7)).toBeLessThan(0.01);
    // rolling without slipping: the bottom of the ball is still
    expect(body.velocity.x + body.angularVelocity.z * 0.5).toBeCloseTo(0, 3);
    expect(0.5 - lowest).toBeLessThan(0.0005);
  });

  it('rolls a ball down a slope at 5/7 g sin θ', () => {
    const world = new World();
    const tilt = 0.3;
    ground(world, { friction: 0.8, tilt: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt) });
    const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
    const downhill = new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
    const body = ball(world, up.clone().multiplyScalar(0.5), { friction: 0.8 });
    runFor(world, 0.5);
    const speedBefore = body.velocity.dot(downhill);
    runFor(world, 1);
    expect(relativeError(body.velocity.dot(downhill) - speedBefore, (5 / 7) * gravity * Math.sin(tilt))).toBeLessThan(0.005);
    expect(body.velocity.length() - body.angularVelocity.length() * 0.5).toBeCloseTo(0, 3);
  });

  it.each([0, 30, 90])('holds a box turned %s° on a slope gentler than its friction angle, without creeping or turning', (yawDegrees) => {
    const world = new World();
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    ground(world, { friction: 0.6, tilt });
    const orientation = tilt.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDegrees * Math.PI) / 180));
    const body = crate(world, new Vector3(0, 0.5, 0).applyQuaternion(tilt), { friction: 0.6, quaternion: orientation });
    runFor(world, 1);
    const settledAt = body.position.clone();
    const settledOrientation = body.quaternion.clone();
    runFor(world, 3);
    expect(body.position.distanceTo(settledAt)).toBeLessThan(0.0005);
    expect(body.quaternion.angleTo(settledOrientation)).toBeLessThan(0.0005);
  });
});

describe('forces and contacts together', () => {
  it('accelerates a pushed box at (F - μ m g) / m', () => {
    const world = new World();
    ground(world, { friction: 0.4 });
    const body = crate(world, new Vector3(0, 0.5, 0), { friction: 0.4 });
    runFor(world, 0.2);
    runFor(world, 2, () => body.applyForce(new Vector3(80, 0, 0)));
    expect(relativeError(body.velocity.x / 2, (80 - 0.4 * 10 * gravity) / 10)).toBeLessThan(0.002);
  });

  it('presses a pushed box against a wall with the force pushing it, without going into the wall', () => {
    const world = new World();
    ground(world, { friction: 0.4 });
    const facingLeft = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ rotation: facingLeft, offset: new Vector3(1, 0, 0) })] }));
    // frictionless, so that the wall's push has one right answer: with friction on the floor and
    // the wall, any share of the load may circle through the two frictions, and a solver that
    // keeps its impulses from step to step may keep such a share
    const body = crate(world, new Vector3(0.45, 0.5, 0), { friction: 0 });
    runFor(world, 2, () => body.applyForce(new Vector3(300, 0, 0)));
    expect(relativeError(totalContactForce(world, (normal) => Math.abs(normal.x) > 0.9), 300)).toBeLessThan(0.002);
    // the wall gives a fraction of a millimetre under 300 N
    expect(Math.abs(body.position.x - 0.5)).toBeLessThan(5e-4);
  });

  it('holds up a box on an accelerating lift with a force of m (g + a)', () => {
    const world = new World();
    const lift = world.addBody(new Body({ type: 'kinematic', position: new Vector3(0, -0.1, 0), colliders: [new BoxCollider({ size: new Vector3(4, 0.2, 4) })] }));
    const body = crate(world, new Vector3(0, 0.5, 0));
    runFor(world, 1);
    const acceleration = 2;
    runFor(world, 1, () => {
      lift.velocity.y += acceleration * world.timestep;
    });
    let force = 0;
    let samples = 0;
    runFor(world, 0.5, () => {
      lift.velocity.y += acceleration * world.timestep;
      if (samples++ > 0) force += totalContactForce(world);
    });
    expect(relativeError(force / (samples - 1), 10 * (gravity + acceleration))).toBeLessThan(0.002);
    // the contact gives a tenth of a millimetre under the box
    expect(Math.abs(body.position.y - lift.position.y - 0.6)).toBeLessThan(2e-4);
  });

  it('carries a box on a tilted platform moving sideways, held by static friction alone', () => {
    const world = new World();
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    const platform = world.addBody(
      new Body({ type: 'kinematic', quaternion: tilt, position: new Vector3(0, -0.1, 0), colliders: [new BoxCollider({ size: new Vector3(20, 0.2, 20), friction: 0.6 })] }),
    );
    const body = crate(world, new Vector3(0, 0.5, 0).applyQuaternion(tilt), { friction: 0.6, quaternion: tilt });
    runFor(world, 1);
    const offset = body.position.clone().sub(platform.position);
    platform.velocity.set(0, 0, 2);
    body.velocity.set(0, 0, 2);
    runFor(world, 3);
    expect(body.position.clone().sub(platform.position).distanceTo(offset)).toBeLessThan(0.001);
  });
});

describe('joints and contacts together', () => {
  it('tows a box across the floor on a rope with a tension of μ m g', () => {
    const world = new World();
    ground(world, { friction: 0.5 });
    const body = crate(world, new Vector3(0, 0.5, 0), { friction: 0.5 });
    const tug = world.addBody(new Body({ type: 'kinematic', position: new Vector3(3, 0.5, 0), velocity: new Vector3(1, 0, 0) }));
    const rope = world.addJoint(new DistanceJoint({ bodyA: body, bodyB: tug, length: 3, slack: true }));
    let tension = 0;
    let samples = 0;
    runFor(world, 4, () => {
      if (world.time < 2) return;
      tension += rope.tension;
      samples++;
    });
    expect(relativeError(tension / samples, 0.5 * 10 * gravity)).toBeLessThan(0.002);
    expect(body.velocity.x).toBeCloseTo(1, 1);
  });

  it('knocks a sleeping box off with a pendulum, which keeps its length and stays out of the box', () => {
    const world = new World();
    ground(world, { friction: 0.5 });
    const box = crate(world, new Vector3(0, 0.5, 0), { mass: 2, canSleep: true });
    runFor(world, 2);
    expect(box.isSleeping).toBe(true);
    const length = 3;
    const bob = ball(world, new Vector3(-length, 3.5, 0), { radius: 0.3, mass: 5 });
    const string = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3(0, 3.5, 0) }));
    let worstStretch = 0;
    let deepest = 0;
    runFor(world, 6, () => {
      worstStretch = Math.max(worstStretch, Math.abs(string.currentAnchors().distance - length));
      for (const contact of world.contacts) deepest = Math.max(deepest, contact.depth);
    });
    // a 5 kg bob arriving at √(2 g L) shoves the 2 kg box along the floor
    expect(box.position.x).toBeGreaterThan(2);
    expect(box.position.y).toBeCloseTo(0.5, 3);
    // the string gives under the swing's pull and the blow: under a millimetre
    expect(worstStretch).toBeLessThan(1e-3);
    expect(deepest).toBeLessThan(0.005);
  });

  it('drapes a chain over a box without it passing into the box or the floor', () => {
    const world = new World();
    ground(world, { friction: 0.5 });
    world.addBody(new Body({ type: 'static', position: new Vector3(0, 0.5, 0), colliders: [new BoxCollider({ size: unitBox })] }));
    const boxCorner = new Vector3(-0.5, 0, -0.5);
    const oppositeBoxCorner = new Vector3(0.5, 1, 0.5);
    const radius = 0.12;
    const linkLength = 0.4;
    const links: Body[] = [];
    for (let index = 0; index < 12; index++) {
      links.push(ball(world, new Vector3(-2.2 + index * linkLength, 2, 0), { radius, mass: 0.2 }));
      if (index > 0) world.addJoint(new DistanceJoint({ bodyA: links[index]!, bodyB: links[index - 1]!, length: linkLength }));
    }
    let worstStretch = 0;
    let deepestInBox = 0;
    let deepestInFloor = 0;
    runFor(world, 6, () => {
      for (const joint of world.joints as DistanceJoint[]) worstStretch = Math.max(worstStretch, Math.abs(joint.currentAnchors().distance - linkLength));
      for (const link of links) {
        deepestInFloor = Math.max(deepestInFloor, radius - link.position.y);
        const nearestOnBox = link.position.clone().clamp(boxCorner, oppositeBoxCorner);
        deepestInBox = Math.max(deepestInBox, radius - link.position.distanceTo(nearestOnBox));
      }
    });
    // the links whip down onto the box at nearly 8 m/s, which stretches the chain for a moment:
    // about 1.5 cm at the default 4 substeps, under 5 mm at 8
    expect(worstStretch).toBeLessThan(0.02);
    expect(deepestInBox).toBeLessThan(0.002);
    expect(deepestInFloor).toBeLessThan(0.001);
    // draped over the box: links on both sides, hanging down to the floor
    expect(links.some((link) => link.position.x < -0.5) && links.some((link) => link.position.x > 0.5)).toBe(true);
    expect(links.some((link) => link.position.y > 1)).toBe(true);
  });
});

describe('collisions between free bodies', () => {
  it('conserves momentum and angular momentum when a ball hits the end of a floating rod', () => {
    const world = new World({ gravity: new Vector3() });
    const rodSize = new Vector3(0.2, 4, 0.2);
    const rod = world.addBody(new Body({ massProperties: MassProperties.box(rodSize, 3), canSleep: false, colliders: [new BoxCollider({ size: rodSize })] }));
    const bullet = ball(world, new Vector3(-3, 1.5, 0), { radius: 0.1, mass: 1, velocity: new Vector3(4, 0, 0) });
    const momentum = () => rod.velocity.clone().multiplyScalar(rod.mass).addScaledVector(bullet.velocity, bullet.mass);
    const angularMomentum = () => {
      const total = new Vector3();
      for (const body of [rod, bullet]) {
        const inverse = body.quaternion.clone().invert();
        total.add(body.angularVelocity.clone().applyQuaternion(inverse).applyMatrix3(body.massProperties!.inertia).applyQuaternion(body.quaternion));
        total.add(body.worldCenterOfMass.clone().cross(body.velocity.clone().multiplyScalar(body.mass)));
      }
      return total;
    };
    const momentumBefore = momentum();
    const angularMomentumBefore = angularMomentum();
    runFor(world, 2);
    expect(rod.angularVelocity.length()).toBeGreaterThan(0.5);
    expect(momentum().distanceTo(momentumBefore)).toBeLessThan(1e-9);
    expect(angularMomentum().distanceTo(angularMomentumBefore) / angularMomentumBefore.length()).toBeLessThan(1e-3);
  });

  it('knocks over a sleeping stack with a thrown ball, after which everything comes to rest on the floor', () => {
    const world = new World();
    ground(world, { friction: 0.5 });
    const boxes = [0, 1, 2, 3].map((level) => crate(world, new Vector3(0, 0.5 + level * 1.001, 0), { mass: 2, canSleep: true }));
    runFor(world, 2);
    expect(boxes.every((box) => box.isSleeping)).toBe(true);
    // a rigid ball would roll on for ever and keep waking what it passes; this one slows down
    ball(world, new Vector3(-4, 3, 0), { velocity: new Vector3(10, 2, 0), mass: 5, canSleep: true, damping: 0.5 });
    runFor(world, 12);
    expect(world.bodies.every((body) => body.type === 'static' || body.isSleeping)).toBe(true);
    // each box lies on the floor or on another box, square
    for (const box of boxes) {
      const levelsUp = box.position.y - 0.5;
      expect(Math.abs(levelsUp - Math.round(levelsUp))).toBeLessThan(0.01);
    }
    expect(boxes.some((box) => box.position.y < 1)).toBe(true);
  });

  it.each([4, 8])('stands an eight-box stack still that may not sleep, at %i substeps', (substeps) => {
    const world = new World({ substeps });
    ground(world);
    const boxes = Array.from({ length: 8 }, (_unused, level) => crate(world, new Vector3(0, 0.5 + level * 1.001, 0), { canSleep: false }));
    // it sways a centimetre or so as it settles, then stands
    runFor(world, 8);
    const top = boxes.at(-1)!;
    const settledAt = top.position.clone();
    expect(Math.hypot(settledAt.x, settledAt.z)).toBeLessThan(0.02);
    runFor(world, 20);
    expect(top.position.distanceTo(settledAt)).toBeLessThan(5e-4);
  });
});
