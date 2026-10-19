import { readFileSync } from 'node:fs';
import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, PlaneCollider, World } from '@eulerjs/core';
import { F1Car } from '../src/car/F1Car.js';
import { SPECIFICATION } from '../src/car/specification.js';
import { QUIET } from '../src/sound/dsp.js';
import type { SoundParameters } from '../src/sound/dsp.js';
import { EngineSimulation } from '../src/sound/engine/EngineSimulation.js';
import { F1_ENGINE } from '../src/sound/engine/f1Engine.js';
import { exhaustResponse } from '../src/sound/engine/impulseResponse.js';
import { EngineFinish, EngineSound } from '../src/sound/EngineSound.js';
import { GroundSound } from '../src/sound/GroundSound.js';
import { HybridSound } from '../src/sound/HybridSound.js';
import { soundParametersOf } from '../src/sound/soundParameters.js';

// The car's sound, checked by numbers. The engine first: engine-sim's simulation, ported, must
// behave as an engine does (its cylinders' pressures, its boost, its power, what closing the
// throttle and cutting the ignition do); then its sound, its note where six cylinders firing
// every two turns put it, through the exhaust's impulse response and levelled as engine-sim
// levels it. Then the tyres, and what the car tells the sound.

const SAMPLE_RATE = 44_100;
const BAR = 100_000;

/** A second of the engine simulated at `rpm` and `throttle`, after one to settle: its highest cylinder pressure, its mean plenum pressure, and its indicated power, from the work its gas does on the pistons. */
function runEngine(rpm: number, throttle: number, ignitionCut = false): { peakPressure: number; plenumPressure: number; power: number } {
  const engine = new EngineSimulation(F1_ENGINE, () => 0.5);
  engine.rpm = rpm;
  engine.throttle = throttle;
  engine.ignitionCut = ignitionCut;
  const steps = F1_ENGINE.simulationFrequency;
  for (let step = 0; step < steps; step++) engine.step();
  let peakPressure = 0;
  let plenumPressure = 0;
  let work = 0;
  const volumes = engine.cylinders.map((cylinder) => cylinder.gas.volume);
  const pressures = engine.cylinders.map((cylinder) => cylinder.gas.pressure());
  for (let step = 0; step < steps; step++) {
    engine.step();
    engine.cylinders.forEach((cylinder, index) => {
      const pressure = cylinder.gas.pressure();
      work += 0.5 * (pressure + pressures[index]!) * (cylinder.gas.volume - volumes[index]!);
      volumes[index] = cylinder.gas.volume;
      pressures[index] = pressure;
      peakPressure = Math.max(peakPressure, pressure);
    });
    plenumPressure += engine.plenum.pressure() / steps;
  }
  return { peakPressure, plenumPressure, power: work };
}

/** `seconds` of the engine's sound before the impulse response, after a second to settle, rendered a block at a time. */
function engineSound(parameters: Partial<SoundParameters>, seconds: number, seed = 3): Float32Array {
  const sound = new EngineSound(SAMPLE_RATE, seed);
  sound.set({ ...QUIET, ...parameters });
  const block = new Float32Array(128);
  for (let index = 0; index < SAMPLE_RATE / 128; index++) sound.render(block);
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let start = 0; start < samples.length; start += 128) sound.render(samples.subarray(start, Math.min(start + 128, samples.length)));
  return samples;
}

/** engine-sim's recording of the exhaust's impulse response, made ready as the page makes it. */
function impulseResponse(): Float32Array {
  const file = readFileSync(new URL('../src/sound/engine/minimal_muffling_01.wav', import.meta.url));
  // a plain 16-bit mono WAV: find its data chunk
  let offset = 12;
  while (file.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + file.readUInt32LE(offset + 4);
  const recording = new Float32Array(file.readUInt32LE(offset + 4) / 2);
  for (let index = 0; index < recording.length; index++) recording[index] = file.readInt16LE(offset + 8 + index * 2) / 32_768;
  return exhaustResponse(recording, SAMPLE_RATE);
}

/** `samples` through `response`, as the ConvolverNode does. */
function convolve(samples: Float32Array, response: Float32Array): Float32Array {
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    if (sample === 0) continue;
    const end = Math.min(response.length, samples.length - index);
    for (let tap = 0; tap < end; tap++) output[index + tap]! += sample * response[tap]!;
  }
  return output;
}

/** The power in `samples` at `frequency`, by Goertzel's algorithm. */
function powerAt(samples: Float32Array, frequency: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
  let previous = 0;
  let beforeThat = 0;
  for (const sample of samples) {
    const next = sample + coefficient * previous - beforeThat;
    beforeThat = previous;
    previous = next;
  }
  return (previous * previous + beforeThat * beforeThat - coefficient * previous * beforeThat) / samples.length ** 2;
}

const rootMeanSquare = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

describe('the engine, engine-sim’s simulation ported', () => {
  it('flat out at 11 000 rpm makes what a Formula 1 engine makes', () => {
    const flatOut = runEngine(11_000, 1);
    // boosted to about 3.5 bar absolute; its cylinders peaking at 200 to 250 bar, as these engines' do
    expect(flatOut.plenumPressure / BAR).toBeGreaterThan(3);
    expect(flatOut.plenumPressure / BAR).toBeLessThan(4);
    expect(flatOut.peakPressure / BAR).toBeGreaterThan(180);
    expect(flatOut.peakPressure / BAR).toBeLessThan(280);
    // the engine alone gives about 550 kW; the hybrid adds 120 kW more, which isn't heard
    expect(flatOut.power / 1000).toBeGreaterThan(380);
    expect(flatOut.power / 1000).toBeLessThan(700);
  });

  it('with the throttle closed at speed draws a vacuum and, its fuel cut back, burns lean, making a fraction of its power', () => {
    const closed = runEngine(11_000, 0);
    const flatOut = runEngine(11_000, 1);
    expect(closed.plenumPressure / BAR).toBeLessThan(0.6);
    expect(closed.peakPressure).toBeLessThan(0.5 * flatOut.peakPressure);
    expect(closed.power).toBeLessThan(0.35 * flatOut.power);
  });

  it('with its ignition cut burns nothing, whatever the throttle', () => {
    const cut = runEngine(11_000, 1, true);
    // still boosted, the charge is only compressed, to well below what burning it reaches
    expect(cut.peakPressure).toBeLessThan(0.9 * runEngine(11_000, 1).peakPressure);
    expect(cut.power).toBeLessThan(0);
  });

  it('makes less power lower down, where the turbo has spooled less', () => {
    expect(runEngine(6000, 1).power).toBeLessThan(0.8 * runEngine(11_000, 1).power);
  });
});

describe('the engine’s sound', () => {
  it.each([7000, 11_000])('has its note at %i rpm where six cylinders firing every two turns put it', (rpm) => {
    const samples = engineSound({ rpm, throttle: 1 }, 1);
    const firing = (rpm / 60) * 3;
    // the firing note and its first harmonic, against frequencies between the cycle's harmonics
    const onNote = powerAt(samples, firing) + powerAt(samples, 2 * firing);
    const offNote = powerAt(samples, firing * 1.125) + powerAt(samples, firing * 1.875);
    expect(onNote).toBeGreaterThan(10 * offNote);
  });

  it('is louder with the throttle open than closed, and falls quiet with the ignition cut', () => {
    const open = rootMeanSquare(engineSound({ rpm: 10_000, throttle: 1 }, 0.5));
    const closed = rootMeanSquare(engineSound({ rpm: 10_000, throttle: 0 }, 0.5));
    const cut = rootMeanSquare(engineSound({ rpm: 10_000, throttle: 1, limiting: true }, 0.5));
    expect(open).toBeGreaterThan(3 * closed);
    expect(open).toBeGreaterThan(3 * cut);
  });

  it('through the exhaust’s impulse response, levelled to a steady level within −1 and 1', () => {
    const response = impulseResponse();
    const finish = new EngineFinish(SAMPLE_RATE);
    const heard = new Float32Array(SAMPLE_RATE / 2);
    finish.run(convolve(engineSound({ rpm: 11_000, throttle: 1 }, 0.5), response), heard);
    const loudest = heard.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0);
    expect(heard.every(Number.isFinite)).toBe(true);
    expect(loudest).toBeLessThanOrEqual(1);
    // the leveller brings its peaks up toward 30 000 of 32 767
    expect(loudest).toBeGreaterThan(0.5);
  });

  it('stays steady through everything the car does: revs up and down, throttle on and off, the ignition cut', () => {
    const sound = new EngineSound(SAMPLE_RATE, 9);
    const block = new Float32Array(128);
    for (let index = 0; index < (SAMPLE_RATE * 6) / 128; index++) {
      const time = (index * 128) / SAMPLE_RATE;
      // up through the gears and back down, lifting and cutting now and then
      const rpm = 4000 + 9000 * Math.abs(Math.sin(time * 0.8));
      sound.set({ rpm, throttle: Math.sin(time * 3) > -0.3 ? 1 : 0, limiting: rpm > 12_800 });
      if (index % 300 === 0) sound.shift();
      sound.render(block);
      expect(block.every(Number.isFinite)).toBe(true);
    }
  });

  it('is louder flat out than idling, idling as a hot racing engine does, and brighter', () => {
    const response = impulseResponse();
    const heard = (parameters: Partial<SoundParameters>) => {
      const finished = new Float32Array(SAMPLE_RATE / 2);
      new EngineFinish(SAMPLE_RATE).run(convolve(engineSound(parameters, 0.5), response), finished);
      return finished.subarray(SAMPLE_RATE / 10);
    };
    const idling = heard({ rpm: 4000, throttle: 0 });
    const flatOut = heard({ rpm: 11_000, throttle: 1 });
    expect(rootMeanSquare(flatOut)).toBeGreaterThan(3 * rootMeanSquare(idling));
    // flat out, the firing note's harmonics high up: above 1.2 kHz, where at idle there is little
    const highShare = (samples: Float32Array) => {
      let high = 0;
      for (let frequency = 1200; frequency < 5000; frequency += 10) high += powerAt(samples, frequency);
      let all = 0;
      for (let frequency = 10; frequency < 5000; frequency += 10) all += powerAt(samples, frequency);
      return high / all;
    };
    expect(highShare(flatOut)).toBeGreaterThan(1.5 * highShare(idling));
    // and lifting off at speed burbles between the two: neither silent nor blaring
    const lifting = rootMeanSquare(heard({ rpm: 9000, throttle: 0 }));
    expect(lifting).toBeGreaterThan(1.5 * rootMeanSquare(idling));
    expect(lifting).toBeLessThan(0.7 * rootMeanSquare(flatOut));
  });

  it('is heard in the open air: the exhaust’s response dies away within 15 ms, not ringing on as in a room', () => {
    const response = impulseResponse();
    expect(response.length).toBeLessThanOrEqual(Math.round(0.015 * SAMPLE_RATE));
    const energy = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample * sample, 0);
    // its last few milliseconds faded away to next to nothing
    expect(energy(response.subarray(Math.round(response.length * 0.8)))).toBeLessThan(0.02 * energy(response));
  });

  it('is the same every time from the same seed', () => {
    const first = engineSound({ rpm: 9000, throttle: 0.7 }, 0.2, 5);
    const second = engineSound({ rpm: 9000, throttle: 0.7 }, 0.2, 5);
    expect(first.every((sample, index) => sample === second[index])).toBe(true);
  });
});

describe('the hybrid’s whine', () => {
  const listen = (parameters: Partial<SoundParameters>, seconds = 1) => {
    const hybrid = new HybridSound(SAMPLE_RATE);
    hybrid.set({ ...QUIET, ...parameters });
    const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
    // settled: the turbo spooled, the levels glided
    for (let pass = 0; pass < 3; pass++) hybrid.render(samples);
    return samples;
  };

  it('has the MGU-K singing where its gearing to the crankshaft puts it, a fixed interval above the engine’s note', () => {
    for (const rpm of [6000, 11_000]) {
      const samples = listen({ rpm, brake: 1, speed: 60 });
      // 3⅓ times the engine's speed, 4 pole pairs: 4.44 times the firing note
      const whine = ((rpm * 50) / 15 / 60) * 4;
      expect(powerAt(samples, whine)).toBeGreaterThan(30 * powerAt(samples, whine * 1.06));
    }
  });

  it('whines loudest harvesting under braking at speed, and hardly at all crawling', () => {
    const braking = rootMeanSquare(listen({ rpm: 9000, brake: 1, speed: 60 }));
    const crawling = rootMeanSquare(listen({ rpm: 4000, throttle: 0.1, speed: 2 }));
    expect(braking).toBeGreaterThan(3 * crawling);
  });

  it('has the turbo whistling higher as it spools, held spinning off the throttle', () => {
    // standing still, the MGU-K silent: the turbo alone
    const spooled = listen({ rpm: 11_000, throttle: 1 });
    const held = listen({ rpm: 4000, throttle: 0 });
    // its shaft at 125 000 rpm flat out, at 40 000 held up by the MGU-H
    const fullShaft = 125_000 / 60;
    const heldShaft = 40_000 / 60;
    expect(powerAt(spooled, fullShaft)).toBeGreaterThan(10 * powerAt(spooled, heldShaft));
    expect(powerAt(held, heldShaft)).toBeGreaterThan(10 * powerAt(held, fullShaft));
    expect(rootMeanSquare(spooled)).toBeGreaterThan(rootMeanSquare(held));
  });

  it('has the turbo’s whistle fall quiet within a fifth of a second of lifting off, not sliding down long after', () => {
    const hybrid = new HybridSound(SAMPLE_RATE);
    hybrid.set({ ...QUIET, rpm: 11_000, throttle: 1 });
    const tenth = new Float32Array(SAMPLE_RATE / 10);
    for (let pass = 0; pass < 30; pass++) hybrid.render(tenth);
    const flatOut = rootMeanSquare(tenth);
    hybrid.set({ ...QUIET, rpm: 11_000, throttle: 0 });
    hybrid.render(tenth);
    hybrid.render(tenth);
    expect(rootMeanSquare(tenth)).toBeLessThan(0.2 * flatOut);
  });

  it('stays well within −1 and 1, under the engine', () => {
    const samples = listen({ rpm: 13_000, throttle: 1, brake: 1, speed: 90 });
    expect(samples.every((sample) => Math.abs(sample) < 0.5)).toBe(true);
  });
});

describe('the tyres and the ground', () => {
  const listen = (parameters: Partial<SoundParameters>) => {
    const ground = new GroundSound(SAMPLE_RATE, 3);
    ground.set({ ...QUIET, ...parameters });
    const samples = new Float32Array(SAMPLE_RATE);
    ground.render(samples);
    ground.render(samples);
    return samples;
  };

  it('squeal in their band', () => {
    const quiet = listen({ speed: 40 });
    const squealing = listen({ speed: 40, squeal: 1 });
    const band = (samples: Float32Array) => [1100, 1150, 1200, 1250, 1300].reduce((sum, frequency) => sum + powerAt(samples, frequency), 0);
    expect(band(squealing)).toBeGreaterThan(5 * band(quiet));
  });

  it('stay within −1 and 1 with everything at once', () => {
    const samples = listen({ speed: 95, squeal: 1, kerb: 1, rough: 1, onboard: 1 });
    expect(samples.every((sample) => Math.abs(sample) <= 1)).toBe(true);
  });
});

describe('what the car tells its sound', () => {
  const makeCar = () => {
    const world = new World({ timestep: 1 / 120 });
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 1 })] }));
    const car = new F1Car(world, new Object3D(), new Vector3());
    world.fixedStep();
    return { world, car };
  };
  const parameters = (car: F1Car) => soundParametersOf(car, false, { ...QUIET });

  it('revving on the grid, held on its brakes: the revs up, the throttle open, the tyres quiet', () => {
    const { world, car } = makeCar();
    car.input.brake = 1;
    car.input.throttle = 0.6;
    for (let step = 0; step < 60; step++) world.fixedStep();
    const heard = parameters(car);
    expect(heard.rpm).toBeGreaterThan(SPECIFICATION.engine.idleRpm + 1000);
    expect(heard.throttle).toBe(0.6);
    expect(heard.squeal).toBe(0);
  });

  it('flat out on the straight: the tyres quiet, on asphalt', () => {
    const { world, car } = makeCar();
    car.input.throttle = 1;
    for (let step = 0; step < 120 * 12; step++) world.fixedStep();
    const heard = parameters(car);
    expect(heard.speed).toBeGreaterThan(60);
    expect(heard.squeal).toBe(0);
    expect(heard.kerb + heard.rough).toBe(0);
  });

  it('on the limiter in a gear held: limiting', () => {
    const { world, car } = makeCar();
    car.powertrain.automatic = false;
    car.input.throttle = 1;
    let limited: SoundParameters | undefined;
    for (let step = 0; step < 120 * 4 && !limited; step++) {
      world.fixedStep();
      if (car.powertrain.limiting) limited = parameters(car);
    }
    expect(limited?.limiting).toBe(true);
  });

  it('braking hard with ABS, as the keys brake, from 270 km/h to a stop: the tyres silent, not sliding', () => {
    const { world, car } = makeCar();
    car.input.throttle = 1;
    for (let step = 0; step < 120 * 30 && car.speed < 75; step++) world.fixedStep();
    car.input.throttle = 0;
    let loudest = 0;
    for (let step = 0; step < 120 * 4; step++) {
      car.input.brake = Math.min(car.input.brake + 5 / 120, 1);
      world.fixedStep();
      loudest = Math.max(loudest, parameters(car).squeal);
    }
    expect(car.speed).toBeLessThan(1);
    expect(loudest).toBeLessThan(0.05);
  });

  it('locking its wheels braking hard without ABS: the tyres squeal', () => {
    const { world, car } = makeCar();
    car.antiLock = false;
    car.input.throttle = 1;
    for (let step = 0; step < 120 * 30 && car.speed < 70; step++) world.fixedStep();
    car.input.throttle = 0;
    car.input.brake = 1;
    let loudest = 0;
    for (let step = 0; step < 120; step++) {
      world.fixedStep();
      loudest = Math.max(loudest, parameters(car).squeal);
    }
    expect(loudest).toBeGreaterThan(0.5);
  });
});
