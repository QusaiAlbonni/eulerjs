import { BoxGeometry, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, MassProperties, PlaneCollider, World } from '@eulerjs/core';
import { expectVectorClose } from '../helpers.js';

const TIMESTEP = 1 / 120;

function worldWithoutGravity(): World {
  return new World({ gravity: new Vector3(0, 0, 0), timestep: TIMESTEP });
}

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  const steps = Math.round(seconds / world.timestep);
  for (let step = 0; step < steps; step++) {
    eachStep?.();
    world.fixedStep();
  }
}

function worldInertia(body: Body): Matrix3 {
  const rotation = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(body.quaternion));
  return rotation.clone().multiply(body.massProperties!.inertia).multiply(rotation.clone().transpose());
}

function angularMomentum(body: Body): Vector3 {
  return body.angularVelocity.clone().applyMatrix3(worldInertia(body));
}

function rotationalEnergy(body: Body): number {
  return 0.5 * body.angularVelocity.dot(angularMomentum(body));
}

describe('linear motion', () => {
  it('falls exactly as semi-implicit Euler predicts', () => {
    const world = new World({ timestep: TIMESTEP });
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 2) }));
    const steps = 120;
    runFor(world, steps * TIMESTEP);
    // v_n = -g n dt, y_n = sum of v_k dt = -g dt² n(n + 1) / 2
    expect(body.velocity.y).toBeCloseTo(-9.81 * steps * TIMESTEP, 10);
    expect(body.position.y).toBeCloseTo((-9.81 * TIMESTEP ** 2 * steps * (steps + 1)) / 2, 10);
  });

  it('stays within 1% of the continuous free-fall solution after one second', () => {
    const world = new World({ timestep: TIMESTEP });
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 2) }));
    runFor(world, 1);
    expect(Math.abs(body.position.y / (-0.5 * 9.81) - 1)).toBeLessThan(0.01);
  });

  it('accelerates by F / m under a constant force', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 4) }));
    runFor(world, 1, () => body.applyForce(new Vector3(8, 0, 0)));
    expect(body.velocity.x).toBeCloseTo(2, 10);
  });

  it('applies forces of any size, with no hidden cap', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1000) }));
    body.applyForce(new Vector3(0, 2e7, 0));
    world.fixedStep();
    expect(body.velocity.y).toBeCloseTo((2e7 / 1000) * TIMESTEP, 9);
  });

  it('decays velocity exponentially with linear damping', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(
      new Body({ massProperties: MassProperties.sphere(1, 1), velocity: new Vector3(10, 0, 0), linearDamping: 0.5 }),
    );
    runFor(world, 2);
    expect(body.velocity.x).toBeCloseTo(10 * Math.exp(-0.5 * 2), 10);
  });

  it('scales gravity per body', () => {
    const world = new World({ timestep: TIMESTEP });
    const floating = world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1), gravityScale: 0 }));
    const heavy = world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1), gravityScale: 2 }));
    world.fixedStep();
    expect(floating.velocity.y).toBe(0);
    expect(heavy.velocity.y).toBeCloseTo(-2 * 9.81 * TIMESTEP, 12);
  });
});

describe('rotation about the centre of mass', () => {
  const offsetBox = () => MassProperties.fromMesh(new BoxGeometry(2, 4, 6).translate(5, 0, 0), { mass: 48 });

  it('does not rotate when a force acts through an off-origin centre of mass', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: offsetBox() }));
    runFor(world, 1, () => body.applyForce(new Vector3(0, 100, 0), body.worldCenterOfMass));
    expect(body.angularVelocity.length()).toBeLessThan(1e-12);
    expect(body.velocity.y).toBeCloseTo(100 / 48, 10);
  });

  it('turns about the centre of mass, not about the frame origin', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: offsetBox(), angularVelocity: new Vector3(0, 2, 0) }));
    const centerBefore = body.worldCenterOfMass.clone();
    runFor(world, 3);
    expectVectorClose(body.worldCenterOfMass, centerBefore, 1e-9);
    // the frame origin, 5 m from the centre of mass, has swung around it
    expect(body.position.distanceTo(centerBefore)).toBeCloseTo(5, 9);
    expect(body.position.distanceTo(new Vector3())).toBeGreaterThan(1);
  });

  it('produces the angular acceleration I⁻¹ (r × F) for an off-centre force', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(2, 4, 6), 48) }));
    body.applyForce(new Vector3(0, 10, 0), new Vector3(1, 0, 0));
    world.fixedStep();
    // torque (0, 0, 10) about z, Izz = 80
    expectVectorClose(body.angularVelocity, new Vector3(0, 0, (10 / 80) * TIMESTEP), 1e-12);
  });

  it('decays spin exponentially with angular damping', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(
      new Body({ massProperties: MassProperties.sphere(1, 1), angularVelocity: new Vector3(0, 4, 0), angularDamping: 1 }),
    );
    runFor(world, 1);
    expect(body.angularVelocity.y).toBeCloseTo(4 * Math.exp(-1), 10);
  });

  it('decays the spin of a body the solver is correcting with angular damping too', () => {
    // on frictionless ground, contacts correct the box every substep and only the damping slows its spin
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0 })] }));
    const size = new Vector3(1, 1, 1);
    const body = world.addBody(
      new Body({ massProperties: MassProperties.box(size, 1), position: new Vector3(0, 0.5, 0), angularVelocity: new Vector3(0, 4, 0), angularDamping: 1, canSleep: false, colliders: [new BoxCollider({ size, friction: 0 })] }),
    );
    runFor(world, 1);
    expect(Math.abs(body.angularVelocity.y / (4 * Math.exp(-1)) - 1)).toBeLessThan(0.01);
  });

  it('integrates a steady spin exactly', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(1, 1), angularVelocity: new Vector3(0, Math.PI, 0) }));
    runFor(world, 0.5);
    const quarterTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(body.quaternion.angleTo(quarterTurn)).toBeLessThan(1e-9);
  });
});

describe('torque-free rotation of an uneven body', () => {
  const unevenBox = () => MassProperties.box(new Vector3(1, 2, 3), 6); // Ixx 6.5 > Iyy 5 > Izz 2.5

  it('conserves angular momentum, whose direction a gyroscope-free integrator lets drift', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: unevenBox(), angularVelocity: new Vector3(1, 3, 0.2) }));
    const momentumBefore = angularMomentum(body);
    runFor(world, 5);
    const momentumAfter = angularMomentum(body);
    const directionDriftDegrees = (momentumBefore.angleTo(momentumAfter) * 180) / Math.PI;
    expect(directionDriftDegrees).toBeLessThan(0.01);
    expect(Math.abs(momentumAfter.length() / momentumBefore.length() - 1)).toBeLessThan(1e-9);
  });

  it('conserves rotational energy, even when spinning fast', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: unevenBox(), angularVelocity: new Vector3(10, 30, 2) }));
    const energyBefore = rotationalEnergy(body);
    runFor(world, 5);
    expect(Math.abs(rotationalEnergy(body) / energyBefore - 1)).toBeLessThan(1e-9);
  });

  it('flips over when spun about its intermediate axis (Dzhanibekov effect)', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: unevenBox(), angularVelocity: new Vector3(0.01, 5, 0.01) }));
    const bodyFrameSpin = new Vector3();
    let flipped = false;
    runFor(world, 10, () => {
      bodyFrameSpin.copy(body.angularVelocity).applyQuaternion(body.quaternion.clone().invert());
      if (bodyFrameSpin.y < 0) flipped = true;
    });
    expect(flipped).toBe(true);
  });

  it('spins steadily about a principal axis without wobbling', () => {
    const world = worldWithoutGravity();
    const body = world.addBody(new Body({ massProperties: unevenBox(), angularVelocity: new Vector3(0, 0, 4) }));
    runFor(world, 5);
    expectVectorClose(body.angularVelocity, new Vector3(0, 0, 4), 1e-9);
  });
});

describe('body types', () => {
  it('moves a kinematic body with its velocity and ignores forces and gravity', () => {
    const world = new World({ timestep: TIMESTEP });
    const platform = world.addBody(new Body({ type: 'kinematic', velocity: new Vector3(1, 0, 0) }));
    runFor(world, 1, () => platform.applyForce(new Vector3(0, 1e6, 0)));
    expectVectorClose(platform.position, new Vector3(1, 0, 0), 1e-9);
    expect(platform.velocity.y).toBe(0);
  });

  it('never moves a static body', () => {
    const world = new World({ timestep: TIMESTEP });
    const ground = world.addBody(new Body({ type: 'static', velocity: new Vector3(5, 0, 0) }));
    ground.applyImpulse(new Vector3(100, 0, 0));
    runFor(world, 1);
    expectVectorClose(ground.position, new Vector3());
  });
});
