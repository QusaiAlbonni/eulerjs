import { BoxGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Body} from '@eulerjs/core';
import { ConeTwistJoint, FixedJoint, HingeJoint, PlaneCollider, SliderJoint, SphereCollider, World } from '@eulerjs/core';
import type { Object3D } from 'three';
import { createStage, run, showStatus } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 6, 16), lookAt: new Vector3(0, 2.5, 0) });
const world = new World();
const add = (object: Object3D) => {
  stage.scene.add(object);
  return object;
};
const material = (color: number) => new MeshStandardMaterial({ color });

const floor = add(new Mesh(new PlaneGeometry(60, 60).rotateX(-Math.PI / 2), material(0x3b4252)));
world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.8 }) });

// A self-closing door: a hinge at its left edge, about the vertical, that opens only one way, to
// 100°, with a servo (a spring and a damper) pulling it shut. It is kicked open every few seconds.
const door = add(new Mesh(new BoxGeometry(1.2, 2.2, 0.08), material(0xa3be8c)));
door.position.set(-7.4, 1.15, 0);
const doorBody = world.addBody(door, { density: 600, collider: 'box', canSleep: false });
world.addJoint(
  new HingeJoint({ bodyA: doorBody, anchor: new Vector3(-8, 1.15, 0), axis: new Vector3(0, 1, 0), limits: { lower: -1.75, upper: 0 }, motor: { targetPosition: 0, stiffness: 150, damping: 60 } }),
);

// A windmill: four sails on a hub, turned by a motor that holds 2 rad/s with at most 400 N·m.
const hub = add(new Mesh(new CylinderGeometry(0.25, 0.25, 0.3, 24).rotateX(Math.PI / 2), material(0x4c566a)));
hub.position.set(-3.5, 4, 0);
for (let sail = 0; sail < 4; sail++) {
  const blade = new Mesh(new BoxGeometry(0.35, 1.8, 0.05), material(0xe5e9f0));
  blade.position.set(0, 1.1, 0).applyAxisAngle(new Vector3(0, 0, 1), (sail * Math.PI) / 2);
  blade.rotation.z = (sail * Math.PI) / 2;
  hub.add(blade);
}
const windmill = world.addBody(hub, { density: 300, canSleep: false });
world.addJoint(new HingeJoint({ bodyA: windmill, anchor: hub.position, axis: new Vector3(0, 0, 1), motor: { targetVelocity: 2, maxForce: 400 } }));
const tower = add(new Mesh(new BoxGeometry(0.3, 4, 0.3), material(0x4c566a)));
tower.position.set(-3.5, 2, -0.3);

// A lift on a vertical slider with a motor: up at 1 m/s, then down, changing every 5 s, with the
// slider's limits as the top and bottom floors. A box rides on it.
const shaft = add(new Mesh(new BoxGeometry(0.1, 6, 0.1), material(0x4c566a)));
shaft.position.set(0.9, 3, 0);
const car = add(new Mesh(new BoxGeometry(1.4, 0.15, 1.4), material(0xebcb8b)));
car.position.set(0, 0.5, 0);
const carBody = world.addBody(car, { density: 400, collider: 'box', canSleep: false });
const lift = world.addJoint(new SliderJoint({ bodyA: carBody, anchor: car.position, axis: new Vector3(0, 1, 0), limits: { lower: 0, upper: 4 }, motor: { targetVelocity: 1, maxForce: 4000 } }));
const passenger = add(new Mesh(new BoxGeometry(0.5, 0.5, 0.5), material(0xd08770)));
passenger.position.set(0, 0.85, 0);
world.addBody(passenger, { density: 300, collider: 'box' });

// A lamp on a cone-twist joint: it swings and spins, but never more than 35° from hanging down.
const lamp = add(new Mesh(new CylinderGeometry(0.1, 0.4, 0.5, 24), material(0xebcb8b)));
lamp.position.set(3.5, 3.5, 0);
const lampBody = world.addBody(lamp, { density: 300, canSleep: false, velocity: new Vector3(4, 0, 2) });
world.addJoint(new ConeTwistJoint({ bodyA: lampBody, anchor: new Vector3(3.5, 4.5, 0), axis: new Vector3(0, -1, 0), swingLimit: 0.6 }));

// A bridge of planks welded end to end by fixed joints that break at 6000 N: it holds itself up,
// but not a falling ball of steel. Welded planks touch, so they mustn't collide with each other.
const plankGeometry = new BoxGeometry(0.8, 0.12, 1.2);
const planks: Body[] = [];
const bridgeStart = new Vector3(5.5, 2, 0);
for (let index = 0; index < 7; index++) {
  const plank = add(new Mesh(plankGeometry, material(0x8f7458)));
  plank.position.set(bridgeStart.x + 0.4 + index * 0.8, bridgeStart.y, 0);
  planks.push(world.addBody(plank, { density: 500, collider: 'box' }));
}
for (const [index, plank] of planks.entries()) {
  const leftEnd = new Vector3(bridgeStart.x + index * 0.8, bridgeStart.y, 0);
  world.addJoint(new FixedJoint({ bodyA: plank, bodyB: planks[index - 1], anchor: leftEnd, breakForce: 6000, collideConnected: false }));
}
world.addJoint(new FixedJoint({ bodyA: planks.at(-1)!, anchor: new Vector3(bridgeStart.x + 7 * 0.8, bridgeStart.y, 0), breakForce: 6000 }));

let breaks = 0;
world.on('jointBreak', (event) => {
  breaks++;
  showStatus(`${breaks} joint${breaks === 1 ? '' : 's'} broken; the last carried ${event.force.toFixed(0)} N`);
});

// Double-click to drop a heavy ball above what you clicked.
const raycaster = new Raycaster();
const pointer = new Vector2();
stage.renderer.domElement.addEventListener('dblclick', (event) => {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, stage.camera);
  const hit = world.castRay(raycaster.ray.origin, raycaster.ray.direction);
  if (!hit) return;
  const ball = add(new Mesh(new SphereGeometry(0.4, 24, 12), material(0xbf616a)));
  ball.position.copy(hit.point).add(new Vector3(0, 4, 0));
  world.addBody(ball, { density: 7800, collider: new SphereCollider({ radius: 0.4 }) });
});

let sinceTurn = 0;
let sinceKick = 4;
run(stage, world, (frameDelta) => {
  sinceTurn += frameDelta;
  if (sinceTurn > 5) {
    sinceTurn = 0;
    lift.motor = { ...lift.motor, targetVelocity: -(lift.motor?.targetVelocity ?? 1) };
  }
  sinceKick += frameDelta;
  if (sinceKick > 6) {
    sinceKick = 0;
    doorBody.angularVelocity.set(0, -4, 0);
  }
});
