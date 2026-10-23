import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, JavaScriptBackend, MassProperties, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import type { JavaScriptBackendOptions } from '@eulerjs/core';

// Static bodies the step leaves be until something touches them: the cases where it mustn't.

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('static bodies (%s)', (solver) => {
  const makeWorld = () => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8 })] }));
    return world;
  };
  const crate = (world: World, position: Vector3) =>
    world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position, colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
  const runFor = (world: World, seconds: number) => {
    for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
  };

  it('hold up a sleeping body that is woken by a hit, from the step it wakes', () => {
    const world = makeWorld();
    const box = crate(world, new Vector3(0, 0.5, 0));
    runFor(world, 3);
    expect(box.isSleeping).toBe(true);
    // a ball thrown at it, which wakes it on the step it arrives
    world.addBody(new Body({ massProperties: MassProperties.sphere(0.2, 2), position: new Vector3(-3, 0.5, 0), velocity: new Vector3(12, 0, 0), colliders: [new SphereCollider({ radius: 0.2 })] }));
    let lowest = Infinity;
    let woke = false;
    for (let step = 0; step < 90; step++) {
      world.fixedStep();
      lowest = Math.min(lowest, box.position.y);
      woke ||= !box.isSleeping;
    }
    expect(woke).toBe(true);
    expect(box.position.x).toBeGreaterThan(0.05);
    // never sank into the floor
    expect(lowest).toBeGreaterThan(0.49);
  });

  it('moved each step by a behaviour, are drawn moving from where they were, and collided with where they are', () => {
    const world = makeWorld();
    // moved by hand, a static body is teleported, not driven: a kinematic one carries what it lifts
    const lift = world.addBody(new Body({ type: 'static', position: new Vector3(0, 1, 0), colliders: [new BoxCollider({ size: new Vector3(3, 0.2, 3) })] }));
    lift.addBehavior({ fixedUpdate: (body) => body.setPose(body.position.clone().add(new Vector3(0, 0.005, 0)), body.quaternion) });
    runFor(world, 2);
    expect(lift.position.y).toBeCloseTo(1 + 0.6, 6);
    // it began the last step where the one before left it, so it is drawn rising between them
    expect(lift.previousPosition.y).toBeCloseTo(lift.position.y - 0.005, 9);
    // and a crate dropped onto it lands on its top, where it now is
    const box = crate(world, new Vector3(0, 3, 0));
    lift.removeBehavior(lift.behaviors[0]!);
    runFor(world, 2);
    expect(box.position.y).toBeCloseTo(lift.position.y + 0.1 + 0.5, 2);
  });

  it('are collided with where they are moved to by hand, between steps', () => {
    const world = makeWorld();
    const wall = world.addBody(new Body({ type: 'static', position: new Vector3(10, 1, 0), colliders: [new BoxCollider({ size: new Vector3(0.5, 2, 4) })] }));
    const ball = world.addBody(new Body({ massProperties: MassProperties.sphere(0.25, 1), position: new Vector3(0, 0.25, 0), velocity: new Vector3(4, 0, 0), colliders: [new SphereCollider({ radius: 0.25, friction: 0 })] }));
    runFor(world, 0.5);
    // the wall moved into the ball's way
    wall.setPose(new Vector3(3, 1, 0), wall.quaternion);
    runFor(world, 1.5);
    expect(ball.position.x).toBeLessThan(3 - 0.25 + 0.01);
  });

  it('keep the pose they were given, turned, from step to step, and ignore forces', () => {
    const world = makeWorld();
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, 0.2).normalize(), 0.9);
    const ramp = world.addBody(new Body({ type: 'static', position: new Vector3(0, 0.5, 0), quaternion: turned, colliders: [new BoxCollider({ size: new Vector3(3, 0.3, 2) })] }));
    world.fixedStep();
    const settled = ramp.quaternion.clone();
    for (let step = 0; step < 120; step++) {
      ramp.applyForce(new Vector3(0, 1000, 0));
      world.fixedStep();
    }
    // not renormalised over and over, its bits drifting
    expect(ramp.quaternion.equals(settled)).toBe(true);
    expect(ramp.position.equals(new Vector3(0, 0.5, 0))).toBe(true);
    expect(ramp.force.lengthSq()).toBe(0);
  });
});
