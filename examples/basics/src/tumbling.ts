import { AxesHelper, BoxGeometry, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { World } from 'eulerjs';
import { createStage, run } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 3, 13), lookAt: new Vector3(0, 0, 0) });

// Nothing pulls on these bodies, so all that moves them is how they were spun.
const world = new World({ gravity: new Vector3(0, 0, 0) });

// A 1 × 2 × 3 box: easiest to spin about its long z axis, hardest about x, in between about y.
const geometry = new BoxGeometry(1, 2, 3);
const materials = [0xbf616a, 0xbf616a, 0xa3be8c, 0xa3be8c, 0x5e81ac, 0x5e81ac].map((color) => new MeshStandardMaterial({ color }));

// The same spin rate about each principal axis, each nudged a little off it.
const spins = [
  { position: new Vector3(-4, 0, 0), angularVelocity: new Vector3(0.02, 0.02, 3) }, // long axis: steady
  { position: new Vector3(0, 0, 0), angularVelocity: new Vector3(0.02, 3, 0.02) }, // middle axis: flips over and back
  { position: new Vector3(4, 0, 0), angularVelocity: new Vector3(3, 0.02, 0.02) }, // short axis: steady
];

for (const { position, angularVelocity } of spins) {
  const box = new Mesh(geometry, materials);
  box.position.copy(position);
  box.add(new AxesHelper(2));
  stage.scene.add(box);
  world.addBody(box, { angularVelocity });
}

run(stage, world);
