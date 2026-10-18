import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, CapsuleCollider, JavaScriptBackend, MassProperties, PlaneCollider, SphereCollider, World } from 'eulerjs';

const gravity = 9.81;

function runFor(world: World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
}

/**
 * A solid ball of radius 0.5 rolling on ground tilted by `tilt` about z, with the given rolling
 * resistance on the ball. At the accurate setting, 8 substeps, since these check the model; the
 * default's accuracy is tracked in defaultQuality.test.ts.
 */
function ballOnGround(rollingResistance: number, tilt = 0, velocity = new Vector3()) {
  const world = new World({ substeps: 8 });
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt);
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8, rotation })] }));
  const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
  const ball = world.addBody(
    new Body({
      massProperties: MassProperties.sphere(0.5, 1),
      position: up.clone().multiplyScalar(0.5),
      velocity,
      angularVelocity: new Vector3(velocity.z, 0, -velocity.x).divideScalar(0.5),
      canSleep: false,
      colliders: [new SphereCollider({ radius: 0.5, friction: 0.8, rollingResistance })],
    }),
  );
  return { world, ball, downhill: new Vector3(-Math.cos(tilt), -Math.sin(tilt), 0) };
}

describe('rolling resistance', () => {
  it('slows a rolling ball at c g / (1 + I / m r²), and does nothing when it is 0', () => {
    for (const coefficient of [0.02, 0.05]) {
      const { world, ball } = ballOnGround(coefficient, 0, new Vector3(3, 0, 0));
      runFor(world, 0.5);
      const speedBefore = ball.velocity.x;
      runFor(world, 1);
      expect(Math.abs((speedBefore - ball.velocity.x) / ((coefficient * gravity) / 1.4) - 1)).toBeLessThan(0.02);
    }
    const free = ballOnGround(0, 0, new Vector3(3, 0, 0));
    runFor(free.world, 2);
    // without it the ball rolls on, losing only the solver's own fraction of a percent
    expect(free.ball.velocity.x).toBeGreaterThan(2.98);
  });

  it('holds a ball on a slope while tan θ < c, and rolls it at g (sin θ - c cos θ) / (1 + I / m r²) once steeper', () => {
    const holding = ballOnGround(0.05, 0.03);
    runFor(holding.world, 2);
    expect(holding.ball.position.distanceTo(new Vector3(0, 0.5, 0).applyAxisAngle(new Vector3(0, 0, 1), 0.03))).toBeLessThan(0.002);

    const tilt = 0.12;
    const rolling = ballOnGround(0.05, tilt);
    runFor(rolling.world, 0.5);
    const speedBefore = rolling.ball.velocity.dot(rolling.downhill);
    runFor(rolling.world, 1);
    const expected = (gravity * (Math.sin(tilt) - 0.05 * Math.cos(tilt))) / 1.4;
    expect(Math.abs((rolling.ball.velocity.dot(rolling.downhill) - speedBefore) / expected - 1)).toBeLessThan(0.02);
  });

  it.each(['xpbd', 'soft-step'] as const)('slows a ball spinning on the spot as it slows one rolling, and lets it fall asleep (%s)', (solver) => {
    const world = new World({ substeps: 8, backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8 })] }));
    const spinning = (rollingResistance: number) =>
      world.addBody(
        new Body({
          massProperties: MassProperties.sphere(0.5, 1),
          position: new Vector3(rollingResistance * 500, 0.5, 0),
          angularVelocity: new Vector3(0, 3, 0),
          colliders: [new SphereCollider({ radius: 0.5, friction: 0.8, rollingResistance })],
        }),
      );
    const resisted = spinning(0.01);
    const free = spinning(0);
    runFor(world, 2);
    // like a top on the floor: a torque of c m g r against the spin, over I = 2/5 m r²
    const slowing = (0.01 * gravity * 0.5) / (0.4 * 0.25);
    expect(resisted.angularVelocity.y / (3 - 2 * slowing)).toBeCloseTo(1, 1);
    // a point of contact can't resist a spin on the spot: only rolling resistance does
    expect(free.angularVelocity.y).toBeCloseTo(3, 2);
    runFor(world, 8);
    expect(resisted.isSleeping).toBe(true);
    expect(free.isSleeping).toBe(false);
  });

  it('brings a capsule rolling on its side to rest, and leaves boxes alone', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8, rollingResistance: 0.05 })] }));
    const shape = new CapsuleCollider({ radius: 0.1, length: 0.5, friction: 0.8 });
    const lying = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const capsule = world.addBody(new Body({ massProperties: shape.massProperties({ mass: 2 }), position: new Vector3(0, 0.1, 0), quaternion: lying, velocity: new Vector3(0, 0, 1), angularVelocity: new Vector3(10, 0, 0), colliders: [shape] }));
    runFor(world, 4);
    expect(capsule.isSleeping).toBe(true);
    expect(capsule.position.z).toBeGreaterThan(0.3);
  });
});
