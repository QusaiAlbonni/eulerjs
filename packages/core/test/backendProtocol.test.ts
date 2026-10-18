import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, DistanceJoint, EulerError, JavaScriptBackend, MassProperties, SphereCollider, World } from '@eulerjs/core';
import type { Body as BodyType, BodyMotion, Joint, StepSettings } from '@eulerjs/core';

/** A JavaScript backend that records every call the world makes to it. */
class RecordingBackend extends JavaScriptBackend {
  readonly calls: string[] = [];
  readonly loads: { force: Vector3; torque: Vector3 }[] = [];
  lastSettings: StepSettings | undefined;
  disposed = false;

  override addBody(body: BodyType): void {
    this.calls.push('addBody');
    super.addBody(body);
  }
  override removeBody(body: BodyType): void {
    this.calls.push('removeBody');
    super.removeBody(body);
  }
  override updateBody(body: BodyType): void {
    this.calls.push('updateBody');
    super.updateBody(body);
  }
  override addJoint(joint: Joint): void {
    this.calls.push('addJoint');
    super.addJoint(joint);
  }
  override removeJoint(joint: Joint): void {
    this.calls.push('removeJoint');
    super.removeJoint(joint);
  }
  override writePose(body: BodyType): void {
    this.calls.push('writePose');
    super.writePose(body);
  }
  override writeVelocity(body: BodyType): void {
    this.calls.push('writeVelocity');
    super.writeVelocity(body);
  }
  override wakeUp(body: BodyType): void {
    this.calls.push('wakeUp');
    super.wakeUp(body);
  }
  override sleep(body: BodyType): void {
    this.calls.push('sleep');
    super.sleep(body);
  }
  override applyLoads(body: BodyType, force: Vector3, torque: Vector3): void {
    this.calls.push('applyLoads');
    this.loads.push({ force: force.clone(), torque: torque.clone() });
    super.applyLoads(body, force, torque);
  }
  override step(settings: StepSettings): void {
    this.calls.push('step');
    this.lastSettings = settings;
    super.step(settings);
  }
  override readMotion(body: BodyType, target: BodyMotion): void {
    super.readMotion(body, target);
  }
  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }

  /** The calls since the last `forget`, without the step and the reads every step makes. */
  writes(): string[] {
    return this.calls.filter((call) => call !== 'step');
  }

  forget(): void {
    this.calls.length = 0;
    this.loads.length = 0;
  }
}

function recordedWorld(options: { gravity?: Vector3 } = {}) {
  const backend = new RecordingBackend();
  const world = new World({ ...options, backend });
  return { backend, world };
}

const sphere = (options: { angularVelocity?: Vector3; canSleep?: boolean } = {}) =>
  new Body({ massProperties: MassProperties.box(new Vector3(1, 2, 3), 1), canSleep: false, ...options });

describe('the world talking to its backend', () => {
  it('uses the backend it is given, and steps it with its own settings', () => {
    const { backend, world } = recordedWorld();
    expect(world.backend).toBe(backend);
    world.fixedStep();
    expect(backend.lastSettings).toBe(world);
    expect(new World().backend).toBeInstanceOf(JavaScriptBackend);
  });

  it('writes nothing for bodies left alone, however long they tumble', () => {
    const { backend, world } = recordedWorld({ gravity: new Vector3() });
    world.addBody(sphere({ angularVelocity: new Vector3(0.3, 5, 0.2) }));
    backend.forget();
    for (let step = 0; step < 600; step++) world.fixedStep();
    expect(backend.writes()).toEqual([]);
  });

  it('writes the pose or the velocity, whichever you changed', () => {
    const { backend, world } = recordedWorld();
    const body = world.addBody(sphere());
    world.fixedStep();
    backend.forget();

    body.position.x += 1;
    world.fixedStep();
    expect(backend.writes()).toEqual(['writePose']);

    backend.forget();
    body.angularVelocity.set(0, 1, 0);
    world.fixedStep();
    expect(backend.writes()).toEqual(['writeVelocity']);

    backend.forget();
    body.setPose(new Vector3(), new Quaternion());
    world.fixedStep();
    expect(backend.writes()).toEqual(['writePose', 'wakeUp']);
  });

  it('writes changes behaviours make before the backend steps', () => {
    const { backend, world } = recordedWorld();
    const body = world.addBody(sphere());
    body.addBehavior({ fixedUpdate: (target) => target.velocity.set(1, 0, 0) });
    world.fixedStep();
    expect(backend.calls.indexOf('writeVelocity')).toBeLessThan(backend.calls.indexOf('step'));
    expect(body.position.x).toBeCloseTo(world.timestep, 12);
  });

  it('hands over the forces gathered in a step once, as one force and torque through the centre of mass', () => {
    const { backend, world } = recordedWorld({ gravity: new Vector3() });
    const body = world.addBody(sphere());
    world.addBody(sphere());
    backend.forget();
    body.applyForce(new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    body.applyForce(new Vector3(2, 0, 0));
    world.fixedStep();
    expect(backend.loads).toHaveLength(1);
    expect(backend.loads[0]!.force.toArray()).toEqual([3, 0, 0]);
    expect(backend.loads[0]!.torque.toArray()).toEqual([0, 0, -1]);
    backend.forget();
    world.fixedStep();
    expect(backend.loads).toHaveLength(0);
  });

  it('passes on wake and sleep requests', () => {
    const { backend, world } = recordedWorld();
    const body = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1) }));
    body.sleep();
    world.fixedStep();
    expect(backend.writes()).toContain('sleep');
    expect(body.isSleeping).toBe(true);
    backend.forget();
    body.wakeUp();
    world.fixedStep();
    expect(backend.writes()).toEqual(['wakeUp']);
    expect(body.isSleeping).toBe(false);
  });

  it('tells the backend when a body changes shape or mass', () => {
    const { backend, world } = recordedWorld();
    const body = world.addBody(sphere());
    const collider = body.addCollider(new SphereCollider({ radius: 1 }));
    body.addCollider(collider);
    body.removeCollider(collider);
    body.setMass(2);
    expect(backend.calls.filter((call) => call === 'updateBody')).toHaveLength(3);
  });

  it('removes the joints on a body before the body', () => {
    const { backend, world } = recordedWorld();
    const body = world.addBody(sphere());
    world.addJoint(new DistanceJoint({ bodyA: body, anchorB: new Vector3(0, 1, 0) }));
    backend.forget();
    world.removeBody(body);
    expect(backend.calls).toEqual(['removeJoint', 'removeBody']);
    expect(world.joints).toHaveLength(0);
    expect(body.world).toBeUndefined();
  });

  it('refuses a joint whose bodies are not in the world, without telling the backend', () => {
    const { backend, world } = recordedWorld();
    const outsider = new Body({ massProperties: MassProperties.sphere(0.5, 1) });
    expect(() => world.addJoint(new DistanceJoint({ bodyA: outsider, anchorB: new Vector3() }))).toThrow(EulerError);
    expect(backend.calls).not.toContain('addJoint');
  });

  it('disposes the backend with the world', () => {
    const { backend, world } = recordedWorld();
    world.addBody(sphere());
    world.dispose();
    expect(backend.disposed).toBe(true);
  });
});

describe('JavaScriptBackend', () => {
  it('refuses kinds of joint it does not know', () => {
    const backend = new JavaScriptBackend();
    class GearJoint {
      readonly bodies = [];
    }
    expect(() => backend.addJoint(new GearJoint() as unknown as Joint)).toThrow(/can't simulate a GearJoint/);
  });

  it('refuses bodies it was never given', () => {
    const backend = new JavaScriptBackend();
    expect(() => backend.writePose(sphere())).toThrow(EulerError);
    backend.removeBody(sphere());
  });
});
