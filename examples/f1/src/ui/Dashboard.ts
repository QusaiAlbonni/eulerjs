import { Quaternion, Vector3 } from 'three';
import type { F1Car } from '../car/F1Car.js';
import { SPECIFICATION } from '../car/specification.js';

/** The shift lights, as on the car's steering wheel: green, red, then blue at the shift point. */
const SHIFT_LIGHTS = ['green', 'green', 'green', 'green', 'green', 'red', 'red', 'red', 'red', 'red', 'blue', 'blue', 'blue', 'blue', 'blue'] as const;
/** The revs the first light comes on at, and the last. */
const LIGHTS_FROM = 9000;
const LIGHTS_TO = SPECIFICATION.gearbox.upshiftRpm;
/** The g-meter's edge, in g. */
const G_METER_REACH = 5;

/** Lap times, in seconds. */
export interface Laps {
  current: number;
  last: number | undefined;
  best: number | undefined;
  count: number;
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[Tag] {
  const created = document.createElement(tag);
  created.className = className;
  created.textContent = text;
  parent.appendChild(created);
  return created;
}

/** A lap time as m:ss.sss, or dashes. */
export function lapTime(seconds: number | undefined): string {
  if (seconds === undefined) return '–:––.–––';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, '0')}`;
}

/**
 * What the driver sees of the car: speed and gear large in the middle, the shift lights over
 * them, the pedals beside, DRS and the assists lit when they act, a g-meter, and the lap times.
 */
export class Dashboard {
  private readonly lights: HTMLElement[];
  private readonly gear: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly throttle: HTMLElement;
  private readonly brake: HTMLElement;
  private readonly drs: HTMLElement;
  private readonly traction: HTMLElement;
  private readonly antiLock: HTMLElement;
  private readonly gearbox: HTMLElement;
  private readonly gDot: HTMLElement;
  private readonly gValue: HTMLElement;
  private readonly lapNow: HTMLElement;
  private readonly lapLast: HTMLElement;
  private readonly lapBest: HTMLElement;
  private readonly previousVelocity = new Vector3();
  private readonly smoothedG = new Vector3();
  private readonly frameAcceleration = new Vector3();
  private readonly toCarFrame = new Quaternion();
  private flashing = 0;

  constructor(container: HTMLElement) {
    const cluster = element('div', 'cluster', container);
    const lights = element('div', 'shift-lights', cluster);
    this.lights = SHIFT_LIGHTS.map((colour) => element('span', `light ${colour}`, lights));
    const middle = element('div', 'cluster-middle', cluster);
    const pedals = element('div', 'pedals', middle);
    this.throttle = element('span', 'pedal throttle', element('div', 'pedal-track', pedals));
    this.brake = element('span', 'pedal brake', element('div', 'pedal-track', pedals));
    const readout = element('div', 'readout', middle);
    this.gear = element('div', 'gear', readout, 'N');
    this.speed = element('div', 'speed', readout, '0');
    element('div', 'unit', readout, 'km/h');
    const badges = element('div', 'badges', middle);
    this.drs = element('span', 'badge drs', badges, 'DRS');
    this.traction = element('span', 'badge', badges, 'TC');
    this.antiLock = element('span', 'badge', badges, 'ABS');
    this.gearbox = element('span', 'badge mode', badges, 'AUTO');

    const meter = element('div', 'g-meter', container);
    element('span', 'g-ring', meter);
    element('span', 'g-ring inner', meter);
    this.gDot = element('span', 'g-dot', meter);
    this.gValue = element('span', 'g-value', meter, '0.0 g');

    const laps = element('div', 'laps', container);
    element('div', 'lap-label', laps, 'LAP');
    this.lapNow = element('div', 'lap-now', laps, lapTime(0));
    const lastRow = element('div', 'lap-row', laps);
    element('span', 'lap-label', lastRow, 'LAST');
    this.lapLast = element('span', 'lap-time', lastRow, lapTime(undefined));
    const bestRow = element('div', 'lap-row', laps);
    element('span', 'lap-label', bestRow, 'BEST');
    this.lapBest = element('span', 'lap-time best', bestRow, lapTime(undefined));
  }

  update(car: F1Car, laps: Laps, frameDelta: number): void {
    const powertrain = car.powertrain;
    this.speed.textContent = String(Math.round(Math.abs(car.speed) * 3.6));
    this.gear.textContent = String(powertrain.gear);
    // the lights fill toward the shift point, and all flash on the limiter
    this.flashing = powertrain.limiting ? this.flashing + frameDelta : 0;
    const lit = Math.round(((powertrain.rpm - LIGHTS_FROM) / (LIGHTS_TO - LIGHTS_FROM)) * SHIFT_LIGHTS.length);
    const flashOff = powertrain.limiting && Math.floor(this.flashing * 12) % 2 === 1;
    this.lights.forEach((light, index) => light.classList.toggle('on', !flashOff && (powertrain.limiting || index < lit)));

    this.throttle.style.transform = `scaleY(${car.input.throttle})`;
    this.brake.style.transform = `scaleY(${car.input.brake})`;
    this.drs.classList.toggle('on', car.aerodynamics.drsOpen);
    this.traction.classList.toggle('on', car.tractionControl);
    this.traction.classList.toggle('acting', car.tractionCut > 0.02);
    this.antiLock.classList.toggle('on', car.antiLock);
    this.antiLock.classList.toggle('acting', car.antiLockCut > 0.02);
    this.gearbox.textContent = powertrain.automatic ? 'AUTO' : 'MAN';

    // the car's acceleration over the frame, in its own frame, smoothed to read
    if (frameDelta > 0) {
      this.frameAcceleration.subVectors(car.body.velocity, this.previousVelocity).divideScalar(frameDelta * 9.81);
      this.previousVelocity.copy(car.body.velocity);
      this.frameAcceleration.applyQuaternion(this.toCarFrame.copy(car.body.quaternion).invert());
      this.smoothedG.lerp(this.frameAcceleration, 1 - Math.exp(-frameDelta * 8));
    }
    // where the driver is thrown: right as the car is pushed to its left, up the meter braking
    const across = this.smoothedG.x / G_METER_REACH;
    const along = this.smoothedG.z / G_METER_REACH;
    const withinEdge = Math.min(1, 1 / Math.max(Math.hypot(across, along), 1e-9));
    this.gDot.style.left = `${50 + across * withinEdge * 50}%`;
    this.gDot.style.top = `${50 + along * withinEdge * 50}%`;
    this.gValue.textContent = `${Math.hypot(this.smoothedG.x, this.smoothedG.z).toFixed(1)} g`;

    this.lapNow.textContent = lapTime(laps.current);
    this.lapLast.textContent = lapTime(laps.last);
    this.lapBest.textContent = lapTime(laps.best);
  }
}
