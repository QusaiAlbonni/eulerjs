import { BoxGeometry, BufferGeometry, Line, LineBasicMaterial, Mesh, MeshStandardMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import type { Behavior, Body, Plugin } from '@eulerjs/core';
import { createStage, run } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 4, 11), lookAt: new Vector3(0, 3.5, 0) });
const world = new World();

/** A behaviour acts on one body every step: here, a spring from a fixed anchor to a point on the body. */
class Spring implements Behavior {
  readonly worldAttachment = new Vector3();
  private readonly force = new Vector3();
  private readonly attachmentVelocity = new Vector3();

  constructor(
    readonly anchor: Vector3,
    /** Where the spring holds the body, in the body's own frame. */
    readonly attachment: Vector3,
    readonly stiffness: number,
    readonly damping: number,
  ) {}

  fixedUpdate(body: Body): void {
    body.pointToWorld(this.attachment, this.worldAttachment);
    body.pointVelocity(this.worldAttachment, this.attachmentVelocity);
    this.force
      .subVectors(this.anchor, this.worldAttachment)
      .multiplyScalar(this.stiffness)
      .addScaledVector(this.attachmentVelocity, -this.damping);
    // Applied away from the centre of mass, the spring also turns the block.
    body.applyForce(this.force, this.worldAttachment);
  }
}

/** A plugin acts on the whole world every step: here, air drag on every body, growing with speed squared. */
const dragForce = new Vector3();
const airDrag: Plugin = {
  name: 'air-drag',
  applyForces(dragWorld) {
    for (const body of dragWorld.bodies) {
      const speed = body.velocity.length();
      body.applyForce(dragForce.copy(body.velocity).multiplyScalar(-0.6 * speed));
    }
  },
};
world.use(airDrag);

// Three blocks on springs of increasing stiffness, each held by a corner of its top face.
const springSettings = [
  { stiffness: 40, color: 0xebcb8b },
  { stiffness: 120, color: 0xd08770 },
  { stiffness: 400, color: 0xbf616a },
];
const blocks = springSettings.map(({ stiffness, color }, index) => {
  const anchor = new Vector3((index - 1) * 3.5, 5, 0);
  const block = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color }));
  block.position.set(anchor.x, 2, 0);
  stage.scene.add(block);
  const spring = world.addBody(block, { mass: 5 }).addBehavior(new Spring(anchor, new Vector3(0.5, 0.5, 0.5), stiffness, 4));
  const line = new Line(new BufferGeometry().setFromPoints([anchor, anchor]), new LineBasicMaterial({ color: 0xd8dee9 }));
  stage.scene.add(line);
  return { block, spring, line };
});

// Click a block to kick it where you clicked: an off-centre kick sets it spinning as well.
const raycaster = new Raycaster();
const pointer = new Vector2();
let pressedAt = new Vector2();
stage.renderer.domElement.addEventListener('pointerdown', (event) => {
  pressedAt = new Vector2(event.clientX, event.clientY);
});
stage.renderer.domElement.addEventListener('pointerup', (event) => {
  if (pressedAt.distanceTo(new Vector2(event.clientX, event.clientY)) > 4) return; // that was an orbit drag
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
  // world.bodyOf finds the body behind whatever mesh the ray hit
  const hit = raycaster.intersectObjects(stage.scene.children).find((intersection) => world.bodyOf(intersection.object));
  if (!hit) return;
  world.bodyOf(hit.object)?.applyImpulse(raycaster.ray.direction.clone().multiplyScalar(25), hit.point);
});

const attachmentOnScreen = new Vector3();
run(stage, world, () => {
  // Draw each spring to where its block is drawn, which is interpolated between physics steps.
  for (const { block, spring, line } of blocks) {
    block.localToWorld(attachmentOnScreen.copy(spring.attachment));
    line.geometry.setFromPoints([spring.anchor, attachmentOnScreen]);
  }
});
