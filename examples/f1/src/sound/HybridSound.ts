import { glideShare, QUIET } from './dsp.js';
import type { SoundParameters } from './dsp.js';
import { F1_ENGINE } from './engine/f1Engine.js';

// The hybrid power unit's whine, beside the engine: the MGU-K, the electric motor geared to the
// crankshaft, singing at its electrical frequency as it drives the car out of corners and, loudest,
// as it brakes it into them, recovering the energy; and the turbocharger with the MGU-H on its
// shaft, whistling at the shaft's speed as it spools up, and falling quiet as the throttle closes.
// Geared to the crankshaft, the MGU-K's note keeps a fixed interval above the engine's: the two
// rise and fall together through the gears.

/** The MGU-K turns at most 50 000 rpm to the engine's 15 000, as the rules have it: 3⅓ times the engine. */
const MGU_K_RATIO = 50_000 / 15_000;
/** Its magnets' pole pairs: its electrical frequency is its speed times these. An assumption: the teams don't say. */
const MGU_K_POLE_PAIRS = 4;
/** The turbo's shaft speed, in rpm: held up by the MGU-H off the throttle, and the rules' most, 125 000, fully spooled. */
const TURBO_HELD = 40_000;
const TURBO_MOST = 125_000;

/**
 * How loud each whine is, at its most: flat out the two together about 16 dB under the engine,
 * and braking, the MGU-K harvesting, about 7 dB under the engine coasting.
 */
const MGU_K_LEVEL = 0.127;
const TURBO_LEVEL = 0.085;
/** Their harmonics' levels, against the fundamental's. */
const MGU_K_HARMONICS = [1, 0.35, 0.18, 0, 0, 0.08] as const;
const TURBO_HARMONICS = [1, 0.5, 0.25] as const;
/** How loud the whistle stays off the throttle, the MGU-H holding the turbo spinning, as a share of its most. */
const TURBO_HELD_LEVEL = 0.1;

/**
 * Seconds the revs, the whines' levels and the whistle's pitch take to glide most of the way to
 * new values: the revs as the engine's sound glides them, so that the MGU-K keeps in step with it;
 * the whistle's pitch falling as quickly as its level, the MGU-H braking the turbo as it harvests.
 */
const GLIDE = { rpm: 0.025, level: 0.08, whistleUp: F1_ENGINE.boost.spoolUp, whistleDown: 0.12 };

export class HybridSound {
  private readonly sampleRate: number;
  private readonly target: SoundParameters = { ...QUIET };
  private readonly glide: { rpm: number; level: number };
  private rpm = QUIET.rpm;
  private motorLevel = 0;
  private turboLevel = 0;
  /** How far the turbo has spooled, 0 to 1. */
  private spool = 0;
  private motorPhase = 0;
  private turboPhase = 0;
  private firingPhase = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.glide = { rpm: glideShare(GLIDE.rpm, sampleRate), level: glideShare(GLIDE.level, sampleRate) };
  }

  set(parameters: SoundParameters): void {
    Object.assign(this.target, parameters);
  }

  /** How hard the MGU-K works, 0 to 1: harvesting under braking at speed, deploying on the throttle, a little harvesting coasting. */
  private motorWork(): number {
    const { throttle, brake, speed } = this.target;
    const moving = Math.min(Math.max((speed - 5) / 15, 0), 1);
    const harvesting = Math.max(brake, throttle < 0.05 ? 0.3 : 0) * moving;
    const deploying = throttle * Math.min(speed / 10, 1) * 0.8;
    return Math.min(Math.max(harvesting, deploying), 1);
  }

  /** Fills `output` with the next samples. */
  render(output: Float32Array): void {
    const target = this.target;
    const { boost } = F1_ENGINE;
    const secondsPerSample = 1 / this.sampleRate;
    const motorTarget = this.motorWork();
    // the turbo spools with the throttle and the revs, as the engine's simulation has it
    const spoolTarget = target.throttle * Math.min(Math.max((target.rpm - boost.fromRpm) / (boost.fullRpm - boost.fromRpm), 0), 1);
    const turboTarget = TURBO_HELD_LEVEL + (1 - TURBO_HELD_LEVEL) * target.throttle;
    for (let index = 0; index < output.length; index++) {
      this.rpm += (target.rpm - this.rpm) * this.glide.rpm;
      this.motorLevel += (motorTarget - this.motorLevel) * this.glide.level;
      this.turboLevel += (turboTarget - this.turboLevel) * this.glide.level;
      this.spool += (spoolTarget - this.spool) * (secondsPerSample / (spoolTarget > this.spool ? GLIDE.whistleUp : GLIDE.whistleDown));

      // the MGU-K, its note a fixed interval above the engine's, rippling with the engine's firings
      this.motorPhase = wrap(this.motorPhase + ((this.rpm * MGU_K_RATIO) / 60) * MGU_K_POLE_PAIRS * secondsPerSample);
      this.firingPhase = wrap(this.firingPhase + (this.rpm / 20) * secondsPerSample);
      const ripple = 1 + 0.15 * Math.sin(2 * Math.PI * this.firingPhase);
      let sample = MGU_K_LEVEL * this.motorLevel * ripple * harmonics(this.motorPhase, MGU_K_HARMONICS);

      // the turbo's shaft, its whistle rising as it spools and as the air through it grows
      const shaftRpm = TURBO_HELD + (TURBO_MOST - TURBO_HELD) * this.spool;
      this.turboPhase = wrap(this.turboPhase + (shaftRpm / 60) * secondsPerSample);
      sample += TURBO_LEVEL * this.turboLevel * (0.3 + 0.7 * this.spool) * harmonics(this.turboPhase, TURBO_HARMONICS);
      output[index] = sample;
    }
  }
}

/** A tone of these harmonics' levels at `phase`, 0 to 1 of its fundamental's cycle, scaled to peak near 1. */
function harmonics(phase: number, levels: readonly number[]): number {
  let sum = 0;
  let total = 0;
  for (let harmonic = 0; harmonic < levels.length; harmonic++) {
    const level = levels[harmonic]!;
    if (level === 0) continue;
    sum += level * Math.sin(2 * Math.PI * (harmonic + 1) * phase);
    total += level;
  }
  return sum / total;
}

const wrap = (phase: number) => phase - Math.floor(phase);
