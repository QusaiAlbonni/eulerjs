import { Filter, glideShare, Noise } from './dsp.js';
import type { SoundParameters } from './dsp.js';
import { EngineVoice, Leveler } from './engine/EngineVoice.js';
import type { VoiceSettings } from './engine/EngineVoice.js';
import { F1_ENGINE } from './engine/f1Engine.js';
import type { EngineDefinition } from './engine/EngineSimulation.js';

// The car's engine heard: engine-sim's simulation (github.com/ange-yaghi/engine-sim, see
// engine/) following the car's revs and throttle, its ignition cut by the limiter and for each
// shift. It renders the sound before the exhaust's impulse response, which the page convolves
// it with, then `EngineFinish` levels it as engine-sim does. The simulation is heavy, so the
// page runs it in a worker a little ahead of the audio, as engine-sim runs its own on a thread.

/** Ignition cut for a shift, in seconds. */
const SHIFT_CUT = 0.03;
/**
 * The simulated exhaust's level into the impulse response: flat out it just reaches the level the
 * leveller holds peaks to, so that idling and coasting stay as much quieter as they are.
 */
const ENGINE_LEVEL = 0.0002;
/** How long the revs take to glide to a new value, in seconds. */
const RPM_GLIDE = 0.025;

export class EngineSound {
  readonly voice: EngineVoice;
  private readonly sampleRate: number;
  private readonly rpmGlide: number;
  private targetRpm = 4000;
  private cutLeft = 0;
  private limiting = false;

  constructor(sampleRate: number, seed = 1, definition: EngineDefinition = F1_ENGINE, settings?: VoiceSettings) {
    this.sampleRate = sampleRate;
    const noise = new Noise(seed);
    this.voice = new EngineVoice(definition, sampleRate, () => noise.chance(), settings);
    this.rpmGlide = glideShare(RPM_GLIDE, sampleRate);
  }

  set(parameters: Pick<SoundParameters, 'rpm' | 'throttle' | 'limiting'>): void {
    this.targetRpm = parameters.rpm;
    this.voice.engine.throttle = parameters.throttle;
    this.limiting = parameters.limiting;
  }

  /** Changing gear: the ignition cut for the shift. */
  shift(): void {
    this.cutLeft = SHIFT_CUT;
  }

  /** Fills `output` with the engine's sound before its exhaust's impulse response. */
  render(output: Float32Array): void {
    const engine = this.voice.engine;
    // a block at a time: the revs glide toward the car's, the ignition cut while the limiter or a shift says
    engine.rpm += (this.targetRpm - engine.rpm) * (1 - (1 - this.rpmGlide) ** output.length);
    engine.ignitionCut = this.limiting || this.cutLeft > 0;
    this.cutLeft = Math.max(this.cutLeft - output.length / this.sampleRate, 0);
    this.voice.render(output);
    for (let index = 0; index < output.length; index++) output[index]! *= ENGINE_LEVEL;
  }
}

/**
 * The engine's sound after its exhaust's impulse response: levelled as engine-sim levels it,
 * its peaks toward a steady level; and from in the car, muffled by the helmet.
 */
export class EngineFinish {
  onboard = 0;
  private readonly leveler: Leveler;
  private readonly helmet: Filter;
  private muffled = 0;
  private readonly glide: number;

  /** `mostGain`: the most the leveller lifts a quiet engine. engine-sim's lifts it by up to 1.9, which makes idling as loud as flat out. */
  constructor(sampleRate: number, mostGain = 1) {
    this.leveler = new Leveler(30_000, 0.00001, mostGain);
    this.helmet = new Filter(sampleRate).lowPass(1500);
    this.glide = glideShare(0.15, sampleRate);
  }

  /** `input` levelled into `output`, −1 to 1. */
  run(input: Float32Array, output: Float32Array): void {
    for (let index = 0; index < input.length; index++) {
      this.muffled += (this.onboard - this.muffled) * this.glide;
      // engine-sim's sound is 16-bit: its leveller aims at 30 000 of 32 767
      const levelled = this.leveler.run(input[index]!) / 32_768;
      const heard = levelled + (this.helmet.run(levelled) - levelled) * this.muffled * 0.7;
      output[index] = Math.max(-1, Math.min(1, heard));
    }
  }
}
