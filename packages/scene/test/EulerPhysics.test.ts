import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Scene, SphereGeometry, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EulerError } from '@eulerjs/core';
import type { Body } from '@eulerjs/core';
import { EulerPhysics } from '@eulerjs/scene';

const material = new MeshBasicMaterial();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EulerPhysics', () => {
  it("steps by itself, as three.js's physics addons do, and moves the meshes", async () => {
    const physics = await EulerPhysics();
    const scene = new Scene();
    const crate = new Mesh(new BoxGeometry(1, 1, 1), material);
    crate.position.y = 100;
    crate.userData.physics = { mass: 1 };
    scene.add(crate);
    physics.addScene(scene);
    vi.advanceTimersByTime(1000);
    // fallen about g t² / 2 in a second, give or take a step
    expect(100 - crate.position.y).toBeGreaterThan(4.5);
    expect(100 - crate.position.y).toBeLessThan(5.1);
    physics.dispose();
    const stoppedAt = crate.position.y;
    vi.advanceTimersByTime(1000);
    expect(crate.position.y).toBe(stoppedAt);
  });

  it('adds meshes with a mass and restitution, and removes them', async () => {
    const physics = await EulerPhysics();
    const ball = new Mesh(new SphereGeometry(0.5), material);
    physics.addMesh(ball, 2, 0.5);
    const body = ball.userData.physics.body as Body;
    expect(body.massProperties!.mass).toBeCloseTo(2, 12);
    expect(body.colliders[0]!.restitution).toBe(0.5);
    const wall = new Mesh(new BoxGeometry(1, 3, 1), material);
    physics.addMesh(wall);
    expect((wall.userData.physics.body as Body).type).toBe('static');
    physics.removeMesh(ball);
    expect(physics.world.bodies).toHaveLength(1);
    physics.dispose();
  });

  it('moves a mesh and stops it, sets its velocity and pushes it, an instance as well as a mesh', async () => {
    const physics = await EulerPhysics();
    const crate = new Mesh(new BoxGeometry(1, 1, 1), material);
    physics.addMesh(crate, 1);
    const body = crate.userData.physics.body as Body;
    body.velocity.set(3, 0, 0);
    physics.setMeshPosition(crate, new Vector3(4, 5, 6));
    expect(body.position.toArray()).toEqual([4, 5, 6]);
    expect(body.velocity.length()).toBe(0);
    // drawn there at once, not only from the next step
    expect(crate.position.toArray()).toEqual([4, 5, 6]);
    physics.setMeshVelocity(crate, new Vector3(0, 2, 0));
    expect(body.velocity.y).toBe(2);

    const balls = new InstancedMesh(new SphereGeometry(0.5), material, 2);
    balls.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, 0));
    balls.userData.physics = { mass: 2 };
    physics.addScene(balls);
    physics.applyImpulse(balls, new Vector3(4, 0, 0), 1);
    expect(physics.world.bodyOf(balls, 1)!.velocity.x).toBeCloseTo(2, 12);
    expect(physics.world.bodyOf(balls, 0)!.velocity.x).toBe(0);
    expect(() => physics.setMeshPosition(new Mesh(new BoxGeometry(), material), new Vector3())).toThrow(EulerError);
    physics.dispose();
  });

  it("lays a heightfield's heights out as three.js's terrain example draws them, on cells longer one way than the other", async () => {
    const physics = await EulerPhysics();
    // 6 by 3 cells over 12 m by 3 m, its heights rising along x and falling along z, as the example builds its terrain
    const width = 7;
    const depth = 4;
    const heights = new Float32Array(width * depth);
    for (let row = 0; row < depth; row++) for (let column = 0; column < width; column++) heights[row * width + column] = 0.3 * column - 0.5 * row;
    const geometry = new PlaneGeometry(12, 3, width - 1, depth - 1).rotateX(-Math.PI / 2);
    const vertices = geometry.getAttribute('position');
    for (let index = 0; index < vertices.count; index++) vertices.setY(index, heights[index]! * 2);
    const terrain = new Mesh(geometry, material);
    terrain.position.set(10, 1, -5);
    terrain.updateMatrixWorld();
    const body = physics.addHeightfield(terrain, width - 1, depth - 1, heights, { x: 12, y: 2, z: 3 });
    expect(terrain.userData.physics.body).toBe(body);
    // under every vertex of the mesh drawn, the terrain is as high as the vertex
    const vertex = new Vector3();
    for (let index = 0; index < vertices.count; index++) {
      vertex.fromBufferAttribute(vertices, index).add(terrain.position);
      const inside = vertex.clone().lerp(new Vector3(10, vertex.y, -5), 1e-3);
      const hit = physics.world.castRay(new Vector3(inside.x, 50, inside.z), new Vector3(0, -1, 0));
      expect(hit!.point.y).toBeCloseTo(vertex.y, 2);
    }
    expect(() => physics.addHeightfield(terrain, 2, 2, new Float32Array(8), { x: 1, y: 1, z: 1 })).toThrow(RangeError);
    physics.dispose();
  });
});
