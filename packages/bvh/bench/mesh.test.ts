import { PlaneGeometry, Vector3 } from 'three';
import { it } from 'vitest';
import { Body, MassProperties, SphereCollider, World } from '@eulerjs/core';
import { MeshCollider } from '@eulerjs/bvh';
import { benchmarkBackend, runSeconds, timeStep } from '../../core/bench/scenes.js';

// Not pass/fail: prints what triangle meshes cost. Run with `npm run bench`.

const report = (line: string) => process.stdout.write(`${line}\n`);

/** Rolling ground as a mesh of `cells` by `cells` squares, two triangles each, 1 m across. */
function hillyMesh(cells: number): PlaneGeometry {
  const geometry = new PlaneGeometry(cells, cells, cells, cells).rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  for (let index = 0; index < positions.count; index++) positions.setY(index, 2 * Math.sin(positions.getZ(index) / 6) * Math.cos(positions.getX(index) / 7));
  return geometry;
}

it('reports triangle mesh cost', () => {
  const world = new World({ backend: benchmarkBackend() });
  const started = performance.now();
  const ground = new MeshCollider({ geometry: hillyMesh(128) });
  report(`MESH building a 128 by 128 mesh collider (${ground.triangleCount} triangles): ${(performance.now() - started).toFixed(0)} ms`);
  world.addBody(new Body({ type: 'static', colliders: [ground] }));
  for (let index = 0; index < 200; index++) {
    world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position: new Vector3(((index % 20) - 10) * 2.5, 5, (Math.floor(index / 20) - 5) * 2.5), canSleep: false, colliders: [new SphereCollider({ radius: 0.5 })] }));
  }
  runSeconds(world, 2);
  const stepTime = timeStep(() => world.fixedStep());
  report(`MESH 200 balls rolling on it: ${stepTime.toFixed(2)} ms per step, ${(stepTime / world.timestep).toFixed(0)} ms per simulated second`);
  const rays = Array.from({ length: 1000 }, (_unused, index) => new Vector3(((index * 37) % 120) - 60, 10, ((index * 53) % 120) - 60));
  const down = new Vector3(0, -1, 0);
  const rayTime = (timeStep(() => {
    for (const origin of rays) world.castRay(origin, down);
  }, 7, 1) * 1000) / rays.length;
  report(`MESH ray down onto it: ${rayTime.toFixed(1)} µs`);
}, 600_000);
