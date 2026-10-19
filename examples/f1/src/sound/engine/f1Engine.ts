import { flowConstantOfPort, flowConstantOfThroat } from './GasSystem.js';
import type { EngineDefinition, FlowCurve } from './EngineSimulation.js';

// The car's engine as engine-sim would script it: a modern Formula 1 power unit's 1.6-litre 90°
// V6, 80 mm bore and 53 mm stroke as the rules have it, firing evenly every 120°, the two banks in
// turn, into a collector each and out of one turbocharger. Where its makers keep the numbers to
// themselves (ports, cams, pipes), the values are engine-sim's own for its high-revving engine,
// the Lexus LFA's V10 (assets/engines/atg-video-2/10_lfa_v10.mr), scaled to the smaller cylinders.

const THOU = 0.0000254;
const INCH = 0.0254;
const CC = 1e-6;

/** The LFA's ports on the flow bench: lift in thousandths of an inch against cubic feet a minute. */
const portFlow = (samples: readonly (readonly [number, number])[]): FlowCurve => samples.map(([lift, cfm]) => [lift * THOU, flowConstantOfPort(cfm)] as const);

export const F1_ENGINE: EngineDefinition = {
  bore: 0.08,
  stroke: 0.053,
  rodLength: 0.112,
  // a compression ratio of 15
  chamberVolume: (Math.PI * 0.04 * 0.04 * 0.053) / 14,
  firingAngles: [0, 120, 240, 360, 480, 600],
  banks: [0, 1, 0, 1, 0, 1],
  // the cylinders a few centimetres apart along each bank, and each heard a little unlike the rest
  headerPrimaryLengths: [0.0, 0.0, 0.05, 0.05, 0.1, 0.1],
  soundAttenuation: [0.8, 0.7, 1.0, 0.8, 1.1, 1.1],
  blowby: flowConstantOfPort(0.05),
  head: {
    intakeRunnerVolume: 90 * CC,
    intakeRunnerArea: 1.4 * INCH * 1.4 * INCH,
    exhaustRunnerVolume: 30 * CC,
    exhaustRunnerArea: 1.6 * INCH * 1.6 * INCH,
    intakePortFlow: portFlow([
      [0, 0],
      [50, 58],
      [100, 103],
      [150, 156],
      [200, 214],
      [250, 249],
      [300, 268],
      [350, 280],
      [400, 280],
      [450, 281],
      [500, 281],
    ]),
    exhaustPortFlow: portFlow([
      [0, 0],
      [50, 37],
      [100, 72],
      [150, 113],
      [200, 160],
      [250, 196],
      [300, 222],
      [350, 235],
      [400, 245],
      [450, 246],
      [500, 246],
    ]),
  },
  // the LFA's lobes, a little longer for the higher revs
  intakeLobe: { lift: 0.012, durationAt50Thou: 250, gamma: 1.1, center: 95 },
  exhaustLobe: { lift: 0.012, durationAt50Thou: 250, gamma: 1.1, center: 112 },
  intake: {
    plenumVolume: 4e-3,
    plenumArea: 40e-4,
    inputFlow: flowConstantOfThroat(1500),
    runnerFlow: flowConstantOfThroat(300),
    runnerLength: 4 * INCH,
    // a hot racing engine idles at 4000 rpm with its throttle cracked open, not shut against a deep vacuum
    idleThrottlePlate: 0.97,
    velocityDecay: 0.5,
    throttleGamma: 2,
  },
  exhaust: {
    // engine-sim lumps each primary into one volume: a short one keeps the blowdown's pulse sharp, as a real pipe does
    primaryTubeLength: 0.2,
    primaryFlow: flowConstantOfThroat(1000),
    // through the turbine, which holds the exhaust back more than an open pipe would
    outletFlow: flowConstantOfThroat(1500),
    collectorArea: Math.PI * (1.5 * INCH) ** 2,
    velocityDecay: 1,
    lengths: [0.8, 0.85],
    audioVolume: 2,
  },
  timing: [
    [0, 12],
    [4000, 40],
    [18_000, 40],
  ],
  fuel: {
    maxBurningEfficiency: 1,
    burningEfficiencyRandomness: 0.5,
    lowEfficiencyAttenuation: 0.6,
    maxTurbulenceEffect: 2,
    maxDilutionEffect: 50,
    // the jets of a pre-chamber's ignition stir the charge far more than the piston alone
    turbulencePerPistonSpeed: 1.5,
  },
  // some fuel still burning on the overrun, lean, as racing engines' overrun maps keep it: enough to
  // burble between idling and flat out, rather than fall silent with none or blare with it all
  overrun: { above: 5500, fuelShare: 0.65 },
  // about 3.5 bar absolute flat out
  boost: { most: 250_000, spoolUp: 0.35, spoolDown: 0.7, fromRpm: 5000, fullRpm: 10_000 },
  // engine-sim steps the gas 8 times a step; 4 come within 2% of its pressures and power, at half the cost
  simulationFrequency: 10_000,
  fluidSteps: 4,
};
