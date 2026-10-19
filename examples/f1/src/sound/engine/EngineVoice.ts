import { EngineSimulation } from './EngineSimulation.js';
import type { EngineDefinition } from './EngineSimulation.js';

// engine-sim's synthesizer (github.com/ange-yaghi/engine-sim, MIT, © 2022 Ange Yaghi; see
// ENGINE_SIM_LICENSE), from the simulated exhaust pressure to sound: brought up to the audio
// rate, smoothed, jittered a little in time, its DC taken out, roughened by air noise, a touch
// of its rate of change mixed in; then convolved with a recording of an exhaust's impulse
// response, which the page does with a ConvolverNode, and levelled. Ported as it is.

/** How engine-sim's synthesizer treats the simulated sound: its AudioParameters, and the engine's hf_gain, jitter and noise. */
export interface VoiceSettings {
  /** The cutoff of the low-pass the simulated pressure is brought up to the audio rate through, in Hz. */
  antialiasCutoff: number;
  /** How much the sound is shifted about in time, 0 to 1, and how fast that wanders, in Hz. */
  jitter: number;
  jitterCutoff: number;
  /** How much of the sound is air noise, 0 to 1, and its cutoff, in Hz. */
  airNoise: number;
  airNoiseCutoff: number;
  /** How much of the pressure's rate of change is mixed in. */
  highFrequencyGain: number;
}

/** engine-sim's defaults and the LFA's jitter; the cutoff higher than its 1900 Hz, which suits its slower 6.5 kHz simulation, for our 10 kHz one. */
export const ENGINE_SIM_VOICE: VoiceSettings = { antialiasCutoff: 4000, jitter: 0.1, jitterCutoff: 10_000, airNoise: 1, airNoiseCutoff: 2000, highFrequencyGain: 0.01 };

/** The most samples the jitter shifts the sound by. */
const MOST_JITTER = 10;

/** A fourth-order Butterworth low-pass filter, as engine-sim's. */
export class Butterworth {
  private readonly inputs = new Float64Array(4);
  private readonly outputs = new Float64Array(4);
  private gain = 0;
  private readonly coefficients = new Float64Array(5);

  constructor(cutoff: number, sampleRate: number) {
    const warped = Math.tan((Math.PI * Math.min(cutoff, sampleRate * 0.49)) / sampleRate);
    const squared = warped * warped;
    const cubed = squared * warped;
    const fourth = squared * squared;
    const first = -2 * Math.cos((5 * Math.PI) / 8);
    const second = -2 * Math.cos((7 * Math.PI) / 8);
    const sum = first + second;
    const product = first * second;
    const lead = 1 + sum * warped + (2 + product) * squared + sum * cubed + fourth;
    this.coefficients[0] = lead;
    this.coefficients[1] = (-4 - 2 * sum * warped + 2 * sum * cubed + 4 * fourth) / lead;
    this.coefficients[2] = (6 - 2 * (2 + product) * squared + 6 * fourth) / lead;
    this.coefficients[3] = (-4 + 2 * sum * warped - 2 * sum * cubed + 4 * fourth) / lead;
    this.coefficients[4] = (1 - sum * warped + (2 + product) * squared - sum * cubed + fourth) / lead;
    this.gain = fourth;
  }

  run(sample: number): number {
    const inputs = this.inputs;
    const outputs = this.outputs;
    const coefficients = this.coefficients;
    // inputs[0] and outputs[0] the latest
    const filtered = (this.gain / coefficients[0]!) * (sample + 4 * inputs[0]! + 6 * inputs[1]! + 4 * inputs[2]! + inputs[3]!);
    const output = filtered - coefficients[1]! * outputs[0]! - coefficients[2]! * outputs[1]! - coefficients[3]! * outputs[2]! - coefficients[4]! * outputs[3]!;
    inputs.copyWithin(1, 0, 3);
    inputs[0] = sample;
    outputs.copyWithin(1, 0, 3);
    outputs[0] = output;
    return output;
  }
}

/** One exhaust's sound on its way from the simulation to the convolution. */
class Channel {
  previous = 0;
  latest = 0;
  readonly antialias: Butterworth;
  readonly jitterNoise: Butterworth;
  readonly airNoise: Butterworth;
  readonly history = new Float64Array(MOST_JITTER);
  historyIndex = 0;
  dcLevel = 0;
  lastSample = 0;

  constructor(settings: VoiceSettings, sampleRate: number) {
    this.antialias = new Butterworth(settings.antialiasCutoff, sampleRate);
    this.jitterNoise = new Butterworth(settings.jitterCutoff, sampleRate);
    this.airNoise = new Butterworth(settings.airNoiseCutoff, sampleRate);
  }
}

/**
 * The engine's voice: the simulation run at its own rate, and its exhaust's sound brought to the
 * audio rate, ready for the impulse response. Set `rpm`, `throttle` and `ignitionCut` on
 * `engine`; `render` fills a block.
 */
export class EngineVoice {
  readonly engine: EngineSimulation;
  private readonly settings: VoiceSettings;
  private readonly channels: Channel[] = [];
  private readonly stepsPerSample: number;
  private readonly dcShare: number;
  private readonly sampleRate: number;
  private readonly random: () => number;
  private phase = 0;

  constructor(definition: EngineDefinition, sampleRate: number, random: () => number, settings: VoiceSettings = ENGINE_SIM_VOICE) {
    this.engine = new EngineSimulation(definition, random);
    this.settings = settings;
    this.sampleRate = sampleRate;
    this.random = random;
    this.stepsPerSample = definition.simulationFrequency / sampleRate;
    const timestep = 1 / sampleRate;
    const dcTime = 1 / (2 * Math.PI * 10);
    this.dcShare = timestep / (dcTime + timestep);
    for (let index = 0; index < definition.exhaust.lengths.length; index++) this.channels.push(new Channel(settings, sampleRate));
  }

  /** Fills `output` with the engine's sound before its exhaust's impulse response. */
  render(output: Float32Array): void {
    const channels = this.channels;
    const engine = this.engine;
    const settings = this.settings;
    const random = this.random;
    const derivativeScale = settings.highFrequencyGain * this.sampleRate;
    for (let index = 0; index < output.length; index++) {
      this.phase += this.stepsPerSample;
      while (this.phase >= 1) {
        this.phase -= 1;
        engine.step();
        for (let channel = 0; channel < channels.length; channel++) {
          channels[channel]!.previous = channels[channel]!.latest;
          channels[channel]!.latest = engine.output[channel]!;
        }
      }
      let signal = 0;
      for (const channel of channels) {
        // brought up to the audio rate, between the last two steps, and smoothed
        const upsampled = channel.antialias.run(channel.previous + (channel.latest - channel.previous) * this.phase);
        // shifted about in time by a few samples, wandering
        channel.history[channel.historyIndex] = upsampled;
        channel.historyIndex = (channel.historyIndex + 1) % MOST_JITTER;
        const shift = channel.jitterNoise.run(random() * (MOST_JITTER - 1) * settings.jitter);
        const lower = Math.min(Math.max(Math.floor(shift), 0), MOST_JITTER - 1);
        const upper = Math.min(Math.max(Math.ceil(shift), 0), MOST_JITTER - 1);
        const between = shift - lower;
        const jittered = channel.history[(lower + channel.historyIndex) % MOST_JITTER]! * (1 - between) + channel.history[(upper + channel.historyIndex) % MOST_JITTER]! * between;
        // its DC out, roughened by air noise, and a touch of its rate of change
        channel.dcLevel += (jittered - channel.dcLevel) * this.dcShare;
        const steady = jittered - channel.dcLevel;
        const change = (jittered - channel.lastSample) * derivativeScale;
        channel.lastSample = jittered;
        const noise = settings.airNoise * channel.airNoise.run(2 * random() - 1) + (1 - settings.airNoise);
        signal += change + steady * noise * (1 - settings.highFrequencyGain);
      }
      output[index] = signal;
    }
  }
}

/** engine-sim's leveller: follows the sound's peaks and scales them toward a target, by at most `most`. */
export class Leveler {
  private peak: number;
  private attenuation = 1;
  private readonly target: number;
  private readonly least: number;
  private readonly most: number;

  constructor(target = 30_000, least = 0.00001, most = 1.9) {
    this.peak = target;
    this.target = target;
    this.least = least;
    this.most = most;
  }

  run(sample: number): number {
    this.peak *= 0.999;
    if (Math.abs(sample) > this.peak) this.peak = Math.abs(sample);
    if (this.peak === 0) return 0;
    const wanted = Math.min(Math.max(this.target / this.peak, this.least), this.most);
    this.attenuation = 0.9 * this.attenuation + 0.1 * wanted;
    return sample * this.attenuation;
  }
}
