import { Filter, glideShare, Noise, QUIET } from './dsp.js';
import type { SoundParameters } from './dsp.js';

// What the car makes besides its engine: the tyres squealing, the kerbs drummed on, the grass
// and the gravel, and the wind, made as they play.

/** Metres between the ridges across a kerb, as its texture draws them. */
const KERB_RIDGE = 4 / 6;
/** How often the filters are retuned to the glided parameters, in samples. */
const RETUNE_EVERY = 128;
/** Seconds each parameter takes to glide most of the way to a new value. */
/** The squeal builds more slowly than it fades, so that a moment's slip isn't heard. */
const GLIDE = { speed: 0.08, squealUp: 0.2, squealDown: 0.08, surface: 0.03, onboard: 0.15 };

export class GroundSound {
  private readonly sampleRate: number;
  private readonly noise: Noise;
  private readonly target: SoundParameters = { ...QUIET };
  private readonly current: SoundParameters = { ...QUIET };
  private readonly glide: Record<keyof typeof GLIDE, number>;
  private readonly wind: Filter;
  private readonly buffet: Filter;
  /** A sliding tyre's scrub: two broad bands of noise, the rubber tearing across the asphalt. */
  private readonly scrubLow: Filter;
  private readonly scrubHigh: Filter;
  private kerbPhase = 0;
  private readonly kerbTone: Filter;
  private readonly rumble: Filter;
  private readonly crunch: Filter;
  private crunchLevel = 0;
  private untilRetune = 0;

  constructor(sampleRate: number, seed = 1) {
    this.sampleRate = sampleRate;
    this.noise = new Noise(seed);
    this.glide = { speed: glideShare(GLIDE.speed, sampleRate), squealUp: glideShare(GLIDE.squealUp, sampleRate), squealDown: glideShare(GLIDE.squealDown, sampleRate), surface: glideShare(GLIDE.surface, sampleRate), onboard: glideShare(GLIDE.onboard, sampleRate) };
    const filter = () => new Filter(sampleRate);
    this.wind = filter().lowPass(400);
    this.buffet = filter().bandPass(140, 1.4);
    this.scrubLow = filter().bandPass(900, 2.5);
    this.scrubHigh = filter().bandPass(1700, 3);
    this.kerbTone = filter().lowPass(160, 1.2);
    this.rumble = filter().lowPass(170);
    this.crunch = filter().bandPass(1900, 1.1);
  }

  set(parameters: SoundParameters): void {
    Object.assign(this.target, parameters);
  }

  /** Fills `output` with the next samples, −1 to 1. */
  render(output: Float32Array): void {
    const target = this.target;
    const current = this.current;
    const glide = this.glide;
    for (let index = 0; index < output.length; index++) {
      current.speed += (target.speed - current.speed) * glide.speed;
      current.squeal += (target.squeal - current.squeal) * (target.squeal > current.squeal ? glide.squealUp : glide.squealDown);
      current.kerb += (target.kerb - current.kerb) * glide.surface;
      current.rough += (target.rough - current.rough) * glide.surface;
      current.onboard += (target.onboard - current.onboard) * glide.onboard;
      if (--this.untilRetune <= 0) this.retune();
      output[index] = Math.tanh(this.sample(current, 1 / this.sampleRate));
    }
  }

  private sample(current: SoundParameters, secondsPerSample: number): number {
    const noise = this.noise;
    const speed = Math.max(current.speed, 0);
    const rolling = Math.min(speed / 12, 1);
    let sample = 0;

    const windLevel = Math.min(0.2 * (speed / 90) ** 2, 0.3) * (1 + 0.9 * current.onboard);
    if (windLevel > 1e-5) sample += windLevel * (this.wind.run(noise.next()) + 0.7 * this.buffet.run(noise.next()));

    if (current.squeal > 1e-4) {
      // a scrub rather than a tone: a gliding, wavering tone sounds like a cartoon ghost
      const scrub = noise.next();
      sample += current.squeal * rolling * 0.7 * (this.scrubLow.run(scrub) + 0.6 * this.scrubHigh.run(scrub));
    }

    if (current.kerb > 1e-4) {
      // the ridges, drummed on by the tyres
      this.kerbPhase += (speed / KERB_RIDGE) * secondsPerSample;
      this.kerbPhase -= Math.floor(this.kerbPhase);
      sample += current.kerb * rolling * 0.9 * this.kerbTone.run(this.kerbPhase < 0.5 ? 1 : -1);
    }

    if (current.rough > 1e-4) {
      // a low rumble, and on gravel the stones' crunch
      sample += current.rough * rolling * 1.6 * this.rumble.run(noise.next());
      if (noise.chance() < speed * 0.00012 * current.rough) this.crunchLevel = 0.6 + 0.4 * noise.chance();
      sample += current.rough * this.crunch.run(this.crunchLevel * noise.next());
      this.crunchLevel *= 0.992;
    }
    return sample;
  }

  private retune(): void {
    this.untilRetune = RETUNE_EVERY;
    this.wind.lowPass(250 + 14 * this.current.speed);
  }
}
