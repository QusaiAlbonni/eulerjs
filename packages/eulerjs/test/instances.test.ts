import { BoxGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, EulerError, PlaneCollider, SphereCollider, World } from 'eulerjs';
import { expectVectorClose } from './helpers.js';

/** Bodies drawn as the instances of an InstancedMesh. */

const crateSize = new Vector3(1, 0.5, 0.8);

/** Crates in a row along x, each turned a little more about y, the third twice the size. */
function crates(count = 4): InstancedMesh {
  const mesh = new InstancedMesh(new BoxGeometry(crateSize.x, crateSize.y, crateSize.z), new MeshBasicMaterial(), count);
  for (let index = 0; index < count; index++) {
    const scale = index === 2 ? 2 : 1;
    mesh.setMatrixAt(index, new Matrix4().compose(new Vector3(index * 3, 2, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), index * 0.4), new Vector3(scale, scale, scale)));
  }
  return mesh;
}

function groundedWorld(): World {
  const world = new World();
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
  return world;
}

const instancePosition = (mesh: InstancedMesh, index: number) => {
  const matrix = new Matrix4();
  mesh.getMatrixAt(index, matrix);
  return new Vector3().setFromMatrixPosition(matrix);
};

describe('instanced bodies', () => {
  it('makes a body for every instance, where the instance is, fitted and weighed with its scale', () => {
    const world = groundedWorld();
    const mesh = crates();
    // inside a group that is moved: the instances are in the mesh's frame, the bodies in the world's
    const group = new Group();
    group.position.set(0, 0, 5);
    group.add(mesh);
    const bodies = world.addInstances(mesh, { density: 100, collider: 'box' });
    expect(bodies).toHaveLength(4);
    // instance matrices are 32-bit floats: poses read from them hold to about a millionth
    bodies.forEach((body, index) => {
      expect(body.instance).toEqual({ mesh, index });
      expectVectorClose(body.position, new Vector3(index * 3, 2, 5), 1e-5);
      expect(body.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), index * 0.4))).toBeLessThan(1e-6);
    });
    const volume = crateSize.x * crateSize.y * crateSize.z;
    expect(bodies[0]!.mass).toBeCloseTo(100 * volume, 4);
    // twice the size: eight times the mass, and a box collider twice as big
    expect(bodies[2]!.mass).toBeCloseTo(800 * volume, 4);
    expectVectorClose((bodies[2]!.colliders[0] as BoxCollider).halfExtents, crateSize.clone(), 1e-5);
    // each its own collider
    expect(new Set(bodies.map((body) => body.colliders[0])).size).toBe(4);
  });

  it('draws each instance where its body is, interpolated between steps, keeping its scale', () => {
    const world = groundedWorld();
    const mesh = crates();
    const bodies = world.addInstances(mesh, { mass: 10, collider: 'box' });
    // a second and a bit of frames, the last ending part way through a step
    for (let frame = 0; frame < 70; frame++) world.update(1 / 60);
    world.update(0.007);
    bodies.forEach((body, index) => {
      const matrix = new Matrix4();
      mesh.getMatrixAt(index, matrix);
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      matrix.decompose(position, quaternion, scale);
      const drawnAt = new Vector3().lerpVectors(body.previousPosition, body.position, world.interpolationAlpha);
      expectVectorClose(position, drawnAt, 1e-5);
      expectVectorClose(scale, new Vector3(1, 1, 1).multiplyScalar(index === 2 ? 2 : 1), 1e-6);
    });
    // they fell to the ground
    expect(instancePosition(mesh, 0).y).toBeCloseTo(crateSize.y / 2, 2);
    // and the mesh's bounds are to be found afresh, so three.js doesn't cull them where they were
    expect(mesh.boundingSphere).toBeNull();
  });

  it('leaves the instances alone once their bodies sleep, so a still scene uploads nothing', () => {
    const world = groundedWorld();
    const mesh = crates();
    const bodies = world.addInstances(mesh, { mass: 10, collider: 'box' });
    for (let frame = 0; frame < 300; frame++) world.update(1 / 60);
    expect(bodies.every((body) => body.isSleeping)).toBe(true);
    const version = mesh.instanceMatrix.version;
    for (let frame = 0; frame < 10; frame++) world.update(1 / 60);
    expect(mesh.instanceMatrix.version).toBe(version);
    // until one wakes
    bodies[1]!.applyImpulse(new Vector3(0, 30, 0));
    world.update(1 / 60);
    expect(mesh.instanceMatrix.version).toBeGreaterThan(version);
  });

  it('takes colliders made for each instance, and finds the body of an instance a raycast hits', () => {
    const world = groundedWorld();
    const mesh = crates(3);
    const bodies = world.addInstances(mesh, { mass: 5, collider: (index) => new SphereCollider({ radius: 0.3 + index * 0.1 }) });
    expect(bodies.map((body) => (body.colliders[0] as SphereCollider).radius)).toEqual([0.3, 0.4, 0.5]);
    mesh.updateMatrixWorld();
    const hits = new Raycaster(new Vector3(3, 10, 0), new Vector3(0, -1, 0)).intersectObject(mesh);
    expect(hits[0]?.instanceId).toBe(1);
    expect(world.bodyOf(hits[0]!.object, hits[0]!.instanceId)).toBe(bodies[1]);
    world.removeBody(bodies[1]!);
    expect(world.bodyOf(mesh, 1)).toBeUndefined();
  });

  it('refuses to make one body of a whole InstancedMesh, or two of one instance', () => {
    const world = groundedWorld();
    const mesh = crates();
    expect(() => world.addBody(mesh, { collider: 'box' })).toThrow(/addInstances/);
    world.addBody(new Body({ instance: { mesh, index: 0 }, colliders: [new BoxCollider({ size: crateSize })], mass: 1 }));
    expect(() => world.addBody(new Body({ instance: { mesh, index: 0 }, colliders: [new BoxCollider({ size: crateSize })], mass: 1 }))).toThrow(EulerError);
  });
});
