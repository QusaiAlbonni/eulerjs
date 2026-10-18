import { ArrowHelper, BoxGeometry, CapsuleGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Body} from '@eulerjs/core';
import { CapsuleCollider, CylinderCollider, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import { createStage, run, showStatus } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 7, 13), lookAt: new Vector3(0, 1, 0) });
const world = new World();
const material = (color: number) => new MeshStandardMaterial({ color });

const floor = new Mesh(new PlaneGeometry(60, 60).rotateX(-Math.PI / 2), material(0x3b4252));
stage.scene.add(floor);
world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.8 }) });

// Things to look at and push: a wall of crates, a few barrels, a ball.
for (let row = 0; row < 3; row++) {
  for (let column = 0; column < 6; column++) {
    const crate = new Mesh(new BoxGeometry(0.9, 0.9, 0.9), material(0xd08770));
    crate.position.set(column - 2.5, 0.45 + row * 0.9, -2);
    stage.scene.add(crate);
    world.addBody(crate, { density: 300, collider: 'box' });
  }
}
for (let index = 0; index < 3; index++) {
  const barrel = new Mesh(new CylinderGeometry(0.4, 0.4, 1, 24), material(0x5e81ac));
  barrel.position.set(-4 + index * 1.2, 0.5, 2);
  stage.scene.add(barrel);
  world.addBody(barrel, { density: 400, collider: new CylinderCollider({ radius: 0.4, height: 1 }) });
}

// A character: a capsule the code moves itself (kinematic), back and forth along x. It sweeps its
// capsule a little way ahead with castShape, and turns round before it would walk into anything.
const characterShape = new CapsuleCollider({ radius: 0.35, length: 0.9 });
const characterMesh = new Mesh(new CapsuleGeometry(0.35, 0.9, 4, 12), material(0xa3be8c));
characterMesh.position.set(-5, 0.81, 4.5);
stage.scene.add(characterMesh);
const character = world.addBody(characterMesh, { type: 'kinematic', collider: characterShape });
const walkSpeed = 2;
/** How far ahead it looks, in metres. */
const LOOK_AHEAD = 0.3;
const walkDirection = new Vector3(1, 0, 0);
// something for it to bump into
const post = new Mesh(new BoxGeometry(0.6, 2, 0.6), material(0x4c566a));
post.position.set(4, 1, 4.5);
stage.scene.add(post);
world.addBody(post, { type: 'static', collider: 'box' });

// Where the last ray hit, and the surface's normal there.
const marker = new Mesh(new SphereGeometry(0.08, 12, 8), material(0xebcb8b));
marker.visible = false;
stage.scene.add(marker);
const normalArrow = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 0.8, 0xebcb8b);
normalArrow.visible = false;
stage.scene.add(normalArrow);

const raycaster = new Raycaster();
const pointer = new Vector2();
function rayFromPointer(event: MouseEvent): void {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
}

// Click: a ray from the camera through the pointer. It finds the first collider, the point, the
// distance and the normal, and pushes the body there, at that point, so it turns as well.
stage.renderer.domElement.addEventListener('click', (event) => {
  rayFromPointer(event);
  const hit = world.castRay(raycaster.ray.origin, raycaster.ray.direction, { maxDistance: 100, exclude: character });
  if (!hit) return;
  marker.position.copy(hit.point);
  normalArrow.position.copy(hit.point);
  normalArrow.setDirection(hit.normal);
  marker.visible = normalArrow.visible = true;
  // the ground and other static bodies take no notice of impulses
  hit.body.applyImpulse(raycaster.ray.direction.clone().multiplyScalar(40), hit.point);
  showStatus(`ray hit a ${hit.collider.shape} ${hit.distance.toFixed(2)} m away`);
});

// Right-click: everything within 3 m of where the pointer meets the scene is blown away from it.
stage.renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  rayFromPointer(event);
  const hit = world.castRay(raycaster.ray.origin, raycaster.ray.direction, { maxDistance: 100 });
  if (!hit) return;
  const caught = world.overlap(new SphereCollider({ radius: 3 }), hit.point);
  const pushed = new Set<Body>();
  for (const { body } of caught) {
    if (body.type !== 'dynamic' || pushed.has(body)) continue;
    pushed.add(body);
    const away = body.position.clone().sub(hit.point).add(new Vector3(0, 1, 0)).normalize();
    body.applyImpulse(away.multiplyScalar(body.mass * 6));
  }
  showStatus(`the blast caught ${pushed.size} bodies`);
});

run(stage, world, () => {
  const ahead = world.castShape(characterShape, character.position, walkDirection, { maxDistance: LOOK_AHEAD, exclude: character });
  // something in the way, or the edge of where it walks: turn round
  if (ahead || (Math.abs(character.position.x) > 6 && Math.sign(character.position.x) === walkDirection.x)) walkDirection.negate();
  // a kinematic body moves at the velocity it is given, and pushes what it meets
  character.velocity.copy(walkDirection).multiplyScalar(walkSpeed);
});
