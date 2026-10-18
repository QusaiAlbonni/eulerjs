import { BoxGeometry, DodecahedronGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import { PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import { createStage, run } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(7, 5, 9), lookAt: new Vector3(0, 1, 0) });
const world = new World();

// The floor: a static body whose collider is a class instance, an infinite plane.
const floor = new Mesh(new PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x3b4252 }));
stage.scene.add(floor);
world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.8 }) });

// A pyramid of crates. collider: 'box' fits a box collider around each mesh.
const crateGeometry = new BoxGeometry(1, 1, 1);
const crateMaterial = new MeshStandardMaterial({ color: 0xd08770 });
for (let row = 0; row < 4; row++) {
  for (let column = 0; column < 4 - row; column++) {
    const crate = new Mesh(crateGeometry, crateMaterial);
    crate.position.set(column - (3 - row) / 2, 0.5 + row, 0);
    stage.scene.add(crate);
    world.addBody(crate, { density: 300, collider: 'box' });
  }
}

// Rocks beside it. collider: 'convex' wraps each mesh in its convex hull, and the mass comes
// from that exact shape.
const rockMaterial = new MeshStandardMaterial({ color: 0x81a1c1, flatShading: true });
for (let index = 0; index < 6; index++) {
  const rock = new Mesh(new DodecahedronGeometry(0.35 + 0.1 * (index % 3)), rockMaterial);
  rock.position.set(3 + (index % 2) * 0.9, 0.6 + Math.floor(index / 2) * 1.1, -1 + (index % 3) * 0.8);
  stage.scene.add(rock);
  world.addBody(rock, { density: 2500, collider: 'convex' });
}

// Click to throw a bouncy ball at what you clicked. Its collider is a class, to set restitution.
const raycaster = new Raycaster();
const pointer = new Vector2();
const ballGeometry = new SphereGeometry(0.35, 24, 12);
const ballMaterial = new MeshStandardMaterial({ color: 0x88c0d0 });
stage.renderer.domElement.addEventListener('dblclick', (event) => {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
  const ball = new Mesh(ballGeometry, ballMaterial);
  ball.position.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, 1);
  stage.scene.add(ball);
  world.addBody(ball, {
    density: 2000,
    collider: new SphereCollider({ radius: 0.35, restitution: 0.6 }),
    velocity: raycaster.ray.direction.clone().multiplyScalar(18),
  });
});

run(stage, world);
