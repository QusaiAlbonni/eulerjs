import { IcosahedronGeometry, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, CapsuleCollider, ConeCollider, ConvexCollider, CylinderCollider, DistanceJoint, JavaScriptBackend, MassProperties, PlaneCollider, SliderJoint, SphereCollider, World } from 'eulerjs';

function runFor(world: World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
}

function groundWorld(): World {
  const world = new World();
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
  return world;
}

const crate = (position: Vector3, options: { canSleep?: boolean; mass?: number } = {}) =>
  new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), options.mass ?? 10), position, canSleep: options.canSleep, colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] });

describe('sleeping', () => {
  it('puts a body to sleep once it has been still for a while, and leaves it exactly where it was', () => {
    const world = groundWorld();
    const box = world.addBody(crate(new Vector3(0, 0.5, 0)));
    runFor(world, 1);
    expect(box.isSleeping).toBe(true);
    const restingAt = box.position.clone();
    runFor(world, 5);
    expect(box.position.equals(restingAt)).toBe(true);
    expect(box.velocity.length()).toBe(0);
  });

  it('keeps bodies that may not sleep awake', () => {
    const world = groundWorld();
    const box = world.addBody(crate(new Vector3(0, 0.5, 0), { canSleep: false }));
    runFor(world, 2);
    expect(box.isSleeping).toBe(false);
  });

  it('does not put a moving body to sleep', () => {
    const world = new World({ gravity: new Vector3() });
    const drifting = world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1), velocity: new Vector3(0.1, 0, 0) }));
    runFor(world, 2);
    expect(drifting.isSleeping).toBe(false);
  });

  it('wakes a body when it is pushed, moved or given a velocity', () => {
    const world = groundWorld();
    const box = world.addBody(crate(new Vector3(0, 0.5, 0)));
    runFor(world, 1);
    box.applyImpulse(new Vector3(5, 0, 0));
    expect(box.isSleeping).toBe(false);
    runFor(world, 3);
    expect(box.isSleeping).toBe(true);
    box.setPose(new Vector3(0, 3, 0), box.quaternion);
    expect(box.isSleeping).toBe(false);
    runFor(world, 3);
    expect(box.isSleeping).toBe(true);
    box.velocity.set(0, 4, 0);
    world.fixedStep();
    expect(box.isSleeping).toBe(false);
    expect(box.position.y).toBeGreaterThan(0.5);
  });

  it('is woken by something running into it, and then knocked over', () => {
    const world = groundWorld();
    const box = world.addBody(crate(new Vector3(0, 0.5, 0)));
    runFor(world, 1);
    expect(box.isSleeping).toBe(true);
    world.addBody(new Body({ massProperties: MassProperties.sphere(0.3, 20), position: new Vector3(-3, 0.6, 0), velocity: new Vector3(8, 0, 0), colliders: [new SphereCollider({ radius: 0.3 })] }));
    runFor(world, 1);
    expect(box.position.x).toBeGreaterThan(0.2);
  });

  it('holds up a light body set gently on it without waking', () => {
    const world = groundWorld();
    const base = world.addBody(crate(new Vector3(0, 0.5, 0), { mass: 100 }));
    runFor(world, 1);
    expect(base.isSleeping).toBe(true);
    const top = world.addBody(crate(new Vector3(0, 1.5, 0), { mass: 1 }));
    runFor(world, 0.5);
    expect(base.isSleeping).toBe(true);
    expect(top.position.y).toBeCloseTo(1.5, 2);
  });

  it('wakes both ends of a joint together', () => {
    const world = new World({ gravity: new Vector3() });
    const first = world.addBody(new Body({ massProperties: MassProperties.sphere(0.2, 1) }));
    const second = world.addBody(new Body({ massProperties: MassProperties.sphere(0.2, 1), position: new Vector3(1, 0, 0) }));
    world.addJoint(new DistanceJoint({ bodyA: first, bodyB: second }));
    runFor(world, 1);
    expect(first.isSleeping && second.isSleeping).toBe(true);
    first.applyImpulse(new Vector3(0, 1, 0));
    world.fixedStep();
    expect(second.isSleeping).toBe(false);
    expect(second.velocity.length()).toBeGreaterThan(0);
  });

  it('puts bodies tied by a joint to sleep together, once all of them have settled', () => {
    // dropped from different heights, they come to rest at different times
    const world = groundWorld();
    const low = world.addBody(crate(new Vector3(0, 0.5, 0)));
    const high = world.addBody(crate(new Vector3(2, 3, 0)));
    const rope = world.addJoint(new DistanceJoint({ bodyA: low, bodyB: high, length: 3, slack: true }));
    runFor(world, 4);
    expect(low.isSleeping && high.isSleeping).toBe(true);
    expect(rope.tension).toBe(0);
  });

  it('puts a body to sleep that only trembles in place, however fast its velocity says it moves', () => {
    // a position-based solver can leave a body shaking by a fraction of a millimetre, back and forth every step
    const world = new World({ gravity: new Vector3() });
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1) }));
    let trembling = true;
    body.addBehavior({
      fixedUpdate: (target, _timestep, owner) => {
        if (trembling && !target.isSleeping) target.velocity.set(owner.stepCount % 2 === 0 ? 0.03 : -0.03, 0, 0);
      },
    });
    runFor(world, 1);
    expect(body.isSleeping).toBe(true);
    trembling = false;
    expect(body.position.length()).toBeLessThan(0.001);
  });

  it('keeps awake a body moving slowly but steadily away', () => {
    const world = new World({ gravity: new Vector3() });
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1) }));
    body.addBehavior({ fixedUpdate: (target) => target.velocity.set(0.02, 0, 0) });
    runFor(world, 2);
    expect(body.isSleeping).toBe(false);
  });

  it('wakes all of a jointed group before solving its contacts, so nothing resting on it is flung away', () => {
    // two light balls tied together and asleep, a heavy plank resting across them, a ball rolling into one
    const world = groundWorld();
    const ball = (position: Vector3, velocity?: Vector3) =>
      world.addBody(new Body({ massProperties: MassProperties.sphere(0.2, 0.5), position, velocity, colliders: [new SphereCollider({ radius: 0.2 })] }));
    const underCrate = ball(new Vector3(0, 0.2, 0));
    const tiedOn = ball(new Vector3(1, 0.2, 0));
    world.addJoint(new DistanceJoint({ bodyA: underCrate, bodyB: tiedOn }));
    const size = new Vector3(1.6, 0.2, 0.6);
    const crate = world.addBody(new Body({ massProperties: MassProperties.box(size, 200), position: new Vector3(0.5, 0.5, 0), colliders: [new BoxCollider({ size })] }));
    // they come to rest under the plank in about 1.5 s at 8 substeps, 3 s at the default 4
    runFor(world, 4);
    expect(underCrate.isSleeping && tiedOn.isSleeping && crate.isSleeping).toBe(true);
    ball(new Vector3(3, 0.2, 0), new Vector3(-2, 0, 0));
    let fastest = 0;
    for (let step = 0; step < 120; step++) {
      world.fixedStep();
      fastest = Math.max(fastest, underCrate.velocity.length(), crate.velocity.length());
    }
    expect(tiedOn.isSleeping || tiedOn.velocity.length() > 0).toBe(true);
    expect(fastest).toBeLessThan(3);
  });

  it('can be put to sleep by hand, which only works on dynamic bodies', () => {
    const body = new Body({ massProperties: MassProperties.sphere(1, 1), velocity: new Vector3(1, 0, 0) });
    body.sleep();
    expect(body.isSleeping).toBe(true);
    expect(body.velocity.length()).toBe(0);
    const platform = new Body({ type: 'kinematic' });
    platform.sleep();
    expect(platform.isSleeping).toBe(false);
  });
});

describe.each(['xpbd', 'soft-step'] as const)('sleeping in islands (%s)', (solver) => {
  it('keeps a box resting on a lift that never sleeps awake, so it rides up when the lift moves', () => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    const deckSize = new Vector3(1.4, 0.15, 1.4);
    const deck = world.addBody(new Body({ massProperties: MassProperties.box(deckSize, 120), position: new Vector3(0, 0.5, 0), canSleep: false, colliders: [new BoxCollider({ size: deckSize })] }));
    const lift = world.addJoint(new SliderJoint({ bodyA: deck, anchor: deck.position, axis: new Vector3(0, 1, 0), limits: { lower: 0, upper: 4 }, motor: { targetPosition: 0, stiffness: 40000, damping: 5000 } }));
    const box = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(0.5, 0.5, 0.5), 40), position: new Vector3(0, 0.83, 0), colliders: [new BoxCollider({ size: new Vector3(0.5, 0.5, 0.5) })] }));
    runFor(world, 3);
    // still, but touching a body that stays awake
    expect(box.isSleeping).toBe(false);
    lift.motor = { ...lift.motor, targetPosition: 3 };
    runFor(world, 4);
    expect(box.position.y).toBeGreaterThan(3.7);
  });

  it('keeps a box riding a moving kinematic platform awake, so it stays on as the platform turns back', () => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    const size = new Vector3(3, 0.2, 3);
    const platform = world.addBody(new Body({ type: 'kinematic', velocity: new Vector3(0.005, 0, 0), colliders: [new BoxCollider({ size })] }));
    const box = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(0.5, 0.5, 0.5), 10), position: new Vector3(0, 0.35, 0), colliders: [new BoxCollider({ size: new Vector3(0.5, 0.5, 0.5) })] }));
    // creeping slower than anything is woken by, for long enough to fall asleep if it could
    runFor(world, 2);
    expect(box.isSleeping).toBe(false);
    platform.velocity.set(-1, 0, 0);
    runFor(world, 1);
    expect(box.position.x).toBeLessThan(-0.8);
  });

  it('puts a heap of every shape to sleep once it has settled', () => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.6 })] }));
    // round shapes with the rolling resistance real ones have, or they would roll for ever; no
    // cylinders, which can roll on the rims of their ends for ever (see the test below)
    const shapes = [
      () => new BoxCollider({ size: new Vector3(0.8, 0.5, 0.6) }),
      () => new SphereCollider({ radius: 0.35, rollingResistance: 0.02 }),
      () => new CapsuleCollider({ radius: 0.2, length: 0.6, rollingResistance: 0.02 }),
      () => new ConeCollider({ radius: 0.3, height: 0.7, rollingResistance: 0.02 }),
      () => ConvexCollider.fromGeometry(new IcosahedronGeometry(0.4, 0)),
    ];
    const heap = Array.from({ length: 36 }, (_unused, index) => {
      const quaternion = new Quaternion().setFromAxisAngle(new Vector3(Math.sin(index), Math.cos(index * 1.7), 0.5).normalize(), index);
      const position = new Vector3(Math.sin(index * 2.3), 1 + index * 0.4, Math.cos(index * 1.9));
      return world.addBody(new Body({ position, quaternion, colliders: [shapes[index % shapes.length]!()], density: 500 }));
    });
    // the last of them lands from 15 m up; all asleep in about 20 s (soft step) or 25 s (XPBD)
    runFor(world, 30);
    expect(heap.filter((body) => !body.isSleeping)).toHaveLength(0);
  });

  // Known to fail under soft step (see TODO.md): rolling on the rim of its end, a cylinder gains
  // energy a little faster than rolling resistance takes it, and rolls on for ever instead of
  // falling flat. XPBD's hold on rolling hides the gain.
  (solver === 'soft-step' ? it.fails : it)('lays a cylinder tipped onto the rim of its end flat on its face, and puts it to sleep', () => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.6 })] }));
    const tipped = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (6 * Math.PI) / 180);
    const drum = world.addBody(new Body({ position: new Vector3(0, 0.37, 0), quaternion: tipped, colliders: [new CylinderCollider({ radius: 0.3, height: 0.7, rollingResistance: 0.02 })], density: 500 }));
    drum.angularVelocity.set(0, 2, 0);
    runFor(world, 12);
    expect(drum.isSleeping).toBe(true);
  });
});
