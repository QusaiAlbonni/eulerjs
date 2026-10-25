import { BoxGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, DodecahedronGeometry, IcosahedronGeometry, Mesh, MeshBasicMaterial, Raycaster, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { describe, expect, it } from 'vitest';
import { World } from '@eulerjs/core';
import { ScenePhysics } from '@eulerjs/scene';

/** Directions spread evenly over the sphere. */
const directions = Array.from({ length: 600 }, (_unused, index) => {
  const upward = 1 - (2 * (index + 0.5)) / 600;
  const around = index * Math.PI * (3 - Math.sqrt(5));
  const across = Math.sqrt(1 - upward * upward);
  return new Vector3(Math.cos(around) * across, upward, Math.sin(around) * across);
});

/** three.js's convex geometries, from smooth to coarse, with the size to measure their fit against. */
const geometries: [string, BufferGeometry, number][] = [
  ['a box', new BoxGeometry(1, 1, 1), 0.5],
  ['a rounded box', new RoundedBoxGeometry(1, 1, 1, 2, 0.25), 0.5],
  ['the default sphere', new SphereGeometry(0.5), 0.5],
  ['a 16 by 8 sphere', new SphereGeometry(0.5, 16, 8), 0.5],
  ['an 8 by 6 sphere', new SphereGeometry(0.5, 8, 6), 0.5],
  ['the default icosahedron', new IcosahedronGeometry(0.5), 0.5],
  ['an icosahedron of detail 2', new IcosahedronGeometry(0.5, 2), 0.5],
  ['an icosahedron of detail 4', new IcosahedronGeometry(0.5, 4), 0.5],
  ['the default cylinder', new CylinderGeometry(0.5, 0.5, 1), 0.5],
  ['a 16-sided cylinder', new CylinderGeometry(0.5, 0.5, 1, 16), 0.5],
  ['an 8-sided cylinder', new CylinderGeometry(0.5, 0.5, 1, 8), 0.5],
  ['the default cone', new ConeGeometry(0.5, 1), 0.5],
  ['an 8-sided cone', new ConeGeometry(0.5, 1, 8), 0.5],
  ['the default capsule', new CapsuleGeometry(0.3, 1), 0.3],
  ['a smooth capsule', new CapsuleGeometry(0.3, 1, 8, 32), 0.3],
  ['a dodecahedron', new DodecahedronGeometry(0.5), 0.5],
];

describe('what a geometry collides as', () => {
  it.each(geometries)('is where %s is drawn, to within 2 percent of its size', (_name, geometry, radius) => {
    const world = new World();
    const shape = new Mesh(geometry, new MeshBasicMaterial());
    world.use(new ScenePhysics()).addObject(shape, { mass: 1 });
    const rays = new Raycaster();
    let mostOut = 0;
    let mostIn = 0;
    for (const direction of directions) {
      const origin = direction.clone().multiplyScalar(5);
      const inward = direction.clone().negate();
      rays.set(origin, inward);
      const drawn = rays.intersectObject(shape)[0]!;
      const collides = world.castRay(origin, inward)!;
      // how far apart the two surfaces are, square to the drawn one: a ray crossing it aslant spans more
      const apart = (drawn.distance - collides.distance) * Math.abs(drawn.face!.normal.dot(inward));
      mostOut = Math.max(mostOut, apart);
      mostIn = Math.max(mostIn, -apart);
    }
    // sticking out, things rest on it in the air; inside, they sink into it
    expect(mostOut).toBeLessThan(0.02 * radius);
    expect(mostIn).toBeLessThan(0.02 * radius);
  });
});
