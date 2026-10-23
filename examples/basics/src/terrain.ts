import { ConeGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, TorusKnotGeometry, Vector3 } from 'three';
import { Body, ConeCollider, CylinderCollider, HeightfieldCollider, SphereCollider, World } from '@eulerjs/core';
import type { Collider } from '@eulerjs/core';
import { MeshCollider } from '@eulerjs/bvh';
import { createStage, run } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(22, 16, 26), lookAt: new Vector3(0, 0, 0) });
const world = new World();

// Rolling hills from a grid of heights, 64 m across. The mesh is the heightfield's own geometry,
// so what you see is what things roll on.
const cells = 64;
const heights = Array.from({ length: cells + 1 }, (_unused, row) =>
  Array.from({ length: cells + 1 }, (_unused2, column) => 3 * Math.sin(row / 7) * Math.cos(column / 9) + 0.08 * (row + column)),
);
const terrain = new HeightfieldCollider({ heights, cellSize: 1, friction: 0.8 });
world.addBody(new Body({ type: 'static', colliders: [terrain] }));
stage.scene.add(new Mesh(terrain.toGeometry(), new MeshStandardMaterial({ color: 0x6b8e5a, flatShading: true })));

// A sculpture, any triangle mesh, as a static collider: things land on it and fall through its loops.
const knot = new TorusKnotGeometry(3, 0.8, 128, 16);
const sculpture = new Mesh(knot, new MeshStandardMaterial({ color: 0xb48ead, metalness: 0.3, roughness: 0.4 }));
sculpture.position.set(-12, terrain.surfaceHeight(-12, 8)! + 5, 8);
stage.scene.add(sculpture);
world.addBody(new Body({ type: 'static', position: sculpture.position, colliders: [new MeshCollider({ geometry: knot, friction: 0.5 })] }));

// Barrels, traffic cones and balls dropped on the high side, to roll down the hills.
const barrelGeometry = new CylinderGeometry(0.4, 0.4, 1, 24);
const coneGeometry = new ConeGeometry(0.35, 0.8, 20);
const ballGeometry = new SphereGeometry(0.35, 20, 12);
const kinds: [Mesh['geometry'], number, () => Collider][] = [
  [barrelGeometry, 0x5e81ac, () => new CylinderCollider({ radius: 0.4, height: 1, friction: 0.7 })],
  [coneGeometry, 0xd08770, () => new ConeCollider({ radius: 0.35, height: 0.8, friction: 0.7 })],
  [ballGeometry, 0xebcb8b, () => new SphereCollider({ radius: 0.35, friction: 0.7 })],
];
let dropped = 0;
let sinceDrop = 0;
/** What has been dropped, to take away whatever rolls off the edge of the hills and falls for ever. */
const loose = new Map<Body, Mesh>();
function drop(): void {
  const [geometry, color, collider] = kinds[dropped % kinds.length]!;
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color }));
  // most on the hills, every fourth over the sculpture
  const overSculpture = dropped % 4 === 3;
  const across = overSculpture ? -12 + Math.sin(dropped) : 20 + 8 * Math.sin(dropped * 1.3);
  const along = overSculpture ? 8 + Math.cos(dropped) : 20 + 8 * Math.cos(dropped * 0.7);
  mesh.position.set(across, overSculpture ? sculpture.position.y + 6 : terrain.surfaceHeight(across, along)! + 2, along);
  mesh.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 1).normalize(), dropped));
  stage.scene.add(mesh);
  loose.set(world.addBody(mesh, { density: 400, collider: collider() }), mesh);
  dropped++;
}

run(stage, world, (frameDelta) => {
  sinceDrop += frameDelta;
  if (sinceDrop > 0.4 && dropped < 120) {
    sinceDrop = 0;
    drop();
  }
  for (const [body, mesh] of loose) {
    if (body.position.y > -50) continue;
    world.removeBody(body);
    stage.scene.remove(mesh);
    loose.delete(body);
  }
});
