import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, DistanceJoint, FixedJoint, HingeJoint, MassProperties, PlaneCollider, SliderJoint, SphereCollider, World } from 'eulerjs';
import type { PhysicsBackend, WorldOptions } from 'eulerjs';

/**
 * What every backend must do, checked against physics rather than against one solver's exact
 * numbers: tolerances are loose enough for any sound method and tight enough to catch a wrong
 * one. Each backend runs it with `describeBackendConformance(name, () => new SomeBackend())`.
 */
export function describeBackendConformance(backendName: string, createBackend: () => PhysicsBackend): void {
  const gravity = 9.81;
  const unitBox = new Vector3(1, 1, 1);

  const makeWorld = (options: WorldOptions = {}) => new World({ ...options, backend: createBackend() });

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

  function ball(world: World, position: Vector3, options: { restitution?: number; canSleep?: boolean; velocity?: Vector3 } = {}): Body {
    return world.addBody(
      new Body({
        massProperties: MassProperties.sphere(0.5, 1),
        position,
        velocity: options.velocity,
        canSleep: options.canSleep,
        colliders: [new SphereCollider({ radius: 0.5, restitution: options.restitution })],
      }),
    );
  }

  function crate(world: World, position: Vector3, options: { friction?: number; quaternion?: Quaternion; canSleep?: boolean } = {}): Body {
    return world.addBody(
      new Body({
        massProperties: MassProperties.box(unitBox, 10),
        position,
        quaternion: options.quaternion,
        canSleep: options.canSleep,
        colliders: [new BoxCollider({ size: unitBox, friction: options.friction })],
      }),
    );
  }

  const relativeError = (measured: number, expected: number) => Math.abs(measured / expected - 1);

  describe(`${backendName}: motion`, () => {
    it('falls under gravity', () => {
      const world = makeWorld();
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1) }));
      runFor(world, 1);
      // a first-order integrator at 60 steps a second is off by about 1/60 of the fall
      expect(relativeError(body.position.y, -gravity / 2)).toBeLessThan(0.02);
      expect(relativeError(body.velocity.y, -gravity)).toBeLessThan(0.001);
    });

    it('accelerates by F / m and turns by I⁻¹ τ', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const massProperties = MassProperties.box(new Vector3(1, 2, 3), 6);
      const body = world.addBody(new Body({ massProperties, canSleep: false }));
      runFor(world, 0.5, () => {
        body.applyForce(new Vector3(12, 0, 0));
        body.applyTorque(new Vector3(0, 0, 0.1));
      });
      expect(relativeError(body.velocity.x, 1)).toBeLessThan(0.001);
      const spin = body.angularVelocity.z;
      expect(relativeError(spin, (0.1 / massProperties.inertia.elements[8]!) * 0.5)).toBeLessThan(0.01);
    });

    it('applies a force for one step only', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 2) }));
      body.applyForce(new Vector3(2 * 60, 0, 0));
      runFor(world, 1);
      expect(relativeError(body.velocity.x, 1)).toBeLessThan(0.001);
    });

    it('keeps the angular momentum of a tumbling uneven body', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const massProperties = MassProperties.box(new Vector3(1, 2, 3), 5);
      const body = world.addBody(new Body({ massProperties, angularVelocity: new Vector3(0.1, 4, 0.1), canSleep: false }));
      const angularMomentum = () => {
        const inverse = body.quaternion.clone().invert();
        const local = body.angularVelocity.clone().applyQuaternion(inverse).applyMatrix3(massProperties.inertia);
        return local.applyQuaternion(body.quaternion);
      };
      const start = angularMomentum();
      runFor(world, 10);
      expect(angularMomentum().distanceTo(start) / start.length()).toBeLessThan(0.01);
    });

    it('moves a kinematic body at its velocity and never moves a static one', () => {
      const world = makeWorld();
      const lift = world.addBody(new Body({ type: 'kinematic', velocity: new Vector3(0, 1, 0), angularVelocity: new Vector3(0, 1, 0) }));
      const wall = world.addBody(new Body({ type: 'static', position: new Vector3(3, 0, 0) }));
      runFor(world, 2);
      expect(lift.position.y).toBeCloseTo(2, 6);
      expect(lift.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2))).toBeLessThan(1e-6);
      expect(wall.position.x).toBe(3);
      expect(wall.velocity.length()).toBe(0);
    });

    it('honours damping and gravity scale', () => {
      const world = makeWorld();
      const floating = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), gravityScale: 0, velocity: new Vector3(1, 0, 0), linearDamping: 1 }));
      runFor(world, 1);
      expect(floating.position.y).toBe(0);
      expect(relativeError(floating.velocity.x, Math.exp(-1))).toBeLessThan(0.01);
    });
  });

  describe(`${backendName}: contacts`, () => {
    it('bounces a ball back to e² of its drop height', () => {
      const world = makeWorld();
      ground(world);
      const body = ball(world, new Vector3(0, 3.5, 0), { restitution: 0.6 });
      let fallen = false;
      let peak = 0;
      runFor(world, 3, () => {
        if (body.velocity.y < -1) fallen = true;
        if (fallen && body.velocity.y > 0) peak = Math.max(peak, body.position.y - 0.5);
      });
      expect(relativeError(peak, 3 * 0.6 ** 2)).toBeLessThan(0.05);
    });

    it('rests a box on the ground without sinking or creeping', () => {
      const world = makeWorld();
      ground(world);
      const body = crate(world, new Vector3(0, 0.5, 0), { canSleep: false });
      runFor(world, 3);
      expect(Math.abs(body.position.y - 0.5)).toBeLessThan(0.01);
      expect(Math.hypot(body.position.x, body.position.z)).toBeLessThan(0.001);
    });

    it('holds a block on a slope while tan θ < μ, and slides it at g (sin θ - μ cos θ) once tan θ > μ', () => {
      const slide = (tilt: number, friction: number) => {
        const world = makeWorld();
        const slope = ground(world, { tilt, friction });
        const downhill = new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0);
        const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
        const block = crate(world, up.multiplyScalar(0.5), { quaternion: slope.colliders[0]!.rotation, friction, canSleep: false });
        runFor(world, 0.5);
        const startDistance = block.position.dot(downhill);
        const startSpeed = block.velocity.dot(downhill);
        runFor(world, 1);
        return { distance: block.position.dot(downhill) - startDistance, acceleration: block.velocity.dot(downhill) - startSpeed };
      };
      expect(Math.abs(slide(0.3, 0.6).distance)).toBeLessThan(0.01);
      const sliding = slide(0.5, 0.3);
      expect(relativeError(sliding.acceleration, gravity * (Math.sin(0.5) - 0.3 * Math.cos(0.5)))).toBeLessThan(0.05);
    });

    it('rests a stack of three boxes', () => {
      const world = makeWorld();
      ground(world);
      const boxes = [0, 1, 2].map((level) => crate(world, new Vector3(0, 0.5 + level * 1.001, 0)));
      runFor(world, 10);
      const top = boxes.at(-1)!;
      expect(Math.abs(top.position.y - 2.5)).toBeLessThan(0.02);
      expect(Math.hypot(top.position.x, top.position.z)).toBeLessThan(0.01);
    });

    it('conserves momentum when two balls collide', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const left = ball(world, new Vector3(-2, 0, 0), { velocity: new Vector3(2, 0, 0), restitution: 1 });
      const right = ball(world, new Vector3(2, 0, 0), { velocity: new Vector3(-1, 0, 0), restitution: 1 });
      runFor(world, 3);
      expect(left.velocity.x + right.velocity.x).toBeCloseTo(1, 6);
      expect(left.velocity.x).toBeCloseTo(-1, 1);
    });

    it('collides with a static body where it has been moved to, not where it was', () => {
      const world = makeWorld();
      const shelf = world.addBody(new Body({ type: 'static', position: new Vector3(0, 0, 0), colliders: [new BoxCollider({ size: new Vector3(2, 0.2, 2) })] }));
      runFor(world, 0.5);
      // moved out from under where the ball will fall, then a ball dropped where it used to be
      shelf.position.set(5, 0, 0);
      const falling = ball(world, new Vector3(0, 2, 0), { canSleep: false });
      const resting = ball(world, new Vector3(5, 2, 0), { canSleep: false });
      runFor(world, 2);
      expect(falling.position.y).toBeLessThan(-3);
      expect(resting.position.y).toBeCloseTo(0.6, 2);
    });

    it('lets bodies through when their collision groups say so', () => {
      const world = makeWorld();
      world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ collisionGroups: 2 })] }));
      const ghost = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 1, 0), colliders: [new SphereCollider({ radius: 0.5, collidesWith: 1 })] }));
      runFor(world, 2);
      expect(ghost.position.y).toBeLessThan(-5);
    });

    it('reports contacts with the bodies, a normal from B toward A, and an impulse that holds up the weight', () => {
      const world = makeWorld();
      const floor = ground(world);
      const body = ball(world, new Vector3(0, 0.5, 0), { canSleep: false });
      runFor(world, 2);
      expect(world.contacts.length).toBeGreaterThan(0);
      let totalImpulse = 0;
      for (const contact of world.contacts) {
        const [onBall, onFloor] = contact.bodyA === body ? [contact.bodyA, contact.bodyB] : [contact.bodyB, contact.bodyA];
        expect(onBall).toBe(body);
        expect(onFloor).toBe(floor);
        const upward = contact.bodyA === body ? 1 : -1;
        expect(contact.normal.y * upward).toBeCloseTo(1, 6);
        expect(contact.point.y).toBeCloseTo(0, 2);
        totalImpulse += contact.normalImpulse;
      }
      expect(relativeError(totalImpulse / world.timestep, gravity)).toBeLessThan(0.02);
    });

    it('lets a kinematic paddle push a dynamic body without being pushed back', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const paddle = world.addBody(new Body({ type: 'kinematic', velocity: new Vector3(1, 0, 0), position: new Vector3(-2, 0, 0), colliders: [new BoxCollider({ size: unitBox })] }));
      const puck = ball(world, new Vector3(0, 0, 0));
      runFor(world, 3);
      expect(paddle.position.x).toBeCloseTo(1, 6);
      expect(puck.position.x).toBeGreaterThan(paddle.position.x + 0.99);
    });
  });

  describe(`${backendName}: joints`, () => {
    const hangingBall = (world: World, position: Vector3) =>
      world.addBody(new Body({ massProperties: MassProperties.sphere(0.05, 1), position, canSleep: false }));

    it('swings a pendulum with the period of a simple pendulum', () => {
      const world = makeWorld();
      const length = 2;
      const startAngle = 0.1;
      const bob = hangingBall(world, new Vector3(length * Math.sin(startAngle), -length * Math.cos(startAngle), 0));
      world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3() }));
      const crossings: number[] = [];
      let previousX = bob.position.x;
      runFor(world, 12, () => {
        if (previousX > 0 && bob.position.x <= 0) crossings.push(world.time);
        previousX = bob.position.x;
      });
      const period = (crossings.at(-1)! - crossings[0]!) / (crossings.length - 1);
      expect(relativeError(period, 2 * Math.PI * Math.sqrt(length / gravity) * (1 + startAngle ** 2 / 16))).toBeLessThan(0.01);
    });

    it('reports the tension that holds up a hanging weight', () => {
      const world = makeWorld();
      const bob = hangingBall(world, new Vector3(0, -1, 0));
      const joint = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3() }));
      runFor(world, 1);
      expect(relativeError(joint.tension, gravity)).toBeLessThan(0.02);
      expect(Math.abs(bob.position.y + 1)).toBeLessThan(0.001);
    });

    it('lets a rope go slack, and catches the body once it is taut', () => {
      const world = makeWorld();
      const bob = hangingBall(world, new Vector3(0, 0, 0));
      const rope = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3(), length: 2, slack: true }));
      runFor(world, 0.3);
      expect(relativeError(bob.position.y, -gravity * 0.3 ** 2 / 2)).toBeLessThan(0.05);
      expect(rope.tension).toBe(0);
      runFor(world, 3);
      expect(bob.position.length()).toBeLessThan(2.01);
    });

    it('lets the bodies it ties pass through each other when asked, and keeps them apart otherwise', () => {
      const overlappingPair = (collideConnected?: boolean) => {
        const world = makeWorld({ gravity: new Vector3() });
        const first = ball(world, new Vector3(0, 0, 0), { canSleep: false });
        const second = ball(world, new Vector3(0.6, 0, 0), { canSleep: false });
        const joint = world.addJoint(new DistanceJoint({ bodyA: first, bodyB: second, collideConnected, compliance: 1 }));
        runFor(world, 0.5);
        return { world, first, second, joint };
      };
      const passing = overlappingPair(false);
      expect(passing.first.position.distanceTo(passing.second.position)).toBeCloseTo(0.6, 6);
      const colliding = overlappingPair();
      expect(colliding.first.position.distanceTo(colliding.second.position)).toBeGreaterThan(0.99);
      // once the joint is gone, they collide again
      passing.world.removeJoint(passing.joint);
      runFor(passing.world, 0.5);
      expect(passing.first.position.distanceTo(passing.second.position)).toBeGreaterThan(0.99);
    });

    it('stops acting once removed, and is removed with its body', () => {
      const world = makeWorld();
      const bob = hangingBall(world, new Vector3(0, -1, 0));
      const joint = world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: new Vector3() }));
      world.removeJoint(joint);
      runFor(world, 1);
      expect(bob.position.y).toBeLessThan(-5);

      const other = hangingBall(world, new Vector3(5, -1, 0));
      const tied = world.addJoint(new DistanceJoint({ bodyA: other, anchorB: new Vector3(5, 0, 0) }));
      world.removeBody(other);
      expect(world.joints).not.toContain(tied);
      runFor(world, 0.1);
    });
  });

  describe(`${backendName}: collision filtering`, () => {
    it('stops two bodies colliding with each other when asked, and lets them again', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const first = ball(world, new Vector3(0, 0, 0), { canSleep: false });
      const second = ball(world, new Vector3(0.6, 0, 0), { canSleep: false });
      const third = ball(world, new Vector3(-0.6, 0, 0), { canSleep: false });
      world.setCollisionsBetween(first, second, false);
      world.setCollisionsBetween(first, second, false);
      runFor(world, 0.5);
      // the third, still colliding with the first, pushes it further into the second, which feels nothing
      expect(first.position.x - third.position.x).toBeGreaterThan(0.99);
      expect(second.position.x).toBeCloseTo(0.6, 6);
      expect(second.position.x - first.position.x).toBeLessThan(0.6);
      world.setCollisionsBetween(second, first, true);
      runFor(world, 0.5);
      expect(second.position.x - first.position.x).toBeGreaterThan(0.99);
    });

    it('forgets what it was told about a body once the body is removed', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const first = ball(world, new Vector3(0, 0, 0), { canSleep: false });
      const second = ball(world, new Vector3(0.6, 0, 0), { canSleep: false });
      world.setCollisionsBetween(first, second, false);
      world.removeBody(second);
      world.addBody(second);
      runFor(world, 0.5);
      expect(second.position.x - first.position.x).toBeGreaterThan(0.99);
      expect(() => world.setCollisionsBetween(first, new Body({ type: 'static' }), false)).toThrow();
    });
  });

  describe(`${backendName}: sleeping`, () => {
    it('puts a resting body to sleep and leaves it where it was', () => {
      const world = makeWorld();
      ground(world);
      const body = crate(world, new Vector3(0, 0.5, 0));
      runFor(world, 3);
      expect(body.isSleeping).toBe(true);
      const restingAt = body.position.clone();
      runFor(world, 1);
      expect(body.position.equals(restingAt)).toBe(true);
    });

    it('keeps a body that may not sleep awake', () => {
      const world = makeWorld();
      ground(world);
      const body = crate(world, new Vector3(0, 0.5, 0), { canSleep: false });
      runFor(world, 3);
      expect(body.isSleeping).toBe(false);
    });

    it('is woken by a force, a velocity, a new pose or something running into it', () => {
      const asleepOnGround = () => {
        const world = makeWorld();
        ground(world);
        const body = crate(world, new Vector3(0, 0.5, 0));
        runFor(world, 3);
        expect(body.isSleeping).toBe(true);
        return { world, body };
      };

      const pushed = asleepOnGround();
      runFor(pushed.world, 0.5, () => pushed.body.applyForce(new Vector3(500, 0, 0)));
      expect(pushed.body.isSleeping).toBe(false);
      expect(pushed.body.position.x).toBeGreaterThan(0.1);

      const thrown = asleepOnGround();
      thrown.body.velocity.set(0, 3, 0);
      runFor(thrown.world, 0.1);
      expect(thrown.body.position.y).toBeGreaterThan(0.6);

      const lifted = asleepOnGround();
      lifted.body.setPose(new Vector3(0, 3, 0), new Quaternion());
      runFor(lifted.world, 0.2);
      expect(lifted.body.position.y).toBeLessThan(3);

      const hit = asleepOnGround();
      ball(hit.world, new Vector3(-3, 0.5, 0), { velocity: new Vector3(8, 0, 0) });
      runFor(hit.world, 1);
      expect(hit.body.position.x).toBeGreaterThan(0.01);
    });

    it('can be put to sleep by hand', () => {
      const world = makeWorld();
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), velocity: new Vector3(3, 0, 0) }));
      body.sleep();
      runFor(world, 1);
      expect(body.isSleeping).toBe(true);
      expect(body.position.length()).toBe(0);
    });
  });

  describe(`${backendName}: changes you make`, () => {
    it('takes a pose or velocity edited between steps', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1) }));
      world.fixedStep();
      body.position.set(4, 5, 6);
      body.velocity.set(1, 0, 0);
      body.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 1);
      runFor(world, 1);
      expect(body.position.x).toBeCloseTo(5, 6);
      expect(body.position.y).toBeCloseTo(5, 6);
      expect(body.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1))).toBeLessThan(1e-9);
    });

    it('takes velocity changes made by behaviours in the same step', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 2) }));
      body.addBehavior({ fixedUpdate: (target, _timestep, owner) => owner.stepCount === 0 && target.applyImpulse(new Vector3(4, 0, 0)) });
      world.fixedStep();
      expect(body.velocity.x).toBeCloseTo(2, 9);
      expect(body.position.x).toBeCloseTo(2 * world.timestep, 9);
    });

    it('uses mass properties and colliders changed after the body was added', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1) }));
      body.setMass(4);
      runFor(world, 1, () => body.applyForce(new Vector3(4, 0, 0)));
      expect(relativeError(body.velocity.x, 1)).toBeLessThan(0.001);

      const falling = makeWorld();
      ground(falling);
      const late = falling.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 2, 0) }));
      late.addCollider(new SphereCollider({ radius: 0.5 }));
      runFor(falling, 2);
      expect(late.position.y).toBeCloseTo(0.5, 1);
      // asleep on the ground by now, and woken by losing what holds it up
      late.removeCollider(late.colliders[0]!);
      runFor(falling, 1);
      expect(late.position.y).toBeLessThan(-1);
    });

    it('teleports with setPose', () => {
      const world = makeWorld();
      const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), canSleep: false }));
      runFor(world, 0.5);
      body.setPose(new Vector3(10, 0, 0), new Quaternion());
      body.velocity.set(0, 0, 0);
      world.fixedStep();
      expect(body.position.x).toBeCloseTo(10, 9);
      expect(body.position.y).toBeGreaterThan(-0.01);
    });
  });

  describe(`${backendName}: scene queries`, () => {
    it('casts rays, sweeps shapes and finds overlaps against the bodies where they are', () => {
      const world = makeWorld({ gravity: new Vector3() });
      const crate = world.addBody(new Body({ type: 'static', position: new Vector3(5, 0, 0), colliders: [new BoxCollider({ size: unitBox })] }));
      const ray = world.castRay(new Vector3(), new Vector3(1, 0, 0))!;
      expect(ray.body).toBe(crate);
      expect(ray.distance).toBeCloseTo(4.5, 6);
      expect(ray.normal.x).toBeCloseTo(-1, 6);
      expect(world.castRay(new Vector3(), new Vector3(0, 1, 0))).toBeUndefined();
      expect(world.castShape(new SphereCollider({ radius: 0.25 }), new Vector3(), new Vector3(1, 0, 0))!.distance).toBeCloseTo(4.25, 6);
      expect(world.overlap(new SphereCollider({ radius: 1 }), new Vector3(4, 0, 0)).map((hit) => hit.body)).toEqual([crate]);
      crate.position.set(5, 3, 0);
      expect(world.castRay(new Vector3(), new Vector3(1, 0, 0))).toBeUndefined();
    });
  });

  describe(`${backendName}: sensors and events`, () => {
    it('reports contacts beginning and ending, and bodies passing through a sensor without being pushed', () => {
      const world = makeWorld();
      ground(world);
      world.addBody(new Body({ type: 'static', position: new Vector3(0, 3, 0), colliders: [new BoxCollider({ size: new Vector3(3, 1, 3), sensor: true })] }));
      const dropped = ball(world, new Vector3(0, 5, 0));
      const events: string[] = [];
      world.on('sensorEnter', () => events.push('enter'));
      world.on('sensorExit', () => events.push('exit'));
      world.on('contactBegin', () => events.push('begin'));
      world.on('contactEnd', () => events.push('end'));
      runFor(world, 2);
      expect(events).toEqual(['enter', 'exit', 'begin']);
      dropped.velocity.set(0, 4, 0);
      runFor(world, 0.3);
      expect(events.at(-1)).toBe('end');
    });
  });

  describe(`${backendName}: hinges, sliders and breaking joints`, () => {
    it('turns a hinged body about its axis only, and slides a slider along its rail only', () => {
      const world = makeWorld();
      const door = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 2, 0.1), 10), position: new Vector3(0.5, 0, 0), canSleep: false }));
      const hinge = world.addJoint(new HingeJoint({ bodyA: door, anchor: new Vector3(0, 0, 0), axis: new Vector3(0, 0, 1) }));
      runFor(world, 0.3);
      expect(hinge.angle).toBeLessThan(-0.1);
      expect(Math.abs(door.position.z)).toBeLessThan(1e-3);
      expect(door.pointToWorld(new Vector3(-0.5, 0, 0)).length()).toBeLessThan(0.01);
      const carriage = world.addBody(new Body({ massProperties: MassProperties.box(unitBox, 1), position: new Vector3(5, 0, 0), canSleep: false }));
      world.addJoint(new SliderJoint({ bodyA: carriage, anchor: new Vector3(5, 0, 0), axis: new Vector3(1, -1, 0) }));
      runFor(world, 0.5);
      expect(carriage.position.x - 5).toBeCloseTo(-carriage.position.y, 3);
      expect(carriage.position.y).toBeLessThan(-0.2);
    });

    it('breaks a joint that carries more than its limit, and removes it', () => {
      const world = makeWorld();
      const load = world.addBody(new Body({ massProperties: MassProperties.box(unitBox, 10), canSleep: false }));
      const hook = world.addJoint(new FixedJoint({ bodyA: load, anchor: new Vector3(0, 0.5, 0), breakForce: 50 }));
      runFor(world, 0.2);
      expect(hook.broken).toBe(true);
      expect(world.joints).toHaveLength(0);
      expect(load.velocity.y).toBeLessThan(-0.5);
    });
  });
}
