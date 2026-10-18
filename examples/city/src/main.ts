import { Timer } from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { JavaScriptBackend, World } from 'eulerjs';
import type { JavaScriptBackendOptions } from 'eulerjs';
import { createCar } from './car/createCar.js';
import { BLOCK_PITCH, createCity } from './city/createCity.js';
import { Crowd } from './people/Crowd.js';
import { ChaseCamera } from './scene/ChaseCamera.js';
import { createView } from './scene/createView.js';

/** People walking the pavements, each a ragdoll of eleven bodies. */
const PEDESTRIANS = 30;

/**
 * The solver, to compare the two: `?solver=xpbd` or `?solver=soft-step` in the address, or the
 * VITE_SOLVER environment variable when the dev server starts; soft step unless either says.
 */
function chosenSolver(): NonNullable<JavaScriptBackendOptions['solver']> {
  const asked = new URLSearchParams(window.location.search).get('solver') ?? import.meta.env.VITE_SOLVER;
  return asked === 'xpbd' ? 'xpbd' : 'soft-step';
}

const solver = chosenSolver();
document.getElementById('solver')!.textContent = solver === 'xpbd' ? 'XPBD' : 'soft step';
const view = createView(document.body);
const world = new World({ backend: new JavaScriptBackend({ solver }) });
const city = createCity(world, view.scene);
const car = createCar({ world, scene: view.scene });
// on the blocks round where the car starts, so there are people about from the first corner
const nearbyBlocks = city.blocks.filter((block) => block.length() < 2 * BLOCK_PITCH);
world.use(new Crowd(world, { count: PEDESTRIANS, blocks: nearbyBlocks, scene: view.scene, random: Math.random }));
const camera = new ChaseCamera(view.camera, car.object);

const speedometer = document.getElementById('speed')!;
const stats = new Stats();
document.body.appendChild(stats.dom);

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyV' && !event.repeat) camera.toggleView();
  // keep the arrow keys and space from scrolling the page
  if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
});

const timer = new Timer();
timer.connect(document);
view.renderer.setAnimationLoop((timestamp: number) => {
  timer.update(timestamp);
  const frameDelta = timer.getDelta();
  car.update(frameDelta);
  world.update(frameDelta);
  camera.update(frameDelta);
  view.followWithShadows(car.object);
  speedometer.textContent = `${Math.round(Math.abs(car.vehicle.forwardSpeed(car.body)) * 3.6)} km/h`;
  view.render();
  stats.update();
});
