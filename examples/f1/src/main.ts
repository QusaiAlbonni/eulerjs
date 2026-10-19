import { Timer, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import { CarModel } from './car/CarModel.js';
import { F1Car } from './car/F1Car.js';
import { Cameras } from './scene/Cameras.js';
import { createView } from './scene/createView.js';
import { CarSound } from './sound/CarSound.js';
import { Circuit } from './track/Circuit.js';
import { buildCircuit } from './track/CircuitScenery.js';
import { addCircuitBodies } from './track/circuitBodies.js';
import { MONZA } from './track/monza.js';
import { Dashboard } from './ui/Dashboard.js';
import type { Laps } from './ui/Dashboard.js';
import { DriverControls } from './ui/DriverControls.js';
import { Minimap } from './ui/Minimap.js';

// A Formula 1 car round Monza, its layout from OpenStreetMap: one body on slip tyres, its engine,
// gearbox, downforce and drag, at 120 steps a second, the car moving almost 3 metres a step at
// full speed otherwise. Kerbs, grass and gravel each grip as they do. Its sound is made as it
// plays, from what the engine, the tyres and the ground under them do.

const view = createView(document.body);
const world = new World({ timestep: 1 / 120, maxStepsPerFrame: 12 });
const circuit = new Circuit(MONZA);
addCircuitBodies(world, circuit);
const startLights = buildCircuit(view.scene, circuit);
const model = new CarModel();
view.scene.add(model.root);
/** The car's place on the grid, pole behind the line; or, with `?at=` metres in the address, that far round the lap, to try a corner. */
const startAt = Number(new URLSearchParams(window.location.search).get('at') ?? Number.NaN);
const startSample = Number.isFinite(startAt) ? circuit.locate(circuit.samples.find((sample) => sample.distance >= startAt % circuit.length)?.position ?? circuit.startLine.position).sample : circuit.samples[circuit.samples.length - 8]!;
const grid = startSample.position;
const gridHeading = Math.atan2(startSample.tangent.x, startSample.tangent.z);
const car = new F1Car(world, model.root, grid, gridHeading, (point) => circuit.groundAt(point));
const cameras = new Cameras(view.camera, model.root);
const dashboard = new Dashboard(document.body);
const minimap = new Minimap(document.body, circuit);
const sound = new CarSound();
const help = document.getElementById('help')!;

const laps: Laps = { current: 0, last: undefined, best: undefined, count: 0 };
/** When the lap under way began, on the world's clock; undefined before lights out. */
let lapStartedAt: number | undefined;
/** How far round the lap the car was last frame, in metres, to see it cross the line. */
let lastProgress = circuit.progressAt(car.body.position);
/** How far it has gone round this lap: a lap counts only once it has been most of the way. */
let covered = 0;

/**
 * The start: the five lights come on a second apart, then go out together after a pause no one
 * can guess, and the car may go. Held on its brakes till then.
 */
const start = { lightsAt: 0, outAt: 0, running: false };
function beginStart(): void {
  start.lightsAt = world.renderTime + 1;
  start.outAt = start.lightsAt + 5 + 0.4 + Math.random() * 2;
  start.running = true;
  lapStartedAt = undefined;
  laps.current = 0;
  covered = 0;
}

const controls = new DriverControls(car.input, {
  camera: () => cameras.next(),
  reset: () => {
    car.reset(grid, gridHeading);
    lastProgress = circuit.progressAt(car.body.position);
    if (Number.isFinite(startAt)) {
      lapStartedAt = undefined;
      covered = 0;
    } else beginStart();
  },
  assists: () => {
    car.tractionControl = car.antiLock = !car.tractionControl;
  },
  gearbox: () => {
    car.powertrain.automatic = !car.powertrain.automatic;
  },
  sound: () => sound.toggleMute(),
  help: () => help.classList.toggle('hidden'),
});
// from the grid, the lights; from part-way round, practice, the timer started at the line
if (!Number.isFinite(startAt)) beginStart();
// for looking into it from the browser's console while developing
if (import.meta.env.DEV) Object.assign(window, { f1: { view, world, car, circuit, sound } });

const facing = new Vector3();
const timer = new Timer();
timer.connect(document);
view.renderer.setAnimationLoop((timestamp: number) => {
  timer.update(timestamp);
  const frameDelta = Math.min(timer.getDelta(), 0.1);
  controls.update(frameDelta, car.speed);

  if (start.running) {
    const lit = Math.min(Math.max(Math.floor(world.renderTime - start.lightsAt) + 1, 0), 5);
    if (world.renderTime >= start.outAt) {
      startLights.set(0);
      start.running = false;
      lapStartedAt = world.renderTime;
    } else {
      startLights.set(lit);
      // held on the grid till the lights go out
      car.input.brake = 1;
    }
  }
  world.update(frameDelta);

  // a lap from one crossing of the line to the next, once it has been round
  const progress = circuit.progressAt(car.body.position);
  let moved = progress - lastProgress;
  if (moved < -circuit.length / 2) moved += circuit.length;
  if (moved > circuit.length / 2) moved -= circuit.length;
  covered += moved;
  const crossedLine = progress < lastProgress - circuit.length / 2;
  if (crossedLine && lapStartedAt === undefined && !start.running) {
    // practising from part-way round: timed from the first time over the line
    lapStartedAt = world.renderTime;
    covered = 0;
  } else if (crossedLine && lapStartedAt !== undefined && covered > circuit.length * 0.9) {
    const lap = world.renderTime - lapStartedAt;
    laps.last = lap;
    laps.best = laps.best === undefined ? lap : Math.min(laps.best, lap);
    laps.count++;
    lapStartedAt = world.renderTime;
    covered = 0;
  }
  lastProgress = progress;
  laps.current = lapStartedAt === undefined ? 0 : world.renderTime - lapStartedAt;

  model.update(car, frameDelta);
  cameras.update(frameDelta, car.speed);
  view.followWithShadows(model.root);
  dashboard.update(car, laps, frameDelta);
  sound.update(car, cameras.mode !== 'chase');
  car.body.directionToWorld(facing.set(0, 0, 1));
  minimap.update(model.root.position, Math.atan2(facing.x, facing.z));
  view.render();
});
