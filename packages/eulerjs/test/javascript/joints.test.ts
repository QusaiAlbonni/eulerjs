import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, ConeTwistJoint, FixedJoint, HingeJoint, JavaScriptBackend, MassProperties, PlaneCollider, SixDofJoint, SliderJoint, World } from 'eulerjs';
import type { JavaScriptBackendOptions, JointBreakEvent } from 'eulerjs';

const gravity = 9.81;
const zAxis = new Vector3(0, 0, 1);

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('joints (%s)', (solver) => {
  const makeWorld = (options: { gravity?: Vector3; substeps?: number } = {}) => new World({ ...options, backend: new JavaScriptBackend({ solver }) });
  const runFor = (world: World, seconds: number, eachStep?: () => void) => {
    for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
      eachStep?.();
      world.fixedStep();
    }
  };
  /** A rod 1 m long along x, centred at `center`. */
  const rod = (world: World, center: Vector3, mass = 2, canSleep = false) =>
    world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 0.1, 0.1), mass), position: center, canSleep, colliders: [new BoxCollider({ size: new Vector3(1, 0.1, 0.1) })] }));

  describe('hinges', () => {
    it('swing a rod about its hinge with the period of a physical pendulum, staying in its plane', () => {
      const world = makeWorld();
      // hinged at its left end, about z, let go 0.3 rad from hanging straight down
      const startAngle = 0.3;
      const swinging = world.addBody(
        new Body({
          massProperties: MassProperties.box(new Vector3(1, 0.1, 0.1), 2),
          position: new Vector3(0.5 * Math.sin(startAngle), -0.5 * Math.cos(startAngle), 0),
          quaternion: new Quaternion().setFromAxisAngle(zAxis, startAngle - Math.PI / 2),
          canSleep: false,
          colliders: [],
        }),
      );
      world.addJoint(new HingeJoint({ bodyA: swinging, anchor: new Vector3(), axis: zAxis }));
      const crossings: number[] = [];
      let previousX = swinging.position.x;
      let furthestOffPlane = 0;
      let furthestFromHinge = 0;
      runFor(world, 6, () => {
        const nowX = swinging.position.x;
        if (previousX > 0 && nowX <= 0) crossings.push(world.time);
        previousX = nowX;
        furthestOffPlane = Math.max(furthestOffPlane, Math.abs(swinging.position.z), Math.abs(swinging.directionToWorld(zAxis).z - 1));
        furthestFromHinge = Math.max(furthestFromHinge, Math.abs(swinging.position.length() - 0.5));
      });
      // T = 2π √(I / m g d) (1 + θ² / 16), with I = m L² / 3 about the end and d = L / 2
      const expected = 2 * Math.PI * Math.sqrt(2 / (3 * gravity)) * (1 + startAngle ** 2 / 16);
      const period = crossings[1]! - crossings[0]!;
      expect(Math.abs(period / expected - 1)).toBeLessThan(0.01);
      expect(furthestOffPlane).toBeLessThan(1e-3);
      expect(furthestFromHinge).toBeLessThan(5e-3);
    });

    it('stop at their limits, and say how far they have turned', () => {
      const world = makeWorld();
      const flap = rod(world, new Vector3(0.5, 0, 0));
      const hinge = world.addJoint(new HingeJoint({ bodyA: flap, anchor: new Vector3(), axis: zAxis, limits: { lower: -0.5, upper: 0.5 } }));
      let lowest = 0;
      runFor(world, 3, () => (lowest = Math.min(lowest, hinge.angle)));
      // gravity pulls it down to its lower limit and it rests there
      expect(lowest).toBeGreaterThan(-0.5 - 0.02);
      expect(hinge.angle).toBeCloseTo(-0.5, 2);
      expect(flap.directionToWorld(new Vector3(1, 0, 0)).angleTo(new Vector3(Math.cos(0.5), -Math.sin(0.5), 0))).toBeLessThan(0.02);
    });

    it('drive a wheel with a motor: up to its speed, at no more than its torque', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const wheel = world.addBody(new Body({ massProperties: MassProperties.cylinder(0.5, 0.2, 10), canSleep: false, colliders: [] }));
      const torque = 2;
      const hinge = world.addJoint(new HingeJoint({ bodyA: wheel, anchor: new Vector3(), axis: new Vector3(0, 1, 0), motor: { targetVelocity: 3, maxForce: torque } }));
      // I = m r² / 2 = 1.25 about the axle: 1.6 rad/s² until it reaches 3 rad/s, after 1.875 s
      runFor(world, 1);
      expect(wheel.angularVelocity.y).toBeCloseTo(torque / 1.25, 1);
      expect(hinge.torque.length()).toBeCloseTo(torque, 1);
      runFor(world, 2);
      expect(wheel.angularVelocity.y).toBeCloseTo(3, 3);
      expect(Math.hypot(wheel.angularVelocity.x, wheel.angularVelocity.z)).toBeLessThan(1e-6);
    });

    it('hold an angle with a servo against gravity', () => {
      const world = makeWorld();
      const arm = rod(world, new Vector3(0.5, 0, 0));
      const hinge = world.addJoint(new HingeJoint({ bodyA: arm, anchor: new Vector3(), axis: zAxis, motor: { targetPosition: 0.4, stiffness: 2000, damping: 100 } }));
      runFor(world, 3);
      // it sags below the target by the gravity torque over the stiffness: m g (L/2) cos θ / k
      const sag = (2 * gravity * 0.5 * Math.cos(0.4)) / 2000;
      expect(hinge.angle).toBeCloseTo(0.4 - sag, 2);
      expect(arm.angularVelocity.length()).toBeLessThan(1e-3);
    });
  });

  describe('sliders', () => {
    it('let a body slide down a tilted rail at g sin θ, and stop at the end of it', () => {
      const world = makeWorld();
      const tilt = 0.4;
      const along = new Vector3(Math.cos(tilt), -Math.sin(tilt), 0);
      const carriage = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(0.2, 0.2, 0.2), 1), canSleep: false, colliders: [] }));
      const rail = world.addJoint(new SliderJoint({ bodyA: carriage, anchor: new Vector3(), axis: along, limits: { lower: -1, upper: 2 } }));
      runFor(world, 0.3);
      const startSpeed = carriage.velocity.dot(along);
      runFor(world, 0.3);
      expect((carriage.velocity.dot(along) - startSpeed) / 0.3).toBeCloseTo(gravity * Math.sin(tilt), 1);
      // nothing across the rail, no turning
      expect(carriage.position.clone().projectOnPlane(along).length()).toBeLessThan(1e-3);
      expect(carriage.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-3);
      runFor(world, 2);
      expect(rail.position).toBeCloseTo(2, 2);
      expect(carriage.velocity.length()).toBeLessThan(0.05);
    });

    it('move along the rail with a motor', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const carriage = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(0.2, 0.2, 0.2), 1), canSleep: false, colliders: [] }));
      const rail = world.addJoint(new SliderJoint({ bodyA: carriage, anchor: new Vector3(), axis: new Vector3(0, 0, 1), motor: { targetVelocity: 0.5, maxForce: 100 } }));
      runFor(world, 2);
      expect(carriage.velocity.z).toBeCloseTo(0.5, 3);
      expect(rail.position).toBeCloseTo(1, 1);
    });
  });

  describe('fixed joints', () => {
    it('hold a hanging box up with its weight, and two boxes together as one', () => {
      const world = makeWorld();
      const top = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 5), position: new Vector3(0, 0, 0), canSleep: false, colliders: [] }));
      const bottom = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 3), position: new Vector3(0.3, -1, 0), canSleep: false, colliders: [] }));
      const hook = world.addJoint(new FixedJoint({ bodyA: top, anchor: new Vector3(0, 0.5, 0) }));
      const weld = world.addJoint(new FixedJoint({ bodyA: top, bodyB: bottom, anchor: new Vector3(0.15, -0.5, 0) }));
      runFor(world, 2);
      expect(top.position.length()).toBeLessThan(0.01);
      expect(bottom.position.distanceTo(new Vector3(0.3, -1, 0))).toBeLessThan(0.01);
      // the hook carries both boxes, the weld the bottom one, and the off-centre bottom box's moment
      expect(hook.force.length()).toBeCloseTo(8 * gravity, 0);
      expect(weld.force.length()).toBeCloseTo(3 * gravity, 0);
      expect(weld.torque.length()).toBeCloseTo(3 * gravity * 0.15, 0);
    });

    it('break once they carry more than their limit, and say so', () => {
      const world = makeWorld();
      const load = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), canSleep: false, colliders: [] }));
      const hook = world.addJoint(new FixedJoint({ bodyA: load, anchor: new Vector3(0, 0.5, 0), breakForce: 150 }));
      const breaks: JointBreakEvent[] = [];
      world.on('jointBreak', (event) => breaks.push(event));
      runFor(world, 1);
      expect(breaks).toHaveLength(0);
      // pulling down with 100 N more makes 198 N
      runFor(world, 0.2, () => load.applyForce(new Vector3(0, -100, 0)));
      expect(breaks).toHaveLength(1);
      expect(breaks[0]!.joint).toBe(hook);
      expect(breaks[0]!.force).toBeGreaterThan(150);
      expect(hook.broken).toBe(true);
      expect(world.joints).not.toContain(hook);
      expect(load.velocity.y).toBeLessThan(-0.5);
    });
  });

  describe('cone-twist joints', () => {
    it('keep a swinging limb within its cone and its twist within limits', () => {
      const world = makeWorld();
      // hanging straight down from the origin, swung sideways about the shoulder and twisted
      const spin = new Vector3(4, 6, 3);
      const limb = world.addBody(
        new Body({
          massProperties: MassProperties.box(new Vector3(0.1, 1, 0.1), 2),
          position: new Vector3(0, -0.5, 0),
          angularVelocity: spin,
          velocity: spin.clone().cross(new Vector3(0, -0.5, 0)),
          canSleep: false,
          colliders: [],
        }),
      );
      const shoulder = world.addJoint(new ConeTwistJoint({ bodyA: limb, anchor: new Vector3(), axis: new Vector3(0, -1, 0), swingLimit: 0.6, twistLimits: { lower: -0.3, upper: 0.3 } }));
      let widestSwing = 0;
      let widestTwist = 0;
      runFor(world, 3, () => {
        const measured = shoulder.measure();
        widestSwing = Math.max(widestSwing, measured.swing.length());
        widestTwist = Math.max(widestTwist, Math.abs(measured.twist));
      });
      expect(widestSwing).toBeGreaterThan(0.5);
      expect(widestSwing).toBeLessThan(0.6 + 0.03);
      expect(widestTwist).toBeGreaterThan(0.25);
      expect(widestTwist).toBeLessThan(0.3 + 0.03);
      expect(limb.pointToWorld(new Vector3(0, 0.5, 0)).length()).toBeLessThan(0.01);
    });

    it('lean further one way than the other in an oval cone', () => {
      /** The widest swing about the joint's y (1) or z (2) axis while a torque leans the limb that way. */
      const widestLean = (index: 1 | 2) => {
        const world = makeWorld({ gravity: new Vector3() });
        const limb = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(0.1, 1, 0.1), 2), position: new Vector3(0, -0.5, 0), canSleep: false, colliders: [] }));
        const hip = world.addJoint(new ConeTwistJoint({ bodyA: limb, anchor: new Vector3(), axis: new Vector3(0, -1, 0), swingLimit: { aboutY: 0.2, aboutZ: 0.8 } }));
        const jointAxis = new Vector3().setComponent(index, 1).applyQuaternion(hip.frameA.quaternion);
        let widest = 0;
        runFor(world, 1.5, () => {
          limb.applyTorque(jointAxis.clone().multiplyScalar(2));
          widest = Math.max(widest, Math.abs(hip.measure().swing.getComponent(index)));
        });
        return widest;
      };
      const aboutZ = widestLean(2);
      expect(aboutZ).toBeGreaterThan(0.75);
      expect(aboutZ).toBeLessThan(0.8 + 0.03);
      const aboutY = widestLean(1);
      expect(aboutY).toBeGreaterThan(0.15);
      expect(aboutY).toBeLessThan(0.2 + 0.03);
    });
  });

  describe('six-degree-of-freedom joints', () => {
    it('take explicit frames and report where frame B is in frame A', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const bodyA = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 1), colliders: [] }));
      const bodyB = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 1), position: new Vector3(0, 2, 0), colliders: [] }));
      const joint = new SixDofJoint({
        bodyA,
        bodyB,
        frameA: { position: new Vector3(0, 1, 0), quaternion: new Quaternion() },
        frameB: { position: new Vector3(0, -1, 0), quaternion: new Quaternion() },
        linear: ['free', 'locked', 'locked'],
        angular: ['free', 'free', 'free'],
      });
      expect(joint.measure().linear.length()).toBeLessThan(1e-12);
      bodyB.position.x = 0.7;
      expect(joint.measure().linear.x).toBeCloseTo(0.7, 12);
      expect(() => new SixDofJoint({ bodyA, frameA: joint.frameA })).toThrow();
      expect(() => new SixDofJoint({ bodyA, linear: [{ lower: 1, upper: 0 }, 'locked', 'locked'] })).toThrow(RangeError);
    });

    it('fall asleep when the bodies they tie come to rest', () => {
      const world = makeWorld();
      world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
      const lid = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 0.1, 1), 2), position: new Vector3(0.5, 0.3, 0), colliders: [new BoxCollider({ size: new Vector3(1, 0.1, 1) })] }));
      const box = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 0.2, 1), 20), position: new Vector3(0.5, 0.1, 1.2), colliders: [new BoxCollider({ size: new Vector3(1, 0.2, 1) })] }));
      world.addJoint(new HingeJoint({ bodyA: box, bodyB: lid, anchor: new Vector3(0.5, 0.3, 0.6), axis: new Vector3(1, 0, 0), collideConnected: false }));
      runFor(world, 4);
      expect(lid.isSleeping && box.isSleeping).toBe(true);
    });
  });
});
