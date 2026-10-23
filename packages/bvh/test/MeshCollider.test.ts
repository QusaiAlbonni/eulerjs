import type { BufferGeometry} from 'three';
import { BoxGeometry, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Raycaster, SphereGeometry, TorusKnotGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, CapsuleCollider, CylinderCollider, JavaScriptBackend, MassProperties, SphereCollider, World } from '@eulerjs/core';
import type { JavaScriptBackendOptions } from '@eulerjs/core';
import { MeshCollider } from '@eulerjs/bvh';

/** A flat square of ground, `size` across, cut into `cells` by `cells` squares of two triangles, facing up. */
function groundGeometry(size: number, cells: number): PlaneGeometry {
  return new PlaneGeometry(size, size, cells, cells).rotateX(-Math.PI / 2);
}

describe('mesh colliders', () => {
  it('marks the edges between flat neighbours as not pushing, and the border and folds as pushing', () => {
    const flat = new MeshCollider({ geometry: groundGeometry(4, 4) });
    expect(flat.triangleCount).toBe(32);
    // only the 16 edges round the border push
    const pushingEdges = [...flat.activeEdges].map((mask) => [0, 1, 2].filter((edge) => (mask >> edge) & 1).length);
    expect(pushingEdges.reduce((sum, count) => sum + count, 0)).toBe(16);
    const cube = new MeshCollider({ geometry: new BoxGeometry(1, 1, 1) });
    // each face is two triangles: their shared diagonal is flat, the cube's edges are folds
    for (const mask of cube.activeEdges) expect([0, 1, 2].filter((edge) => (mask >> edge) & 1)).toHaveLength(2);
  });

  it('casts rays where three.js does, against a twisted knot', () => {
    const geometry = new TorusKnotGeometry(1, 0.3, 64, 8);
    const world = new World({ gravity: new Vector3() });
    const position = new Vector3(0.5, -0.2, 0.3);
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.7);
    world.addBody(new Body({ type: 'static', position, quaternion, colliders: [new MeshCollider({ geometry })] }));
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
    mesh.position.copy(position);
    mesh.quaternion.copy(quaternion);
    mesh.updateMatrixWorld();
    let seed = 11;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    let hits = 0;
    for (let trial = 0; trial < 60; trial++) {
      const origin = new Vector3(random(), random(), random()).normalize().multiplyScalar(5);
      const direction = new Vector3(random(), random(), random()).multiplyScalar(0.8).sub(origin).normalize();
      const expected = new Raycaster(origin, direction).intersectObject(mesh)[0];
      const hit = world.castRay(origin, direction);
      if (!expected) {
        expect(hit).toBeUndefined();
        continue;
      }
      hits++;
      expect(hit!.distance).toBeCloseTo(expected.distance, 6);
      expect(hit!.normal.dot(direction)).toBeLessThan(0);
    }
    expect(hits).toBeGreaterThan(20);
  });

  it('meets shape casts and overlap tests', () => {
    const world = new World({ gravity: new Vector3() });
    const body = world.addBody(new Body({ type: 'static', colliders: [new MeshCollider({ geometry: groundGeometry(10, 5) })] }));
    expect(world.castShape(new SphereCollider({ radius: 0.5 }), new Vector3(0.3, 4, 0.2), new Vector3(0, -1, 0))!.distance).toBeCloseTo(3.5, 6);
    expect(world.castShape(new BoxCollider({ size: new Vector3(1, 1, 1) }), new Vector3(1.1, 3, -0.7), new Vector3(0, -1, 0))!.distance).toBeCloseTo(2.5, 6);
    expect(world.overlap(new SphereCollider({ radius: 0.5 }), new Vector3(0, 0.4, 0)).map((hit) => hit.body)).toEqual([body]);
    expect(world.overlap(new SphereCollider({ radius: 0.5 }), new Vector3(0, 0.6, 0))).toHaveLength(0);
  });

  it('gives back a geometry of its triangles to draw, its own copy', () => {
    const knot = new TorusKnotGeometry(1, 0.3, 32, 8);
    const collider = new MeshCollider({ geometry: knot });
    const drawn = collider.toGeometry();
    expect(drawn).not.toBe(knot);
    expect(Array.from(drawn.getAttribute('position').array)).toEqual(Array.from(knot.getAttribute('position').array));
    // the same triangles, wound the same way, though the tree has put them in its own order
    const triangles = (geometry: BufferGeometry) => {
      const index = Array.from(geometry.getIndex()!.array);
      const found: string[] = [];
      for (let start = 0; start < index.length; start += 3) {
        const corners = index.slice(start, start + 3);
        // each triangle from its lowest corner, keeping the winding
        const lowest = corners.indexOf(Math.min(...corners));
        found.push([0, 1, 2].map((offset) => corners[(lowest + offset) % 3]).join(','));
      }
      return found.sort();
    };
    expect(triangles(drawn)).toEqual(triangles(knot));
  });

  it('rejects a geometry without positions', () => {
    expect(() => new MeshCollider({ geometry: new BoxGeometry().deleteAttribute('position') })).toThrow(RangeError);
  });
});

describe.each<JavaScriptBackendOptions['solver']>(['xpbd', 'soft-step'])('mesh colliders in a world (%s)', (solver) => {
  const meshWorld = (geometry: ConstructorParameters<typeof MeshCollider>[0]['geometry'], friction = 0.5, quaternion?: Quaternion) => {
    const world = new World({ backend: new JavaScriptBackend({ solver }) });
    world.addBody(new Body({ type: 'static', quaternion, colliders: [new MeshCollider({ geometry, friction })] }));
    return world;
  };

  it('rests a ball, a box, a capsule and a cylinder on a mesh floor, asleep', () => {
    const world = meshWorld(groundGeometry(20, 10));
    const ball = world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(1.3, 1, 0.7), colliders: [new SphereCollider({ radius: 0.5 })] }));
    const crate = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: new Vector3(-3, 1, 1), colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
    const capsule = new CapsuleCollider({ radius: 0.25, length: 1 });
    const limb = world.addBody(new Body({ massProperties: capsule.massProperties({ density: 500 }), position: new Vector3(3, 1, -3), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), colliders: [capsule] }));
    const drumShape = new CylinderCollider({ radius: 0.5, height: 1 });
    const drum = world.addBody(new Body({ massProperties: drumShape.massProperties({ density: 500 }), position: new Vector3(-3, 1, -4), colliders: [drumShape] }));
    for (let step = 0; step < 300; step++) world.fixedStep();
    expect(ball.position.y).toBeCloseTo(0.5, 2);
    expect(crate.position.y).toBeCloseTo(0.5, 2);
    expect(limb.position.y).toBeCloseTo(0.25, 2);
    expect(drum.position.y).toBeCloseTo(0.5, 2);
    for (const body of [ball, crate, limb, drum]) expect(body.isSleeping).toBe(true);
  });

  it('rolls a ball down a tilted mesh at 5/7 g sin θ, across the triangles without catching on their edges', () => {
    const tilt = 0.25;
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt);
    const world = meshWorld(groundGeometry(40, 40), 0.9, turn);
    const up = new Vector3(0, 1, 0).applyQuaternion(turn);
    const downhill = new Vector3(-1, 0, 0).applyQuaternion(turn);
    const ball = world.addBody(
      new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(12, 0, 0.3).applyQuaternion(turn).addScaledVector(up, 0.5), canSleep: false, colliders: [new SphereCollider({ radius: 0.5, friction: 0.9, rollingResistance: 0 })] }),
    );
    for (let step = 0; step < 30; step++) world.fixedStep();
    const speedBefore = ball.velocity.dot(downhill);
    for (let step = 0; step < 60; step++) world.fixedStep();
    expect(Math.abs((ball.velocity.dot(downhill) - speedBefore) / ((5 / 7) * 9.81 * Math.sin(tilt)) - 1)).toBeLessThan(0.01);
    expect(ball.position.dot(up)).toBeCloseTo(0.5, 2);
  });

  it('keeps a ball rolling round inside a bowl, which is open and so solid on both sides, until it comes to rest', () => {
    // the bottom half of a sphere of radius 3, seen from inside
    const bowl = new SphereGeometry(3, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const world = meshWorld(bowl, 0.8);
    const ball = world.addBody(
      new Body({ massProperties: MassProperties.sphere(0.3, 1), position: new Vector3(1.5, -Math.sqrt(2.7 ** 2 - 1.5 ** 2), 0), canSleep: false, colliders: [new SphereCollider({ radius: 0.3, friction: 0.8, rollingResistance: 0.1 })] }),
    );
    let furthestOut = 0;
    let lowest = 0;
    for (let step = 0; step < 600; step++) {
      world.fixedStep();
      furthestOut = Math.max(furthestOut, ball.position.length());
      lowest = Math.min(lowest, ball.position.y);
    }
    // its centre stays a radius inside the bowl's surface, and it ends up resting at the bottom
    expect(furthestOut).toBeLessThan(2.7 + 0.01);
    expect(lowest).toBeGreaterThan(-2.7 - 0.01);
    expect(ball.position.y).toBeCloseTo(-2.7, 1);
  });
});
