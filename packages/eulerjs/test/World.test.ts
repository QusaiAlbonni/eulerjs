import { Object3D, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Body, EulerError, MassProperties, World } from 'eulerjs';
import type { Plugin } from 'eulerjs';
import { expectVectorClose } from './helpers.js';

const ball = () => new Body({ massProperties: MassProperties.sphere(0.5, 1) });

describe('World stepping', () => {
  it('runs as many fixed steps as fit in the frame time and keeps the remainder', () => {
    const world = new World({ timestep: 1 / 120 });
    world.step(1 / 60);
    expect(world.stepCount).toBe(2);
    const alpha = world.step(1 / 240);
    expect(world.stepCount).toBe(2);
    expect(alpha).toBeCloseTo(0.5, 9);
    world.step(1 / 240);
    expect(world.stepCount).toBe(3);
  });

  it('counts simulated time in whole steps', () => {
    const world = new World({ timestep: 0.01 });
    for (let frame = 0; frame < 100; frame++) world.step(0.01);
    expect(world.stepCount).toBe(100);
    expect(world.time).toBeCloseTo(1, 12);
  });

  it('drops time beyond maxStepsPerFrame instead of falling ever further behind', () => {
    const world = new World({ timestep: 1 / 120, maxStepsPerFrame: 4 });
    world.step(10);
    expect(world.stepCount).toBe(4);
    world.step(0);
    expect(world.stepCount).toBe(4);
  });

  it('ignores negative frame times', () => {
    const world = new World();
    world.step(-1);
    expect(world.stepCount).toBe(0);
  });

  it('rejects a non-positive timestep', () => {
    expect(() => new World({ timestep: 0 })).toThrow(EulerError);
    expect(() => new World({ timestep: Number.NaN })).toThrow(EulerError);
  });

  it('copies the gravity vector it is given', () => {
    const gravity = new Vector3(0, -1, 0);
    const world = new World({ gravity });
    gravity.set(0, 0, 0);
    expectVectorClose(world.gravity, new Vector3(0, -1, 0));
  });
});

describe('World bodies', () => {
  it('adds a body once and records which world owns it', () => {
    const world = new World();
    const body = world.addBody(ball());
    world.addBody(body);
    expect(world.bodies).toEqual([body]);
    expect(body.world).toBe(world);
  });

  it('refuses a body that belongs to another world', () => {
    const body = new World().addBody(ball());
    expect(() => new World().addBody(body)).toThrow(/another world/);
  });

  it('removes bodies, which then stop moving', () => {
    const world = new World();
    const body = world.addBody(ball());
    world.removeBody(body);
    world.removeBody(body);
    world.fixedStep();
    expect(body.world).toBeUndefined();
    expect(body.velocity.length()).toBe(0);
  });

  it('picks up a pose edited directly between steps', () => {
    const world = new World({ gravity: new Vector3() });
    const body = world.addBody(ball());
    body.position.set(0, 7, 0);
    world.fixedStep();
    expectVectorClose(body.worldCenterOfMass, new Vector3(0, 7, 0));
  });

  it('syncs every bound object', () => {
    const world = new World({ gravity: new Vector3(), timestep: 0.5 });
    const object = new Object3D();
    world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1), object, velocity: new Vector3(2, 0, 0) }));
    world.step(0.75); // one step (x: 0 -> 1) and half a step left over
    world.syncObjects();
    // rendering interpolates between the last two steps, so it trails the simulation by up to a step
    expectVectorClose(object.position, new Vector3(0.5, 0, 0), 1e-12);
  });
});

describe('World plugins', () => {
  it('runs hooks in a fixed order and integrates forces added in applyForces the same step', () => {
    const calls: string[] = [];
    const world = new World({ gravity: new Vector3() });
    const body = world.addBody(ball());
    body.addBehavior({ fixedUpdate: () => calls.push('behavior') });
    const plugin: Plugin = {
      name: 'recorder',
      install: () => calls.push('install'),
      beforeStep: () => calls.push('beforeStep'),
      applyForces: () => {
        calls.push('applyForces');
        body.applyForce(new Vector3(1, 0, 0));
      },
      afterStep: () => {
        calls.push(`afterStep (vx > 0: ${body.velocity.x > 0})`);
      },
    };
    expect(world.use(plugin)).toBe(plugin);
    world.fixedStep();
    expect(calls).toEqual(['install', 'beforeStep', 'behavior', 'applyForces', 'afterStep (vx > 0: true)']);
  });

  it('installs a plugin only once and disposes it on removal', () => {
    const world = new World();
    const plugin: Plugin = { name: 'counted', install: vi.fn(), dispose: vi.fn() };
    world.use(plugin);
    world.use(plugin);
    expect(plugin.install).toHaveBeenCalledTimes(1);
    world.removePlugin(plugin);
    world.removePlugin(plugin);
    expect(plugin.dispose).toHaveBeenCalledTimes(1);
    expect(world.plugins).toHaveLength(0);
  });

  it('dispose removes every plugin and body', () => {
    const world = new World();
    const plugin: Plugin = { name: 'disposable', dispose: vi.fn() };
    world.use(plugin);
    const body = world.addBody(ball());
    world.dispose();
    expect(plugin.dispose).toHaveBeenCalledWith(world);
    expect(world.bodies).toHaveLength(0);
    expect(body.world).toBeUndefined();
  });
});
