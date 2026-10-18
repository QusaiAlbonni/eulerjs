import { Timer, Vector3 } from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { World } from '@eulerjs/core';
import { FirstPersonPlayer } from './player/FirstPersonPlayer.js';
import { Hands } from './player/Hands.js';
import { PlayerControls } from './player/PlayerControls.js';
import { createView } from './scene/createView.js';
import { createVenue } from './venue/createVenue.js';
import { ENTRANCE } from './venue/layout.js';

const view = createView(document.body);
const world = new World();
const venue = createVenue(world, view.scene);
const player = new FirstPersonPlayer(world, ENTRANCE);
// facing the arch, to the north
player.yaw = Math.PI;
view.scene.add(player.head);
const hands = world.use(new Hands(world, player));
const controls = new PlayerControls(player, hands, view.renderer.domElement, () => {
  hands.drop();
  player.respawn(ENTRANCE);
});

const hint = document.getElementById('hint')!;
const awakeCount = document.getElementById('awake')!;
const welcome = document.getElementById('welcome')!;
const stats = new Stats();
document.body.appendChild(stats.dom);

const eye = new Vector3();
const movable = venue.props.length;
const timer = new Timer();
timer.connect(document);
view.renderer.setAnimationLoop((timestamp: number) => {
  timer.update(timestamp);
  controls.update();
  world.update(timer.getDelta());
  view.camera.position.copy(player.eyePosition(eye));
  player.lookQuaternion(view.camera.quaternion);
  venue.balloons.update();

  welcome.hidden = controls.looking;
  const aimed = controls.looking && !hands.holding ? hands.aimedAt() : undefined;
  hint.textContent = hands.holding ? 'click to throw · E to put down' : aimed ? (hands.canLift(aimed.body) ? 'click to shove · E to pick up' : 'click to shove · too heavy to lift') : '';
  awakeCount.textContent = `${venue.props.filter((body) => !body.isSleeping).length} of ${movable} loose things awake`;
  view.render();
  stats.update();
});
