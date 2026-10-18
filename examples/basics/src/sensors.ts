import { BoxGeometry, Color, Mesh, MeshStandardMaterial, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { BoxCollider, PlaneCollider, SphereCollider, World } from '@eulerjs/core';
import type { Body } from '@eulerjs/core';
import { createStage, run, showStatus } from './stage.js';

const stage = createStage({ cameraPosition: new Vector3(0, 6, 12), lookAt: new Vector3(0, 1.5, 0) });
const world = new World();

const floor = new Mesh(new PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x3b4252 }));
stage.scene.add(floor);
world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.6 }) });

// A zone that notices what is in it without pushing it: a static body with a sensor collider.
const zoneSize = new Vector3(4, 2, 3);
const idle = new Color(0x5e81ac);
const occupied = new Color(0xa3be8c);
const zoneMaterial = new MeshStandardMaterial({ color: idle, transparent: true, opacity: 0.25, depthWrite: false });
const zone = new Mesh(new BoxGeometry(zoneSize.x, zoneSize.y, zoneSize.z), zoneMaterial);
zone.position.set(0, 2.5, 0);
stage.scene.add(zone);
const sensor = new BoxCollider({ size: zoneSize, sensor: true });
world.addBody(zone, { type: 'static', collider: sensor });

// The sensor's events say what comes in and goes out, and world.inSensor what is in it now.
let entered = 0;
world.on('sensorEnter', () => entered++);
const report = () => {
  const inside = world.inSensor(sensor).length;
  zoneMaterial.color.copy(inside > 0 ? occupied : idle);
  showStatus(`${inside} in the zone, ${entered} been through`);
};

// Crates on the floor flash whenever something starts touching them: contactBegin.
const flashUntil = new Map<Mesh, number>();
const crateColor = new Color(0xd08770);
const flashColor = new Color(0xebcb8b);
const crateOf = new Map<Body, Mesh>();
for (let index = 0; index < 5; index++) {
  const crate = new Mesh(new BoxGeometry(0.8, 0.8, 0.8), new MeshStandardMaterial({ color: crateColor }));
  crate.position.set(-2 + index, 0.4, 0.2 * (index % 2));
  stage.scene.add(crate);
  crateOf.set(world.addBody(crate, { density: 300, collider: 'box' }), crate);
}
world.on('contactBegin', ({ bodyA, bodyB }) => {
  for (const body of [bodyA, bodyB]) {
    const crate = crateOf.get(body);
    if (crate) flashUntil.set(crate, world.time + 0.15);
  }
});

// A ball dropped through the zone every half second, from a little way to one side or the other.
const ballGeometry = new SphereGeometry(0.25, 16, 10);
const ballMaterial = new MeshStandardMaterial({ color: 0x88c0d0 });
let sinceDrop = 0;
let dropped = 0;
run(stage, world, (frameDelta) => {
  sinceDrop += frameDelta;
  if (sinceDrop > 0.5 && dropped < 60) {
    sinceDrop = 0;
    dropped++;
    const ball = new Mesh(ballGeometry, ballMaterial);
    ball.position.set(Math.sin(dropped * 2.3) * 1.8, 6, Math.cos(dropped * 1.7) * 1.2);
    stage.scene.add(ball);
    world.addBody(ball, { density: 500, collider: new SphereCollider({ radius: 0.25, restitution: 0.4 }) });
  }
  report();
  for (const [crate, until] of flashUntil) {
    (crate.material as MeshStandardMaterial).color.copy(world.time < until ? flashColor : crateColor);
    if (world.time >= until) flashUntil.delete(crate);
  }
});
