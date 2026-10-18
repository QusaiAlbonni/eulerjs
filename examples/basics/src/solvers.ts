import { BoxGeometry, GridHelper, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { Body, DistanceJoint, JavaScriptBackend, PlaneCollider, SphereCollider, World } from 'eulerjs';
import type { JavaScriptBackendOptions } from 'eulerjs';
import { createStage, run, showStatus } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 6, 22), lookAt: new Vector3(0, 3.5, 0) });
stage.scene.add(new GridHelper(40, 40, 0x4c566a, 0x3b4252));

/**
 * The same scene twice, one world per solver of the JavaScript backend: a stack of eight crates
 * kept awake so it never rests by sleeping, and a pendulum swinging from 60°.
 */
function scene(solver: JavaScriptBackendOptions['solver'], side: number, color: number) {
  const world = new World({ backend: new JavaScriptBackend({ solver }) });
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
  const crateGeometry = new BoxGeometry(1, 1, 1);
  const crateMaterial = new MeshStandardMaterial({ color });
  for (let level = 0; level < 8; level++) {
    const crate = new Mesh(crateGeometry, crateMaterial);
    crate.position.set(side * 8, 0.5 + level * 1.001, 0);
    stage.scene.add(crate);
    world.addBody(crate, { density: 300, collider: 'box', canSleep: false });
  }
  // the pendulum swings between 0.4 m and 5.6 m from the middle, clear of the stack and the other side's
  const pivot = new Vector3(side * 3, 6, 0);
  const startAngle = Math.PI / 3;
  const bob = new Mesh(new SphereGeometry(0.3, 20, 12), crateMaterial);
  bob.position.copy(pivot).add(new Vector3(3 * Math.sin(startAngle) * side, -3 * Math.cos(startAngle), 0));
  stage.scene.add(bob);
  const bobBody = world.addBody(bob, { mass: 5, collider: new SphereCollider({ radius: 0.3 }), canSleep: false });
  world.addJoint(new DistanceJoint({ bodyA: bobBody, anchorB: pivot }));
  const heightAbovePivot = () => bobBody.position.y - pivot.y;
  const startEnergy = 9.81 * heightAbovePivot();
  // the share of its energy the pendulum still has, kinetic and potential, measured from the pivot
  const energyKept = () => (0.5 * bobBody.velocity.lengthSq() + 9.81 * heightAbovePivot() + 9.81 * 3) / (startEnergy + 9.81 * 3);
  return { world, energyKept };
}

const positionBased = scene('xpbd', -1, 0xd08770);
const softStep = scene('soft-step', 1, 0x88c0d0);

run(stage, positionBased.world, (frameDelta) => {
  softStep.world.update(frameDelta);
  const percent = (share: number) => `${(100 * share).toFixed(1)}%`;
  showStatus(`Pendulum energy kept after ${positionBased.world.time.toFixed(0)} s: XPBD ${percent(positionBased.energyKept())}, soft step ${percent(softStep.energyKept())}`);
});
