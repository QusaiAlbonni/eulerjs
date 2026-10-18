import { BoxGeometry, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { DistanceJoint, World } from '@eulerjs/core';
import type { Body } from '@eulerjs/core';
import { createStage, run } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 2, 10), lookAt: new Vector3(0, 1, 0) });
const world = new World();

// Six links laid out sideways from a fixed point, so they fall and swing as a chain.
const linkLength = 0.8;
const linkGeometry = new BoxGeometry(linkLength, 0.15, 0.15);
const linkMaterial = new MeshStandardMaterial({ color: 0xebcb8b });
const pivot = new Vector3(-2.5, 4, 0);
const leftEnd = new Vector3(-linkLength / 2, 0, 0);
const rightEnd = new Vector3(linkLength / 2, 0, 0);

let previous: Body | undefined;
for (let index = 0; index < 6; index++) {
  const link = new Mesh(linkGeometry, linkMaterial);
  link.position.set(pivot.x + (index + 0.5) * linkLength, pivot.y, 0);
  stage.scene.add(link);
  const body = world.addBody(link, { density: 800 });
  // A rigid joint of length 0 is a pin: each link's left end is held to the end before it.
  world.addJoint(
    previous
      ? new DistanceJoint({ bodyA: body, anchorA: leftEnd, bodyB: previous, anchorB: rightEnd, length: 0 })
      : new DistanceJoint({ bodyA: body, anchorA: leftEnd, anchorB: pivot, length: 0 }),
  );
  previous = body;
}

run(stage, world);
