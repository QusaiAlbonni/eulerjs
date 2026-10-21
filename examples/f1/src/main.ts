import { Timer, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import { CarModel } from './car/CarModel.js';
import { DetailedCarModel } from './car/DetailedCarModel.js';
import { F1Car } from './car/F1Car.js';
import { LIVERIES } from './car/livery.js';
import { Multiplayer } from './multiplayer/Multiplayer.js';
import { LaggyTransport, TabTransport } from './multiplayer/transport.js';
import type { Transport } from './multiplayer/transport.js';
import { Cameras, MOUNTS } from './scene/Cameras.js';
import { createView } from './scene/createView.js';
import { CarSound } from './sound/CarSound.js';
import { Circuit } from './track/Circuit.js';
import type { TrackSample } from './track/Circuit.js';
import { buildCircuit } from './track/CircuitScenery.js';
import { addCircuitBodies } from './track/circuitBodies.js';
import { MONZA } from './track/monza.js';
import { Dashboard } from './ui/Dashboard.js';
import type { Laps } from './ui/Dashboard.js';
import { DriverControls } from './ui/DriverControls.js';
import { Menu } from './ui/Menu.js';
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
const address = new URLSearchParams(window.location.search);
// the detailed car; or, with `?car=drawn` in the address, the one drawn in code, which needs no download
const drawn = address.get('car') === 'drawn';
// in a player's livery, `?player=` 1 to 10, its number changed with `?number=`, to try them
const playerLivery = LIVERIES[Math.min(Math.max(Number(address.get('player') ?? 1), 1), LIVERIES.length) - 1] ?? LIVERIES[0]!;
const livery = { ...playerLivery, number: address.get('number') ?? playerLivery.number };
const modelUrl = `${import.meta.env.BASE_URL}models/f1-car.glb`;
const model = drawn ? new CarModel() : await DetailedCarModel.load(modelUrl, livery);
// the drawn car's driver sits further back
if (drawn) MOUNTS.cockpit.eye.z = 0.12;
view.scene.add(model.root);
/** The car's place on the grid, pole behind the line; or, with `?at=` metres in the address, that far round the lap, to try a corner. */
// The game opens on a menu: drive alone, or make or join a room over WebRTC; `?join=` a code
// joins that room at once, as an invite link does. To try it on one machine, `?room=` races the
// other tabs open on the same room, `&host` in one of them; and with either, `&ping=`, `&jitter=`
// (ms) and `&loss=` (%) play a network's part.
const localRoom = address.get('room');
const inviteCode = address.get('join');
const conditions = { ping: Number(address.get('ping') ?? 0), jitter: Number(address.get('jitter') ?? 0), loss: Number(address.get('loss') ?? 0) / 100 };
const startAt = localRoom === null && inviteCode === null ? Number(address.get('at') ?? Number.NaN) : Number.NaN;
const startSample = Number.isFinite(startAt) ? circuit.locate(circuit.samples.find((sample) => sample.distance >= startAt % circuit.length)?.position ?? circuit.startLine.position).sample : circuit.samples[circuit.samples.length - 8]!;
const grid = startSample.position.clone();
let gridHeading = Math.atan2(startSample.tangent.x, startSample.tangent.z);
const car = new F1Car(world, model.root, grid, gridHeading, (point) => circuit.groundAt(point));
/** Slot `slot` on the grid: each 8 m behind the one before, left and right in turn. */
function gridPlace(slot: number): void {
  // by the distance round the lap: the samples aren't evenly spaced everywhere
  const wanted = (startSample.distance - 8 * slot + circuit.length) % circuit.length;
  const gap = (sample: TrackSample) => Math.abs(((sample.distance - wanted + circuit.length * 1.5) % circuit.length) - circuit.length / 2);
  const sample = circuit.samples.reduce((nearest, candidate) => (gap(candidate) < gap(nearest) ? candidate : nearest));
  grid.copy(sample.position).addScaledVector(sample.left, slot % 2 === 0 ? 2 : -2);
  gridHeading = Math.atan2(sample.tangent.x, sample.tangent.z);
}
const cameras = new Cameras(view.camera, model.root, view.renderer.domElement);
const dashboard = new Dashboard(document.body);
const minimap = new Minimap(document.body, circuit);
const sound = new CarSound();

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
/** The start, the lights coming on at `lightsAt` and going out at `outAt` on the world's clock: in a moment, and after a pause no one can guess, unless the host says when. */
function beginStart(lightsAt = world.renderTime + 1, outAt = lightsAt + 5 + 0.4 + Math.random() * 2): void {
  start.lightsAt = lightsAt;
  start.outAt = outAt;
  start.running = true;
  lapStartedAt = undefined;
  laps.current = 0;
  covered = 0;
}

const controls = new DriverControls(car.input, {
  camera: () => cameras.next(),
  inspect: () => cameras.inspect(),
  reset: () => {
    // the host starts a race for everyone; another player goes back to their place, to practise till it does
    if (multiplayer?.session.isHost) {
      multiplayer.startRace();
      return;
    }
    car.reset(grid, gridHeading);
    lastProgress = circuit.progressAt(car.body.position);
    if (Number.isFinite(startAt) || multiplayer) {
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
  menu: () => menu.toggle(),
});
let multiplayer: Multiplayer | undefined;
/** Whether the player is yet to choose, alone or a room: the car held on its brakes till they have. */
let choosing = true;
/** In the room `code` over `transport`: the host's race started at once, the others practising till it is. */
function enterRoom(transport: Transport, code: string, isHost: boolean): void {
  const network = conditions.ping > 0 || conditions.loss > 0 ? new LaggyTransport(transport, conditions) : transport;
  multiplayer = new Multiplayer(network, code, isHost, {
    world,
    scene: view.scene,
    car,
    modelUrl,
    takeSlot: (slot) => {
      if (model instanceof DetailedCarModel) model.setLivery(LIVERIES[slot]!);
      gridPlace(slot);
      car.reset(grid, gridHeading);
      lastProgress = circuit.progressAt(car.body.position);
    },
    start: (lightsAt, outAt) => {
      car.reset(grid, gridHeading);
      lastProgress = circuit.progressAt(car.body.position);
      beginStart(lightsAt, outAt);
    },
  });
  if (isHost) multiplayer.startRace();
  if (import.meta.env.DEV) Object.assign(window, { f1: { ...(window as unknown as { f1: object }).f1, multiplayer } });
}
/** A room made or joined from the menu: the address the room's own, so that reloading the page comes back to it, as a player. */
function enterChosenRoom(transport: Transport, code: string, isHost: boolean): void {
  if (!isHost) window.history.replaceState(null, '', `?join=${code}`);
  enterRoom(transport, code, isHost);
}

/** Who made what, for the menu: the licences ask for it to be shown, and for what was changed. */
const credits = [
  'Physics by <a href="https://qusaialbonni.github.io/eulerjs/">eulerjs</a>, drawn with <a href="https://threejs.org/">three.js</a>.',
  'Monza’s layout © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, under the Open Database License.',
  'The engine’s sound after <a href="https://github.com/ange-yaghi/engine-sim">engine-sim</a> by Ange Yaghi, MIT licensed.',
  ...(drawn ? [] : [DetailedCarModel.CREDIT]),
].join('<br />');
const menu = new Menu(
  document.body,
  {
    restart: () => {
      car.reset(grid, gridHeading);
      lastProgress = circuit.progressAt(car.body.position);
      beginStart();
    },
    startRace: () => {
      if (multiplayer?.session.isHost) multiplayer.startRace();
      else {
        car.reset(grid, gridHeading);
        lastProgress = circuit.progressAt(car.body.position);
        lapStartedAt = undefined;
        covered = 0;
      }
    },
    enterRoom: (choice) => enterChosenRoom(choice.transport, choice.code, choice.isHost),
    room: () => multiplayer?.info(),
  },
  credits,
);
if (localRoom !== null) {
  choosing = false;
  menu.skip();
  enterRoom(new TabTransport(localRoom), localRoom, address.has('host'));
} else if (Number.isFinite(startAt)) {
  // practice from part-way round: straight on, the timer started at the line
  choosing = false;
  menu.skip();
} else {
  void menu.firstChoice(inviteCode ?? undefined).then((choice) => {
    choosing = false;
    // alone, from the grid, the lights
    if (choice.mode === 'alone') beginStart();
    else enterChosenRoom(choice.transport, choice.code, choice.isHost);
  });
}
// for looking into it from the browser's console while developing
if (import.meta.env.DEV) Object.assign(window, { f1: { view, world, car, model, circuit, sound, multiplayer } });

const facing = new Vector3();
const timer = new Timer();
timer.connect(document);
view.renderer.setAnimationLoop((timestamp: number) => {
  timer.update(timestamp);
  const frameDelta = Math.min(timer.getDelta(), 0.1);
  // with the menu open the keys are its own; alone, the race waits for it, while in a room it can't
  controls.listening = !menu.isOpen;
  controls.update(frameDelta, car.speed);
  if (choosing) car.input.brake = 1;
  const paused = menu.isOpen && !choosing && !multiplayer;
  menu.update();

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
  if (!paused) world.update(frameDelta);
  multiplayer?.update(frameDelta, timestamp);

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
  sound.update(car, cameras.mode === 'tcam' || cameras.mode === 'cockpit');
  car.body.directionToWorld(facing.set(0, 0, 1));
  minimap.update(model.root.position, Math.atan2(facing.x, facing.z));
  view.render();
});
