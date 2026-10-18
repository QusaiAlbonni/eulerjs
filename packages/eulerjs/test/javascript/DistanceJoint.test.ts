import { Quaternion, Vector3 } from 'three';
import { correctPosition } from '../../src/javascript/positional.js';
import { SolverBody } from '../../src/javascript/SolverBody.js';
import { describe, expect, it } from 'vitest';
import { Body, DistanceJoint, EulerError, MassProperties, World } from 'eulerjs';
import { expectVectorClose } from '../helpers.js';

// These tests are about the joints, so their bodies stay awake however still they get.
const ball = (position: Vector3, options: { velocity?: Vector3; linearDamping?: number } = {}) =>
  new Body({ massProperties: MassProperties.sphere(0.05, 1), position, canSleep: false, ...options });

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

function pendulum(length: number, startAngle: number) {
  const world = new World({ substeps: 8 });
  const bob = world.addBody(ball(new Vector3(length * Math.sin(startAngle), -length * Math.cos(startAngle), 0)));
  const joint = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3(0, 0, 0) }));
  return { world, bob, joint };
}

describe('DistanceJoint as a rigid rod', () => {
  it('swings with the period of a simple pendulum', () => {
    const length = 2;
    const startAngle = 0.1;
    const { world, bob } = pendulum(length, startAngle);
    const crossings: number[] = [];
    let previousX = bob.position.x;
    runFor(world, 12, () => {
      if (previousX > 0 && bob.position.x <= 0) crossings.push(world.time);
      previousX = bob.position.x;
    });
    const measuredPeriod = (crossings.at(-1)! - crossings[0]!) / (crossings.length - 1);
    // small-angle period with its first amplitude correction
    const expectedPeriod = 2 * Math.PI * Math.sqrt(length / 9.81) * (1 + startAngle ** 2 / 16);
    expect(Math.abs(measuredPeriod / expectedPeriod - 1)).toBeLessThan(0.005);
  });

  it('keeps its length', () => {
    const { world, bob } = pendulum(2, 1.2);
    let worstError = 0;
    runFor(world, 10, () => {
      worstError = Math.max(worstError, Math.abs(bob.position.length() - 2));
    });
    expect(worstError).toBeLessThan(2e-3);
  });

  it('loses energy only in proportion to the substep length, as position-based solvers do', () => {
    const energyLost = (substeps: number) => {
      const world = new World({ substeps });
      const bob = world.addBody(ball(new Vector3(2 * Math.sin(1), -2 * Math.cos(1), 0)));
      world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3() }));
      // energy measured from the lowest point, so it is positive
      const energy = () => 0.5 * bob.velocity.lengthSq() + 9.81 * (bob.position.y + 2);
      const energyBefore = energy();
      runFor(world, 20);
      return 1 - energy() / energyBefore;
    };
    const coarse = energyLost(8);
    const fine = energyLost(16);
    expect(fine).toBeGreaterThan(0);
    expect(fine / coarse).toBeGreaterThan(0.4);
    expect(fine / coarse).toBeLessThan(0.6);
  });

  it('carries the weight of what hangs from it', () => {
    const world = new World({ substeps: 8 });
    const bob = world.addBody(ball(new Vector3(0, -1, 0)));
    const joint = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3() }));
    runFor(world, 1);
    expect(joint.tension).toBeCloseTo(9.81, 6);
  });

  it('turns a body hung by a corner until its centre of mass is under the anchor', () => {
    const world = new World({ substeps: 8 });
    const block = world.addBody(
      new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 5), position: new Vector3(0, -1.5, 0), linearDamping: 1, angularDamping: 1 }),
    );
    world.addJoint(new DistanceJoint({ bodyA: block, anchorA: new Vector3(0.5, 0.5, 0.5), anchorB: new Vector3(0, 0, 0), length: 1 }));
    runFor(world, 60);
    expect(Math.hypot(block.worldCenterOfMass.x, block.worldCenterOfMass.z)).toBeLessThan(1e-3);
    // the corner, then the diagonal half-length, straight down
    expect(block.worldCenterOfMass.y).toBeCloseTo(-1 - Math.sqrt(3) / 2, 2);
  });
});

describe('DistanceJoint between two free bodies', () => {
  it('conserves linear momentum exactly and keeps the distance while they tumble', () => {
    const world = new World({ gravity: new Vector3(), substeps: 8 });
    const first = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 2, 3), 2), velocity: new Vector3(0, 1, 0), angularVelocity: new Vector3(1, 2, 0.5) }));
    const second = world.addBody(new Body({ massProperties: MassProperties.sphere(0.3, 3), position: new Vector3(3, 0, 0), velocity: new Vector3(0, -1, 0.5) }));
    world.addJoint(new DistanceJoint({ bodyA: first, anchorA: new Vector3(0.5, 1, 0), bodyB: second }));
    const momentum = () => first.velocity.clone().multiplyScalar(2).addScaledVector(second.velocity, 3);
    const momentumBefore = momentum();
    let worstStretch = 0;
    runFor(world, 10, () => {
      const distance = first.pointToWorld(new Vector3(0.5, 1, 0)).distanceTo(second.position);
      worstStretch = Math.max(worstStretch, Math.abs(distance - Math.sqrt(2.5 ** 2 + 1)));
    });
    expectVectorClose(momentum(), momentumBefore, 1e-9);
    expect(worstStretch).toBeLessThan(5e-3);
  });

  it('lets a kinematic body drag a dynamic one without being moved itself', () => {
    const world = new World({ gravity: new Vector3(), substeps: 4 });
    const tug = world.addBody(new Body({ type: 'kinematic', velocity: new Vector3(1, 0, 0) }));
    const barge = world.addBody(ball(new Vector3(-2, 0, 0)));
    world.addJoint(new DistanceJoint({ bodyA: barge, bodyB: tug }));
    runFor(world, 3);
    expectVectorClose(tug.position, new Vector3(3, 0, 0), 1e-9);
    expect(tug.position.distanceTo(barge.position)).toBeCloseTo(2, 3);
  });
});

describe('DistanceJoint options', () => {
  it('stretches like a spring of stiffness 1 / compliance', () => {
    const world = new World({ substeps: 8 });
    const bob = world.addBody(ball(new Vector3(0, -1, 0)));
    world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3(), length: 1, compliance: 0.01, damping: 5 }));
    runFor(world, 10);
    // m g / k = 1 · 9.81 · 0.01
    expect(-bob.position.y - 1).toBeCloseTo(0.0981, 3);
  });

  it('as a rope, lets the body fall freely until it is taut', () => {
    const world = new World({ substeps: 4 });
    const bob = world.addBody(ball(new Vector3(0, -0.5, 0)));
    const rope = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3(), length: 2, slack: true }));
    runFor(world, 0.2);
    expect(rope.tension).toBe(0);
    expect(bob.velocity.y).toBeCloseTo(-9.81 * 0.2, 6);
    runFor(world, 3);
    expect(bob.position.length()).toBeCloseTo(2, 2);
  });

  it('defaults its length to the distance between the anchors when made', () => {
    const joint = new DistanceJoint({ bodyA: ball(new Vector3(3, 4, 0)), anchorB: new Vector3() });
    expect(joint.length).toBeCloseTo(5, 12);
  });

  it('does nothing when both ends are immovable', () => {
    const ground = new SolverBody(new Body({ type: 'static' }));
    const wall = new SolverBody(new Body({ type: 'static', position: new Vector3(1, 0, 0) }));
    const moved = correctPosition({ bodyA: ground, pointA: new Vector3(), bodyB: wall, pointB: new Vector3(1, 0, 0), direction: new Vector3(-1, 0, 0), error: 1 }, 0.01);
    expect(moved).toBe(0);
  });
});

describe('World with constraints', () => {
  it('integrates unconstrained bodies in substeps', () => {
    const world = new World({ timestep: 1 / 120, substeps: 4 });
    const falling = world.addBody(ball(new Vector3()));
    const tied = world.addBody(ball(new Vector3(5, -1, 0)));
    world.addJoint(new DistanceJoint({ bodyA: tied, anchorB: new Vector3(5, 0, 0) }));
    runFor(world, 1);
    // semi-implicit Euler with h = dt / 4, over n = 480 substeps: y = -g h² n (n + 1) / 2
    const substep = 1 / 480;
    expect(falling.position.y).toBeCloseTo((-9.81 * substep ** 2 * 480 * 481) / 2, 9);
  });

  it('adds a constraint once and goes back to whole steps once the last one is removed', () => {
    const world = new World({ timestep: 1 / 120 });
    const joint = new DistanceJoint({ bodyA: world.addBody(ball(new Vector3(0, -1, 0))), anchorB: new Vector3() });
    world.addJoint(joint);
    world.addJoint(joint);
    expect(world.joints).toHaveLength(1);
    world.removeJoint(joint);
    world.removeJoint(joint);
    expect(world.joints).toHaveLength(0);
    const falling = world.addBody(ball(new Vector3(9, 0, 0)));
    world.fixedStep();
    expect(falling.position.y).toBeCloseTo(-9.81 / 120 ** 2, 12);
  });

  it('rejects a substep count that is not a positive whole number', () => {
    expect(() => new World({ substeps: 0 })).toThrow(EulerError);
    expect(() => new World({ substeps: 2.5 })).toThrow(EulerError);
  });

  it('keeps rotation-only motion of a jointed body sensible', () => {
    const world = new World({ gravity: new Vector3(), substeps: 4 });
    const wheel = world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1), angularVelocity: new Vector3(0, 2, 0) }));
    world.addJoint(new DistanceJoint({ bodyA: wheel, anchorB: new Vector3() }));
    runFor(world, 1);
    expectVectorClose(wheel.angularVelocity, new Vector3(0, 2, 0), 1e-6);
    expect(wheel.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2))).toBeLessThan(1e-6);
  });
});
