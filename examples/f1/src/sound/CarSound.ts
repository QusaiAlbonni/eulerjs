import type { F1Car } from '../car/F1Car.js';
import { QUIET } from './dsp.js';
import type { SoundParameters } from './dsp.js';
import type { EngineWorkerMessage, LoadMessage } from './engine.worker.js';
import type { CarSoundMessage } from './carSound.worklet.js';
import { exhaustResponse } from './engine/impulseResponse.js';
import impulseResponseUrl from './engine/minimal_muffling_01.wav?url';
import { soundParametersOf } from './soundParameters.js';
import workletUrl from './carSound.worklet.ts?worker&url';

/** The sound's level, 0 to 1. */
const VOLUME = 0.7;
/** engine-sim's sample rate, which its impulse responses were recorded at. */
const SAMPLE_RATE = 44_100;

/**
 * The car heard. The engine is simulated in a worker, as engine-sim simulates it, and played on
 * the audio thread through a recording of an exhaust's impulse response; the tyres, the ground
 * and the wind are made there too. Browsers start sound only once the page has been used, so
 * it starts at the first key or click; `toggleMute` silences it, and it pauses while the page
 * is hidden.
 */
export class CarSound {
  muted = false;
  /** The share of a core the engine's simulation takes in its worker, as it last reported. */
  engineLoad = 0;
  private context: AudioContext | undefined;
  private worker: Worker | undefined;
  private carSound: AudioWorkletNode | undefined;
  private finish: AudioWorkletNode | undefined;
  private level: GainNode | undefined;
  private readonly parameters: SoundParameters = { ...QUIET };
  private gear = 1;

  constructor() {
    const start = () => {
      window.removeEventListener('keydown', start);
      window.removeEventListener('pointerdown', start);
      this.start().catch((error: unknown) => console.warn('No sound:', error));
    };
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
    document.addEventListener('visibilitychange', () => {
      if (!this.context) return;
      if (document.hidden) void this.context.suspend();
      else void this.context.resume();
    });
  }

  /** Tells the sound what the car does now: `onboard` when heard from in it. */
  update(car: F1Car, onboard: boolean): void {
    if (!this.carSound || !this.finish || !this.worker) return;
    const gear = car.powertrain.gear;
    if (gear !== this.gear) this.toWorker({ shift: true });
    this.gear = gear;
    const parameters = soundParametersOf(car, onboard, this.parameters);
    this.toWorker({ parameters });
    const message: CarSoundMessage = { parameters };
    this.carSound.port.postMessage(message);
    this.finish.port.postMessage(message);
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.context && this.level) this.level.gain.setTargetAtTime(this.muted ? 0 : VOLUME, this.context.currentTime, 0.05);
  }

  private async start(): Promise<void> {
    const context = new AudioContext({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE });
    this.context = context;
    const [impulseResponse] = await Promise.all([this.loadImpulseResponse(context), context.audioWorklet.addModule(workletUrl)]);

    const carSound = new AudioWorkletNode(context, 'car-sound', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 2] });
    const exhaust = new ConvolverNode(context, { disableNormalization: true, buffer: impulseResponse });
    const finish = new AudioWorkletNode(context, 'engine-finish', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const level = context.createGain();
    // faded in, rather than starting with a click
    level.gain.setValueAtTime(0, context.currentTime);
    level.gain.setTargetAtTime(this.muted ? 0 : VOLUME, context.currentTime, 0.2);
    carSound.connect(exhaust, 0).connect(finish).connect(level);
    carSound.connect(level, 1);
    // the engine, its whine and the ground can add up past full scale: held under it, rather than clipped
    const limiter = new DynamicsCompressorNode(context, { threshold: -3, knee: 2, ratio: 20, attack: 0.002, release: 0.1 });
    level.connect(limiter).connect(context.destination);

    // the engine's simulation in a worker, sending its sound straight to the worklet
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<LoadMessage>) => {
      this.engineLoad = event.data.load;
    };
    const channel = new MessageChannel();
    const toWorklet: CarSoundMessage = { engine: channel.port2 };
    carSound.port.postMessage(toWorklet, [channel.port2]);
    const startMessage: EngineWorkerMessage = { start: { sampleRate: context.sampleRate, port: channel.port1 } };
    worker.postMessage(startMessage, [channel.port1]);

    this.worker = worker;
    this.carSound = carSound;
    this.finish = finish;
    this.level = level;
    if (context.state === 'suspended') await context.resume();
  }

  /** engine-sim's recording of an exhaust's impulse response, made ready as `exhaustResponse` makes it. */
  private async loadImpulseResponse(context: AudioContext): Promise<AudioBuffer> {
    const decoded = await context.decodeAudioData(await (await fetch(impulseResponseUrl)).arrayBuffer());
    const response = exhaustResponse(decoded.getChannelData(0), decoded.sampleRate);
    const buffer = context.createBuffer(1, response.length, decoded.sampleRate);
    buffer.copyToChannel(response, 0);
    return buffer;
  }

  private toWorker(message: EngineWorkerMessage): void {
    this.worker?.postMessage(message);
  }
}
