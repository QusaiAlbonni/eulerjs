// Small pieces of signal processing the car's sounds share.

/** What the car is doing, as its sound follows it. */
export interface SoundParameters {
  /** The engine's speed, in rpm. */
  rpm: number;
  /** The throttle and the brake, 0 to 1. */
  throttle: number;
  brake: number;
  /** Whether the limiter is cutting the ignition. */
  limiting: boolean;
  /** How fast the car goes, in m/s. */
  speed: number;
  /** How hard the tyres squeal, 0 to 1. */
  squeal: number;
  /** The share of the wheels on the kerbs, 0 to 1. */
  kerb: number;
  /** The share of the wheels on grass or gravel, 0 to 1, gravel counting fully and grass half. */
  rough: number;
  /** 1 heard from in the car, through a helmet; 0 from behind it. */
  onboard: number;
}

export const QUIET: SoundParameters = { rpm: 4000, throttle: 0, brake: 0, limiting: false, speed: 0, squeal: 0, kerb: 0, rough: 0, onboard: 0 };

/** The share a value glides each sample toward its target, to get most of the way in `seconds`. */
export const glideShare = (seconds: number, sampleRate: number) => 1 - Math.exp(-1 / (seconds * sampleRate));

/** A biquad filter, as in the Audio EQ Cookbook. */
export class Filter {
  private feedForward0 = 0;
  private feedForward1 = 0;
  private feedForward2 = 0;
  private feedBack1 = 0;
  private feedBack2 = 0;
  private input1 = 0;
  private input2 = 0;
  private output1 = 0;
  private output2 = 0;
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** Passes a band round `frequency` in Hz, its peak at the input's level; narrower the higher `resonance`. */
  bandPass(frequency: number, resonance: number): this {
    const { cosine, alpha } = this.angles(frequency, resonance);
    return this.set(alpha, 0, -alpha, 1 + alpha, -2 * cosine, 1 - alpha);
  }

  lowPass(frequency: number, resonance = Math.SQRT1_2): this {
    const { cosine, alpha } = this.angles(frequency, resonance);
    return this.set((1 - cosine) / 2, 1 - cosine, (1 - cosine) / 2, 1 + alpha, -2 * cosine, 1 - alpha);
  }

  run(input: number): number {
    const output = this.feedForward0 * input + this.feedForward1 * this.input1 + this.feedForward2 * this.input2 - this.feedBack1 * this.output1 - this.feedBack2 * this.output2;
    this.input2 = this.input1;
    this.input1 = input;
    this.output2 = this.output1;
    this.output1 = output;
    return output;
  }

  private angles(frequency: number, resonance: number): { cosine: number; alpha: number } {
    const angle = (2 * Math.PI * Math.min(frequency, this.sampleRate * 0.45)) / this.sampleRate;
    return { cosine: Math.cos(angle), alpha: Math.sin(angle) / (2 * resonance) };
  }

  private set(forward0: number, forward1: number, forward2: number, back0: number, back1: number, back2: number): this {
    this.feedForward0 = forward0 / back0;
    this.feedForward1 = forward1 / back0;
    this.feedForward2 = forward2 / back0;
    this.feedBack1 = back1 / back0;
    this.feedBack2 = back2 / back0;
    return this;
  }
}

/** Noise from a seed, the same every run: −1 to 1. */
export class Noise {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    let state = this.state;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.state = state >>> 0;
    return this.state / 2_147_483_648 - 1;
  }

  /** 0 to 1. */
  chance(): number {
    return (this.next() + 1) / 2;
  }
}
