import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, JavaScriptBackend, MassProperties, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import type { ContactEvent, JavaScriptBackendOptions, SensorEvent } from '@eulerjs/core';

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('world events (%s)', (solver) => {
  const makeWorld = () => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    const ground = world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    return { world, ground };
  };
  const ball = (world: World, position: Vector3, restitution = 0) =>
    world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position, colliders: [new SphereCollider({ radius: 0.5, restitution })] }));
  const runFor = (world: World, seconds: number) => {
    for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
  };

  it('begins a contact once when a ball lands, keeps it while it rests and sleeps, and ends it when it is thrown up', () => {
    const { world, ground } = makeWorld();
    const dropped = ball(world, new Vector3(0, 2, 0));
    const begins: ContactEvent[] = [];
    const ends: ContactEvent[] = [];
    world.on('contactBegin', (event) => begins.push(event));
    world.on('contactEnd', (event) => ends.push(event));
    runFor(world, 3);
    expect(dropped.isSleeping).toBe(true);
    expect(begins).toHaveLength(1);
    expect(ends).toHaveLength(0);
    const [landing] = begins;
    expect([landing!.bodyA, landing!.bodyB]).toEqual(expect.arrayContaining([dropped, ground]));
    expect(landing!.contacts.length).toBeGreaterThan(0);
    // landing at about √(2 g h) for the 1.5 m it fell
    const impulse = landing!.contacts.reduce((sum, contact) => sum + contact.normalImpulse, 0);
    expect(impulse).toBeGreaterThan(0.5 * Math.sqrt(2 * 9.81 * 1.5));
    dropped.velocity.set(0, 5, 0);
    runFor(world, 0.2);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.contacts).toHaveLength(0);
  });

  it('begins and ends a contact on every bounce', () => {
    const { world } = makeWorld();
    ball(world, new Vector3(0, 3, 0), 0.8);
    let begins = 0;
    let ends = 0;
    world.on('contactBegin', () => begins++);
    world.on('contactEnd', () => ends++);
    runFor(world, 3.6);
    // falling 2.5 m with e = 0.8, it lands after 0.71 s, 1.85 s, 2.76 s and 3.49 s
    expect(begins).toBe(4);
    expect(ends === begins || ends === begins - 1).toBe(true);
  });

  it('ends the contacts of a body that is removed, and stops calling a listener that unsubscribed', () => {
    const { world } = makeWorld();
    const dropped = ball(world, new Vector3(0, 0.6, 0));
    let ends = 0;
    let begins = 0;
    const stop = world.on('contactBegin', () => begins++);
    world.on('contactEnd', () => ends++);
    runFor(world, 0.5);
    expect(begins).toBe(1);
    world.removeBody(dropped);
    expect(ends).toBe(1);
    stop();
    ball(world, new Vector3(3, 0.6, 0));
    runFor(world, 0.5);
    expect(begins).toBe(1);
  });

  it('lets a ball fall freely through a sensor, saying when it goes in and when it comes out', () => {
    const { world } = makeWorld();
    const gate = new BoxCollider({ size: new Vector3(4, 1, 4), sensor: true });
    const gateBody = world.addBody(new Body({ type: 'static', position: new Vector3(0, 5, 0), colliders: [gate] }));
    const falling = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(0, 8, 0), colliders: [new SphereCollider({ radius: 0.5 })] }));
    const entered: [number, SensorEvent][] = [];
    const left: [number, SensorEvent][] = [];
    world.on('sensorEnter', (event) => entered.push([world.time, event]));
    world.on('sensorExit', (event) => left.push([world.time, event]));
    let pushed = false;
    world.on('contactBegin', (event) => {
      if (event.bodyA === gateBody || event.bodyB === gateBody) pushed = true;
    });
    runFor(world, 1.2);
    expect(pushed).toBe(false);
    expect(entered).toHaveLength(1);
    expect(left).toHaveLength(1);
    expect(entered[0]![1]).toMatchObject({ sensor: gate, sensorBody: gateBody, body: falling });
    // it reaches the top of the gate (y 5.5, its bottom 0.5 below its centre) after falling 2 m, and the bottom after 3 m
    expect(entered[0]![0]).toBeCloseTo(Math.sqrt((2 * 2) / 9.81), 1);
    expect(left[0]![0]).toBeCloseTo(Math.sqrt((2 * 4) / 9.81), 1);
    // unhindered: still falling at g
    expect(falling.velocity.y).toBeCloseTo(-9.81 * 1.2, 0);
  });

  it('keeps a body that fell asleep in a sensor inside it, until it is moved out', () => {
    const { world } = makeWorld();
    world.addBody(new Body({ type: 'static', position: new Vector3(0, 0.5, 0), colliders: [new BoxCollider({ size: new Vector3(3, 1, 3), sensor: true })] }));
    const resting = ball(world, new Vector3(0, 0.6, 0));
    let inside = 0;
    world.on('sensorEnter', () => inside++);
    world.on('sensorExit', () => inside--);
    runFor(world, 2);
    expect(resting.isSleeping).toBe(true);
    expect(inside).toBe(1);
    runFor(world, 1);
    expect(inside).toBe(1);
    resting.position.set(10, 0.5, 0);
    runFor(world, 0.2);
    expect(inside).toBe(0);
  });

  it('notices a kinematic sensor sweeping over resting bodies', () => {
    const { world } = makeWorld();
    const crates = [-2, 0, 2].map((across) => world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: new Vector3(across, 0.5, 4), canSleep: false, colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] })));
    const scanner = world.addBody(new Body({ type: 'kinematic', position: new Vector3(0, 1, -2), velocity: new Vector3(0, 0, 4), colliders: [new BoxCollider({ size: new Vector3(6, 2, 0.5), sensor: true })] }));
    const seen = new Set<Body>();
    world.on('sensorEnter', (event) => seen.add(event.body));
    runFor(world, 2);
    expect(scanner.position.z).toBeGreaterThan(5);
    expect(crates.every((crate) => seen.has(crate))).toBe(true);
    // passing through without disturbing them
    for (const crate of crates) expect(crate.position.z).toBeCloseTo(4, 3);
  });
});
