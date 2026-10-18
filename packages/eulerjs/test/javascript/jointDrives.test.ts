import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, ConeTwistJoint, HingeJoint, JavaScriptBackend, MassProperties, SliderJoint, TargetJoint, World } from 'eulerjs';
import type { JavaScriptBackendOptions } from 'eulerjs';

const gravity = 9.81;
const xAxis = new Vector3(1, 0, 0);
const yAxis = new Vector3(0, 1, 0);
const zAxis = new Vector3(0, 0, 1);

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('joint drives and friction (%s)', (solver) => {
  const makeWorld = (withGravity = true) => new World({ gravity: new Vector3(0, withGravity ? -gravity : 0, 0), backend: new JavaScriptBackend({ solver }) });
  const runFor = (world: World, seconds: number, eachStep?: () => void) => {
    for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
      eachStep?.();
      world.fixedStep();
    }
  };
  /** A box of `mass`, `size` across, at `center`. */
  const box = (world: World, center: Vector3, mass: number, size = new Vector3(1, 0.1, 0.1)) =>
    world.addBody(new Body({ massProperties: MassProperties.box(size, mass), position: center, canSleep: false, colliders: [new BoxCollider({ size })] }));
  /** The angle between two orientations, in radians. */
  const angleBetween = (first: Quaternion, second: Quaternion) => first.angleTo(second);

  describe('drives set by frequency', () => {
    it('spring at the frequency asked for, whatever the mass', () => {
      for (const mass of [1, 50]) {
        const world = makeWorld(false);
        const slider = box(world, new Vector3(), mass);
        const joint = world.addJoint(new SliderJoint({ bodyA: slider, anchor: new Vector3(), axis: xAxis, motor: { targetPosition: 0, frequency: 2, dampingRatio: 0 } }));
        slider.position.x = 0.1;
        const crossings: number[] = [];
        let previous = joint.position;
        runFor(world, 2, () => {
          const now = joint.position;
          if (previous > 0 && now <= 0) crossings.push(world.time);
          previous = now;
        });
        expect(crossings.length).toBeGreaterThanOrEqual(3);
        expect(Math.abs(crossings[2]! - crossings[1]! - 0.5)).toBeLessThan(0.02);
      }
    });

    it('settle without overshooting at a damping ratio of 1', () => {
      const world = makeWorld(false);
      const slider = box(world, new Vector3(), 5);
      const joint = world.addJoint(new SliderJoint({ bodyA: slider, anchor: new Vector3(), axis: xAxis, motor: { targetPosition: 0, frequency: 2 } }));
      slider.position.x = 0.1;
      let lowest = Infinity;
      runFor(world, 1.5, () => (lowest = Math.min(lowest, joint.position)));
      expect(lowest).toBeGreaterThan(-0.002);
      expect(Math.abs(joint.position)).toBeLessThan(0.002);
    });
  });

  describe('friction', () => {
    // a rod 1 m long hinged at one end, held out level: gravity turns it with m g L / 2
    const levelRod = (friction: number) => {
      const world = makeWorld();
      const rod = box(world, new Vector3(0.5, 0, 0), 2);
      const hinge = world.addJoint(new HingeJoint({ bodyA: rod, anchor: new Vector3(), axis: zAxis, friction }));
      return { world, hinge };
    };

    it('holds a hinge still against less torque than it has, and lets it go against more', () => {
      const needed = 2 * gravity * 0.5;
      const held = levelRod(needed * 1.2);
      runFor(held.world, 2);
      expect(Math.abs(held.hinge.angle)).toBeLessThan(0.01);
      const slipping = levelRod(needed * 0.5);
      runFor(slipping.world, 1);
      expect(slipping.hinge.angle).toBeLessThan(-0.5);
    });

    it('slows a spinning wheel at its torque over the inertia', () => {
      const world = makeWorld(false);
      const size = new Vector3(1, 1, 0.1);
      const wheel = box(world, new Vector3(), 4, size);
      world.addJoint(new HingeJoint({ bodyA: wheel, anchor: new Vector3(), axis: zAxis, friction: 0.5 }));
      wheel.angularVelocity.set(0, 0, 5);
      runFor(world, 1);
      // I = m (w² + h²) / 12 about z
      const inertia = (4 * (1 + 1)) / 12;
      expect(wheel.angularVelocity.z).toBeCloseTo(5 - (0.5 / inertia) * 1, 1);
    });

    it('holds a slider up against less weight than it has, and lets it slide down against more', () => {
      for (const [friction, expectedAcceleration] of [
        [3 * gravity * 1.2, 0],
        [3 * gravity * 0.5, gravity * 0.5],
      ] as const) {
        const world = makeWorld();
        const block = box(world, new Vector3(), 3);
        world.addJoint(new SliderJoint({ bodyA: block, anchor: new Vector3(), axis: yAxis, linearFriction: friction }));
        runFor(world, 0.5);
        const speedBefore = block.velocity.y;
        runFor(world, 0.5);
        expect((speedBefore - block.velocity.y) / 0.5).toBeCloseTo(expectedAcceleration, 1);
      }
    });
  });

  describe('orientation drives', () => {
    it('turn a limb to the orientation asked for, and hold it there', () => {
      const world = makeWorld(false);
      const limb = box(world, new Vector3(0.5, 0, 0), 2);
      const target = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, 0.5).normalize(), 0.8);
      world.addJoint(new ConeTwistJoint({ bodyA: limb, anchor: new Vector3(), orientationDrive: { target, frequency: 3 } }));
      runFor(world, 3);
      expect(angleBetween(limb.quaternion, target)).toBeLessThan(0.01);
      expect(limb.angularVelocity.length()).toBeLessThan(0.01);
      // turned about the joint, which held its anchor
      expect(limb.pointToWorld(new Vector3(-0.5, 0, 0), new Vector3()).length()).toBeLessThan(2e-3);
    });

    it('hold a limb against gravity only as far as their torque allows', () => {
      const holding = (maxTorque: number) => {
        const world = makeWorld();
        const limb = box(world, new Vector3(0.5, 0, 0), 2);
        // damped, since a drive at its limit has nothing left to damp the swing with
        limb.angularDamping = 3;
        limb.linearDamping = 3;
        world.addJoint(new ConeTwistJoint({ bodyA: limb, anchor: new Vector3(), orientationDrive: { target: new Quaternion(), frequency: 8, maxTorque } }));
        runFor(world, 4);
        // how far it has drooped
        return limb.directionToWorld(xAxis.clone()).y;
      };
      const needed = 2 * gravity * 0.5;
      expect(holding(needed * 2)).toBeGreaterThan(-0.05);
      // with half the torque, it droops until gravity's turn on it, m g L cos θ / 2, is half too: 60°
      expect(holding(needed * 0.5)).toBeCloseTo(-Math.sin(Math.PI / 3), 1);
    });
  });

  describe('target joints', () => {
    it('pull a body to a pose in the world and hold it there', () => {
      const world = makeWorld(false);
      const body = box(world, new Vector3(), 3);
      const quaternion = new Quaternion().setFromAxisAngle(yAxis, 1);
      world.addJoint(new TargetJoint({ body, position: new Vector3(2, 1, 0), quaternion, frequency: 3 }));
      runFor(world, 2);
      expect(body.position.distanceTo(new Vector3(2, 1, 0))).toBeLessThan(1e-3);
      expect(angleBetween(body.quaternion, quaternion)).toBeLessThan(0.01);
    });

    it('hold a body up against gravity with the sag of their spring', () => {
      const world = makeWorld();
      const body = box(world, new Vector3(), 3);
      world.addJoint(new TargetJoint({ body, frequency: 3 }));
      runFor(world, 2);
      const sag = gravity / (2 * Math.PI * 3) ** 2;
      expect(Math.abs(-body.position.y / sag - 1)).toBeLessThan(0.1);
    });

    it('keep up with a moving target told its speed, and let go at a frequency of 0', () => {
      const world = makeWorld(false);
      const body = box(world, new Vector3(), 3);
      const joint = world.addJoint(new TargetJoint({ body, frequency: 4 }));
      const target = new Vector3();
      const velocity = new Vector3(1, 0, 0);
      runFor(world, 2, () => {
        target.addScaledVector(velocity, world.timestep);
        joint.setTarget(target, undefined, velocity);
      });
      expect(body.position.distanceTo(target)).toBeLessThan(0.02);
      joint.frequency = 0;
      const speed = body.velocity.clone();
      runFor(world, 0.5);
      expect(body.velocity.distanceTo(speed)).toBeLessThan(1e-6);
    });

    it('pull with no more than their force', () => {
      const world = makeWorld(false);
      const body = box(world, new Vector3(), 2);
      world.addJoint(new TargetJoint({ body, position: new Vector3(10, 0, 0), frequency: 5, maxForce: 4 }));
      runFor(world, 1);
      // a = F / m = 2 m/s², so after a second about 1 m
      expect(body.position.x).toBeCloseTo(1, 1);
    });
  });
});
