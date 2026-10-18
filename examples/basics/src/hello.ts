import { BoxGeometry, GridHelper, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import { createStage, run } from './stage.js';

const stage = createStage();
stage.scene.add(new GridHelper(20, 20, 0x4c566a, 0x3b4252));

// A world: gravity (0, -9.81, 0) and 60 fixed steps per second by default.
const world = new World();

// A mesh and its body. The body takes its shape and starting pose from the mesh; the density
// sets the mass (it would be water's, 1000 kg/m³, if left out).
const crate = new Mesh(new BoxGeometry(1, 0.6, 1.6), new MeshStandardMaterial({ color: 0xd08770 }));
stage.scene.add(crate);
const body = world.addBody(crate, { density: 500 });

// It has no collider and there is no floor, so instead of landing it is thrown again when it falls back.
function throwCrate(): void {
  body.setPose(new Vector3(0, 0.5, 0), new Quaternion());
  body.velocity.set(0, 9, 0);
  body.angularVelocity.set(1.5, 3, 0.5);
}
throwCrate();

run(stage, world, () => {
  if (body.position.y < 0.5 && body.velocity.y < 0) throwCrate();
});
