import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, DistanceJoint, JavaScriptBackend, MassProperties, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import type { JavaScriptBackendOptions } from '@eulerjs/core';

/**
 * How good the simulation is at the default settings (60 steps a second, 4 substeps), measured
 * against the physics, each with a limit a little above what it is today, for both of the
 * JavaScript backend's solvers. A new feature that makes any of these worse fails here, so the
 * default stays good enough to keep as the default. Raise a limit only on purpose, with the
 * reason next to it.
 */

const gravity = 9.81;
/** The solver the measurements below run with. */
let solver: JavaScriptBackendOptions['solver'] = 'xpbd';
const makeWorld = () => new World({ backend: new JavaScriptBackend({ solver }) });
const unitBox = new Vector3(1, 1, 1);

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

function ground(world: World, options: { friction?: number; tilt?: number } = {}): Body {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), options.tilt ?? 0);
  return world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: options.friction, rotation })] }));
}

function crate(world: World, position: Vector3, options: { friction?: number; quaternion?: Quaternion; canSleep?: boolean } = {}): Body {
  return world.addBody(
    new Body({ massProperties: MassProperties.box(unitBox, 10), position, quaternion: options.quaternion, canSleep: options.canSleep ?? false, colliders: [new BoxCollider({ size: unitBox, friction: options.friction })] }),
  );
}

/**
 * How far the top of a stack of `height` boxes that may not sleep wanders from where it was put,
 * at most over a minute, in metres: long enough to see a stack that stands for a while and then
 * gives way.
 */
function stackDrift(height: number): number {
  const world = makeWorld();
  ground(world);
  const boxes = Array.from({ length: height }, (_unused, level) => crate(world, new Vector3(0, 0.5 + level * 1.001, 0)));
  const top = boxes.at(-1)!;
  let furthest = 0;
  runFor(world, 60, () => (furthest = Math.max(furthest, Math.hypot(top.position.x, top.position.z))));
  return furthest;
}

/** How far short of e² of its drop height a ball bounces, as a share of it. */
function bounceError(): number {
  const world = makeWorld();
  ground(world);
  const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 3.5, 0), colliders: [new SphereCollider({ radius: 0.5, restitution: 0.5 })] }));
  let fallen = false;
  let peak = 0;
  runFor(world, 3, () => {
    if (body.velocity.y < -1) fallen = true;
    if (fallen && body.velocity.y > 0) peak = Math.max(peak, body.position.y - 0.5);
  });
  return Math.abs(peak / (3 * 0.25) - 1);
}

/** How far a block sliding down a slope is from g (sin θ - μ cos θ), as a share of it. */
function slideError(): number {
  const world = makeWorld();
  const tilt = 0.5;
  const friction = 0.3;
  const slope = ground(world, { tilt, friction });
  const downhill = new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
  const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
  const block = crate(world, up.multiplyScalar(0.5), { quaternion: slope.colliders[0]!.rotation, friction });
  runFor(world, 0.5);
  const speedBefore = block.velocity.dot(downhill);
  runFor(world, 1);
  return Math.abs((block.velocity.dot(downhill) - speedBefore) / (gravity * (Math.sin(tilt) - friction * Math.cos(tilt))) - 1);
}

/** How far a box on a gentle slope creeps in 3 s, in metres. */
function slopeCreep(): number {
  const world = makeWorld();
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
  ground(world, { friction: 0.6, tilt: 0.3 });
  const body = crate(world, new Vector3(0, 0.5, 0).applyQuaternion(tilt), { friction: 0.6, quaternion: tilt });
  runFor(world, 1);
  const settled = body.position.clone();
  runFor(world, 3);
  return body.position.distanceTo(settled);
}

/** How far a rolling ball's slowing is from c g / (1 + I / m r²), as a share of it. */
function rollingResistanceError(): number {
  const world = makeWorld();
  ground(world, { friction: 0.8 });
  const coefficient = 0.05;
  const ball = world.addBody(
    new Body({
      massProperties: MassProperties.sphere(0.5, 1),
      position: new Vector3(0, 0.5, 0),
      velocity: new Vector3(3, 0, 0),
      angularVelocity: new Vector3(0, 0, -6),
      canSleep: false,
      colliders: [new SphereCollider({ radius: 0.5, friction: 0.8, rollingResistance: coefficient })],
    }),
  );
  runFor(world, 0.5);
  const speedBefore = ball.velocity.x;
  runFor(world, 1);
  return Math.abs((speedBefore - ball.velocity.x) / ((coefficient * gravity) / 1.4) - 1);
}

/** A rigid pendulum's period against the simple pendulum's, and the share of its energy lost per swing. */
function pendulum(): { periodError: number; energyLostPerSwing: number } {
  const world = makeWorld();
  const length = 2;
  const startAngle = 0.3;
  const bob = world.addBody(new Body({ massProperties: MassProperties.sphere(0.05, 1), position: new Vector3(length * Math.sin(startAngle), -length * Math.cos(startAngle), 0), canSleep: false }));
  world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3() }));
  const energy = () => 0.5 * bob.velocity.lengthSq() + gravity * (bob.position.y + length);
  const startEnergy = energy();
  const crossings: number[] = [];
  let previousX = bob.position.x;
  runFor(world, 20, () => {
    if (previousX > 0 && bob.position.x <= 0) crossings.push(world.time);
    previousX = bob.position.x;
  });
  const period = (crossings.at(-1)! - crossings[0]!) / (crossings.length - 1);
  // small-angle period with its first amplitude correction
  const expected = 2 * Math.PI * Math.sqrt(length / gravity) * (1 + startAngle ** 2 / 16);
  const swings = 20 / period;
  return { periodError: Math.abs(period / expected - 1), energyLostPerSwing: 1 - (energy() / startEnergy) ** (1 / swings) };
}

/** The most a hanging chain of ten links stretches, in metres. */
function chainStretch(): number {
  const world = makeWorld();
  const linkLength = 0.3;
  const links: Body[] = [];
  for (let index = 0; index < 10; index++) {
    links.push(world.addBody(new Body({ massProperties: MassProperties.sphere(0.05, 1), position: new Vector3(0, -index * linkLength - linkLength, 0), canSleep: false })));
    const above = links[index - 1];
    world.addJoint(above ? new DistanceJoint({ bodyA: links[index]!, bodyB: above, length: linkLength }) : new DistanceJoint({ bodyA: links[index]!, anchorB: new Vector3(), length: linkLength }));
  }
  runFor(world, 2);
  return links.at(-1)!.position.length() - 10 * linkLength;
}

/** How long a box dropped from 1 m takes to fall asleep, in seconds. */
function timeToSettle(): number {
  const world = makeWorld();
  ground(world);
  const body = crate(world, new Vector3(0, 1.5, 0), { canSleep: true });
  let asleepAt = Infinity;
  runFor(world, 5, () => {
    if (asleepAt === Infinity && body.isSleeping) asleepAt = world.time;
  });
  return asleepAt;
}

/** How far the force on a box resting on the floor is from its weight, as a share of it. */
function contactForceError(): number {
  const world = makeWorld();
  ground(world);
  crate(world, new Vector3(0, 0.5, 0));
  runFor(world, 1);
  const force = world.contacts.reduce((sum, contact) => sum + contact.normalImpulse, 0) / world.timestep;
  return Math.abs(force / (10 * gravity) - 1);
}

/** Every measurement, labelled, for the solver in `solver`. */
function measure(): Record<string, number> {
  const { periodError, energyLostPerSwing } = pendulum();
  return {
    'top of a 3-box stack, drift in 60 s (m)': stackDrift(3),
    'top of an 8-box stack, drift in 60 s (m)': stackDrift(8),
    'bounce height error': bounceError(),
    'sliding acceleration error': slideError(),
    'box on a 17° slope, creep in 3 s (m)': slopeCreep(),
    'rolling resistance slowing error': rollingResistanceError(),
    'pendulum period error': periodError,
    'pendulum energy lost per swing': energyLostPerSwing,
    'hanging chain of 10 links, stretch (m)': chainStretch(),
    'dropped box, time to fall asleep (s)': timeToSettle(),
    'resting box, contact force error': contactForceError(),
  };
}

function expectWithin(measured: Record<string, number>, limits: Record<string, number>): void {
  expect(Object.keys(limits).sort()).toEqual(Object.keys(measured).sort());
  for (const [label, limit] of Object.entries(limits)) expect(measured[label], label).toBeLessThan(limit);
}

describe('quality at the default settings', () => {
  // limits are today's values (in the comment, with 8 substeps' for comparison) plus a margin
  it('stays within its limits with XPBD, the other solver', () => {
    solver = 'xpbd';
    expectWithin(measure(), {
      // 1.1 mm (8 substeps: 0.2 mm)
      'top of a 3-box stack, drift in 60 s (m)': 0.002,
      // 451 mm (8 substeps: 11 mm): it stands about 10 s, then gives way; stacks that may sleep fall asleep first
      'top of an 8-box stack, drift in 60 s (m)': 0.6,
      // 0.8% (the same at 8)
      'bounce height error': 0.012,
      // about a millionth
      'sliding acceleration error': 0.005,
      // 0.07 mm (8 substeps: 0.04 mm)
      'box on a 17° slope, creep in 3 s (m)': 0.0005,
      // 1.0% (8 substeps: 0.5%)
      'rolling resistance slowing error': 0.015,
      // 0.1% (8 substeps: 0.007%)
      'pendulum period error': 0.002,
      // 5.9% (8 substeps: 3.0%): the energy loss of a position-based solver, halving with each doubling of substeps
      'pendulum energy lost per swing': 0.07,
      // 7.6 mm (8 substeps: 1.9 mm)
      'hanging chain of 10 links, stretch (m)': 0.01,
      // 1.0 s (the same at 8)
      'dropped box, time to fall asleep (s)': 1.5,
      // to rounding
      'resting box, contact force error': 0.001,
    });
  });

  it('stays within its limits with soft step, the default', () => {
    solver = 'soft-step';
    expectWithin(measure(), {
      // 0.75 mm (8 substeps: 0.7 mm), all while it settles: carried-over impulses then hold it still
      'top of a 3-box stack, drift in 60 s (m)': 0.0012,
      // 12 mm (8 substeps: 13 mm), in its first few seconds, after which it stands still
      'top of an 8-box stack, drift in 60 s (m)': 0.018,
      // 1.8% (8 substeps: 1.3%): the bounce is applied at the end of the step it lands in
      'bounce height error': 0.025,
      // a billionth
      'sliding acceleration error': 0.0001,
      // a nanometre
      'box on a 17° slope, creep in 3 s (m)': 0.00001,
      // a hundred-millionth
      'rolling resistance slowing error': 0.0001,
      // 0.007% (the same at 8)
      'pendulum period error': 0.0002,
      // 0.02% (8 substeps: 0.007%)
      'pendulum energy lost per swing': 0.0005,
      // 6.9 mm (8 substeps: 1.7 mm): joints are springs as stiff as the substeps allow
      'hanging chain of 10 links, stretch (m)': 0.009,
      // 1.0 s (8 substeps: 1.0 s)
      'dropped box, time to fall asleep (s)': 1.5,
      // to rounding
      'resting box, contact force error': 0.001,
    });
  });
});
