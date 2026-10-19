import { AIR, ATMOSPHERE, celsius, flowBetween, GasSystem } from './GasSystem.js';
import type { Mix } from './GasSystem.js';

// An engine as engine-sim simulates it (github.com/ange-yaghi/engine-sim, MIT, © 2022 Ange Yaghi;
// see ENGINE_SIM_LICENSE), for its sound: every cylinder's gas from the intake plenum, down its
// runner, through the intake valve, burnt by a flame front spreading from the plug, out through
// the exhaust valve down its primary into its bank's collector and out of the tailpipe, each a
// volume of gas flowing into the next. The crankshaft here turns at the revs the car's
// powertrain gives, rather than as engine-sim's own rigid-body crankshaft does; and air comes
// in at the boost a turbocharger gives, which engine-sim leaves out. What is heard is each
// exhaust primary's pressure, delayed down its pipe: `step` gives it a step at a time.

/** Lift, in metres, against a port's flow constant, as a flow bench rates a cylinder head. */
export type FlowCurve = readonly (readonly [number, number])[];

/** A cam lobe of engine-sim's harmonic shape. */
export interface CamLobe {
  /** Its most lift, in metres. */
  lift: number;
  /** How long it holds the valve open past 0.05 inches of lift, in degrees of the crankshaft. */
  durationAt50Thou: number;
  /** Its shape: above 1 narrower at the top. */
  gamma: number;
  /** Where its lift is most, in degrees of the crankshaft from the top dead centre between exhaust and intake: after it for the intake, before it for the exhaust. */
  center: number;
}

/** What engine-sim's scripts describe of an engine, in SI units and degrees. */
export interface EngineDefinition {
  bore: number;
  stroke: number;
  rodLength: number;
  /** The volume left above a piston at top dead centre. */
  chamberVolume: number;
  /** Where each cylinder fires in the two turns of a cycle, in degrees, and which bank's exhaust it feeds. */
  firingAngles: readonly number[];
  banks: readonly number[];
  /** How far each cylinder's primary reaches before its bank's collector, past the shared length, and how loud its pulses are heard. */
  headerPrimaryLengths: readonly number[];
  soundAttenuation: readonly number[];
  /** Blow-by past each piston's rings, as a flow constant. */
  blowby: number;
  head: {
    intakeRunnerVolume: number;
    intakeRunnerArea: number;
    exhaustRunnerVolume: number;
    exhaustRunnerArea: number;
    intakePortFlow: FlowCurve;
    exhaustPortFlow: FlowCurve;
  };
  intakeLobe: CamLobe;
  exhaustLobe: CamLobe;
  intake: {
    plenumVolume: number;
    plenumArea: number;
    /** The throttle body's flow constant wide open, the runners', and how near closed the throttle's plate sits at idle, 0 to 1. */
    inputFlow: number;
    runnerFlow: number;
    runnerLength: number;
    idleThrottlePlate: number;
    velocityDecay: number;
    throttleGamma: number;
  };
  exhaust: {
    primaryTubeLength: number;
    primaryFlow: number;
    outletFlow: number;
    collectorArea: number;
    velocityDecay: number;
    /** Each bank's pipe from collector to outlet, in metres, and how loud it is. */
    lengths: readonly number[];
    audioVolume: number;
  };
  /** Ignition advance against revs: [rpm, degrees before top dead centre]. */
  timing: readonly (readonly [number, number])[];
  fuel: {
    maxBurningEfficiency: number;
    burningEfficiencyRandomness: number;
    lowEfficiencyAttenuation: number;
    maxTurbulenceEffect: number;
    maxDilutionEffect: number;
    /** The turbulence a mean piston speed stirs up, per m/s of it: engine-sim's is 0.5. */
    turbulencePerPistonSpeed: number;
  };
  /**
   * On the overrun, above `above` revs with the throttle shut, the injectors give only `fuelShare`
   * of their fuel, as modern engines' do; engine-sim's give it all. Lean, the charge burns weakly
   * and now and then not at all.
   */
  overrun: { above: number; fuelShare: number };
  /** The boost, in pascals over the atmosphere's, with the turbo spooled fully; and how long it takes to spool up and down, in seconds. */
  boost: { most: number; spoolUp: number; spoolDown: number; fromRpm: number; fullRpm: number };
  /** How often engine-sim's step runs, in hertz, and how many steps of the gas flows each takes. */
  simulationFrequency: number;
  fluidSteps: number;
}

const DEGREE = Math.PI / 180;
const FUEL_MOLAR_AFR = 25 / 2;
const FUEL_MOLAR_MASS = 0.1;
const FUEL_ENERGY_DENSITY = 48.1e6;
const THOU = 0.0000254;
const SPEED_OF_SOUND = 343;
const ROOM = celsius(25);

/** What a cylinder's flame front does once lit. */
interface Flame {
  lastVolume: number;
  travelX: number;
  travelY: number;
  efficiency: number;
  speed: number;
  readonly charge: Mix;
}

class Cylinder {
  readonly gas = new GasSystem();
  readonly intakeRunner = new GasSystem();
  readonly exhaustRunner = new GasSystem();
  readonly flame: Flame = { lastVolume: 0, travelX: 0, travelY: 0, efficiency: 0, speed: 0, charge: { fuel: 0, inert: 1, oxygen: 0 } };
  lit = false;
  intakeFlowConstant = 0;
  exhaustFlowConstant = 0;
  /** The cycle angle on the last step, to see the spark's angle passed. */
  lastCycleAngle = 0;
  /** Its exhaust pulses, delayed down its pipes. */
  readonly delay: Float64Array;
  delayIndex = 0;
  readonly firingAngle: number;
  readonly bank: number;
  /** How loud its pulses are heard, for the distance down the pipes they travel. */
  readonly loudness: number;

  constructor(firingAngle: number, bank: number, delaySamples: number, loudness: number) {
    this.firingAngle = firingAngle;
    this.bank = bank;
    this.delay = new Float64Array(Math.max(delaySamples, 1));
    this.loudness = loudness;
  }
}

class Collector {
  readonly gas = new GasSystem();
  readonly atmosphere = new GasSystem();
}

export class EngineSimulation {
  /** The revs, the throttle 0 to 1, and whether the ignition is cut, set as the car goes. */
  rpm = 4000;
  throttle = 0;
  ignitionCut = false;
  /** The pressure each bank's exhaust is heard at, on the last step. */
  readonly output: Float64Array;

  private readonly definition: EngineDefinition;
  readonly cylinders: Cylinder[] = [];
  readonly collectors: Collector[] = [];
  readonly plenum = new GasSystem();
  private readonly intakeAtmosphere = new GasSystem();
  private readonly fuelAirMix: Mix;
  private readonly overrunMix: Mix;
  private readonly boreArea: number;
  private readonly crankRadius: number;
  private crankAngle = 0;
  private spool = 0;
  private random: () => number;

  constructor(definition: EngineDefinition, random: () => number = Math.random) {
    this.definition = definition;
    this.random = random;
    this.boreArea = Math.PI * (definition.bore / 2) ** 2;
    this.crankRadius = definition.stroke / 2;
    // the intake's charge, a little rich, as engine-sim's intake mixes it
    const idealAfr = 0.8 * FUEL_MOLAR_AFR * 4;
    const airShare = idealAfr / (1 + idealAfr);
    this.fuelAirMix = { fuel: 1 - airShare, inert: airShare * 0.75, oxygen: airShare * 0.25 };
    const overrunFuel = this.fuelAirMix.fuel * definition.overrun.fuelShare;
    this.overrunMix = { fuel: overrunFuel, inert: (1 - overrunFuel) * 0.75, oxygen: (1 - overrunFuel) * 0.25 };

    const { intake, head, exhaust } = definition;
    this.plenum.initialize(ATMOSPHERE, intake.plenumVolume, ROOM);
    this.plenum.setGeometry(Math.sqrt(intake.plenumArea), intake.plenumVolume / intake.plenumArea, 1, 0);
    this.intakeAtmosphere.initialize(ATMOSPHERE, 1000, ROOM);
    this.intakeAtmosphere.setGeometry(100, 100, 1, 0);
    this.output = new Float64Array(exhaust.lengths.length);
    for (const length of exhaust.lengths) {
      const collector = new Collector();
      const volume = exhaust.collectorArea * length;
      collector.gas.initialize(ATMOSPHERE, volume, ROOM);
      collector.gas.setGeometry(length, Math.sqrt(exhaust.collectorArea), 1, 0);
      collector.atmosphere.initialize(ATMOSPHERE, 1000, ROOM);
      collector.atmosphere.setGeometry(10, 10, 1, 0);
      this.collectors.push(collector);
    }

    definition.firingAngles.forEach((firingAngle, index) => {
      const bank = definition.banks[index]!;
      const pipeLength = definition.headerPrimaryLengths[index]! + exhaust.lengths[bank]!;
      const cylinder = new Cylinder(firingAngle * DEGREE, bank, Math.round((pipeLength / SPEED_OF_SOUND) * definition.simulationFrequency), (definition.soundAttenuation[index]! * exhaust.audioVolume) / definition.firingAngles.length / (pipeLength * pipeLength));
      // its gas filling the cylinder where its piston starts, as engine-sim's does once it has placed the pistons
      const startingAngle = positiveModulo(-cylinder.firingAngle, 4 * Math.PI);
      cylinder.lastCycleAngle = startingAngle;
      cylinder.gas.initialize(ATMOSPHERE, this.volumeAt(startingAngle), ROOM);
      cylinder.gas.setGeometry(Math.sqrt(this.boreArea), this.volumeAt(startingAngle) / this.boreArea, 1, 0);
      const intakeRunnerVolume = head.intakeRunnerVolume + head.intakeRunnerArea * intake.runnerLength;
      cylinder.intakeRunner.initialize(ATMOSPHERE, intakeRunnerVolume, ROOM);
      cylinder.intakeRunner.setGeometry(intakeRunnerVolume / head.intakeRunnerArea, Math.sqrt(head.intakeRunnerArea), 1, 0);
      const exhaustRunnerVolume = head.exhaustRunnerVolume + head.exhaustRunnerArea * (exhaust.primaryTubeLength + definition.headerPrimaryLengths[index]!);
      cylinder.exhaustRunner.initialize(ATMOSPHERE, exhaustRunnerVolume, ROOM);
      cylinder.exhaustRunner.setGeometry(exhaustRunnerVolume / head.exhaustRunnerArea, Math.sqrt(head.exhaustRunnerArea), 1, 0);
      this.cylinders.push(cylinder);
    });
  }

  /** One of engine-sim's steps, `1 / simulationFrequency` long: fills `output`. */
  step(): void {
    const definition = this.definition;
    const timestep = 1 / definition.simulationFrequency;
    const turning = (this.rpm * 2 * Math.PI) / 60;
    this.crankAngle = (this.crankAngle + turning * timestep) % (4 * Math.PI);
    // the turbo spools up with the exhaust's flow, the throttle open and the revs up, and down without
    const { boost } = definition;
    const spoolTarget = this.throttle * Math.min(Math.max((this.rpm - boost.fromRpm) / (boost.fullRpm - boost.fromRpm), 0), 1);
    this.spool += (spoolTarget - this.spool) * (timestep / (spoolTarget > this.spool ? boost.spoolUp : boost.spoolDown));
    const advance = sampleCurve(definition.timing, this.rpm) * DEGREE;

    for (const cylinder of this.cylinders) {
      const cycleAngle = positiveModulo(this.crankAngle - cylinder.firingAngle, 4 * Math.PI);
      // the spark, `advance` before top dead centre
      const sparkAt = 4 * Math.PI - advance;
      const passed = cylinder.lastCycleAngle <= cycleAngle ? cylinder.lastCycleAngle < sparkAt && sparkAt <= cycleAngle : cylinder.lastCycleAngle < sparkAt || sparkAt <= cycleAngle;
      if (passed && !this.ignitionCut) this.ignite(cylinder);
      cylinder.lastCycleAngle = cycleAngle;
      cylinder.gas.setVolume(this.volumeAt(cycleAngle));
      cylinder.intakeFlowConstant = sampleCurve(definition.head.intakePortFlow, lobeLift(definition.intakeLobe, cycleAngle - (2 * Math.PI + definition.intakeLobe.center * DEGREE)));
      cylinder.exhaustFlowConstant = sampleCurve(definition.head.exhaustPortFlow, lobeLift(definition.exhaustLobe, cycleAngle - (2 * Math.PI - definition.exhaustLobe.center * DEGREE)));
    }

    const fluidTimestep = timestep / definition.fluidSteps;
    for (let substep = 0; substep < definition.fluidSteps; substep++) {
      for (const collector of this.collectors) this.exhaustOut(collector, fluidTimestep);
      this.intakeIn(fluidTimestep);
      for (const cylinder of this.cylinders) this.flow(cylinder, fluidTimestep);
    }

    // what is heard: each primary's pressure over the atmosphere's, and the push of its flow,
    // reaching the end of its pipes a little later
    this.output.fill(0);
    for (const cylinder of this.cylinders) {
      const runner = cylinder.exhaustRunner;
      const pulse = 1600 * (runner.pressure() - ATMOSPHERE + 0.1 * runner.dynamicPressure(1, 0) + 0.1 * runner.dynamicPressure(-1, 0));
      const delayed = cylinder.delay[cylinder.delayIndex]!;
      cylinder.delay[cylinder.delayIndex] = pulse;
      cylinder.delayIndex = (cylinder.delayIndex + 1) % cylinder.delay.length;
      this.output[cylinder.bank]! += cylinder.loudness * delayed;
    }
  }

  /** The volume above a piston `cycleAngle` past its firing top dead centre. */
  private volumeAt(cycleAngle: number): number {
    const radius = this.crankRadius;
    const rod = this.definition.rodLength;
    const sine = Math.sin(cycleAngle);
    const fromTop = radius * (1 - Math.cos(cycleAngle)) + rod - Math.sqrt(rod * rod - radius * radius * sine * sine);
    return this.definition.chamberVolume + this.boreArea * fromTop;
  }

  private ignite(cylinder: Cylinder): void {
    if (cylinder.lit) return;
    const gas = cylinder.gas;
    const mix = gas.mix;
    if (mix.fuel === 0) return;
    const afr = mix.oxygen / mix.fuel;
    const equivalence = afr / FUEL_MOLAR_AFR;
    if (equivalence < 0.5 || equivalence > 1.9) return;
    const dilution = mix.inert / (mix.oxygen / 0.7) - 1;
    const fuel = this.definition.fuel;
    const flame = cylinder.flame;
    flame.lastVolume = gas.volume;
    flame.travelX = flame.travelY = 0;
    flame.charge.fuel = mix.fuel;
    flame.charge.inert = mix.inert;
    flame.charge.oxygen = mix.oxygen;
    cylinder.lit = true;
    const meanPistonSpeed = (2 * this.definition.stroke * this.rpm) / 60;
    const turbulence = Math.min(meanPistonSpeed, 29) * fuel.turbulencePerPistonSpeed;
    const mixing = 1 - clamp(turbulence / fuel.maxTurbulenceEffect) * clamp(1 - dilution / fuel.maxDilutionEffect);
    const chance = fuel.lowEfficiencyAttenuation * (1 - fuel.burningEfficiencyRandomness + fuel.burningEfficiencyRandomness * this.random());
    flame.efficiency = (mixing * chance + (1 - mixing)) * fuel.maxBurningEfficiency;
    flame.speed = flameSpeed(turbulence, afr, gas.temperature(), gas.pressure());
  }

  /** The air in through the throttle into the plenum, at the turbo's boost. */
  private intakeIn(timestep: number): void {
    const intake = this.definition.intake;
    const atmosphere = this.intakeAtmosphere;
    const overrun = this.throttle < 0.02 && this.rpm > this.definition.overrun.above;
    atmosphere.reset(ATMOSPHERE + this.definition.boost.most * this.spool, ROOM, overrun ? this.overrunMix : this.fuelAirMix);
    const position = 1 - this.throttle ** intake.throttleGamma;
    const opening = Math.cos(intake.idleThrottlePlate * position * (Math.PI / 2));
    flowBetween(opening * intake.inputFlow, timestep, 0, -1, 10, intake.plenumArea, atmosphere, this.plenum);
    this.plenum.dissipateExcessVelocity();
    this.plenum.updateVelocity(timestep, intake.velocityDecay);
  }

  /** The exhaust out of a bank's collector, through the tailpipe, into the air. */
  private exhaustOut(collector: Collector, timestep: number): void {
    const exhaust = this.definition.exhaust;
    collector.atmosphere.reset(ATMOSPHERE, ROOM, AIR);
    flowBetween(exhaust.outletFlow, timestep, 1, 0, exhaust.collectorArea, 10, collector.atmosphere, collector.gas);
    collector.gas.dissipateExcessVelocity();
    collector.gas.updateVelocity(timestep, exhaust.velocityDecay);
  }

  /** A cylinder's gas exchange and burning, as engine-sim's CombustionChamber::flow. */
  private flow(cylinder: Cylinder, timestep: number): void {
    const definition = this.definition;
    const { head, intake, exhaust } = definition;
    const gas = cylinder.gas;
    const volume = gas.volume;
    const cylinderHeight = volume / this.boreArea;
    const wallArea = cylinderHeight * Math.PI * definition.bore + this.boreArea * 2;
    // heat lost to the walls, and gas past the rings
    gas.changeEnergy((celsius(90) - gas.temperature()) * wallArea * 100 * timestep);
    gas.flowWithSurroundings(definition.blowby, timestep, ATMOSPHERE, ROOM);

    flowBetween(intake.runnerFlow, timestep, 1, 0, intake.plenumArea, head.intakeRunnerArea, this.plenum, cylinder.intakeRunner);
    cylinder.intakeRunner.dissipateExcessVelocity();
    const intakeFlow = flowBetween(cylinder.intakeFlowConstant, timestep, 1, 0, head.intakeRunnerArea, volume / cylinderHeight, cylinder.intakeRunner, gas);
    cylinder.intakeRunner.dissipateExcessVelocity();
    gas.dissipateExcessVelocity();
    flowBetween(cylinder.exhaustFlowConstant, timestep, 1, 0, volume / cylinderHeight, head.exhaustRunnerArea, gas, cylinder.exhaustRunner);
    gas.dissipateExcessVelocity();
    cylinder.exhaustRunner.dissipateExcessVelocity();
    flowBetween(exhaust.primaryFlow, timestep, 1, 0, head.exhaustRunnerArea, exhaust.collectorArea, cylinder.exhaustRunner, this.collectors[cylinder.bank]!.gas);
    cylinder.intakeRunner.updateVelocity(timestep, intake.velocityDecay);
    gas.updateVelocity(timestep, 0.5);
    cylinder.exhaustRunner.updateVelocity(timestep, exhaust.velocityDecay);

    // fresh charge coming in puts out what flame there is
    if (Math.abs(intakeFlow) > 1e-9 && cylinder.lit) cylinder.lit = false;
    if (!cylinder.lit) return;
    // the flame spreads out across the bore and down toward the piston, burning what it reaches
    const flame = cylinder.flame;
    const totalTravelX = definition.bore / 2;
    const totalTravelY = volume / this.boreArea;
    const lastTravelX = flame.travelX;
    const lastTravelY = flame.travelY * (volume / flame.lastVolume);
    flame.travelX = Math.min(lastTravelX + timestep * flame.speed, totalTravelX);
    flame.travelY = Math.min(lastTravelY + timestep * flame.speed, totalTravelY);
    if (lastTravelX < flame.travelX || lastTravelY < flame.travelY) {
      const burnt = flame.travelX * flame.travelX * Math.PI * flame.travelY;
      const burntBefore = lastTravelX * lastTravelX * Math.PI * lastTravelY;
      const moles = ((burnt - burntBefore) / volume) * gas.moles;
      const fuelBurnt = gas.react(moles * flame.efficiency, flame.charge);
      gas.changeEnergy(fuelBurnt * FUEL_MOLAR_MASS * FUEL_ENERGY_DENSITY);
    } else cylinder.lit = false;
    flame.lastVolume = volume;
  }
}

/**
 * A harmonic lobe's lift `fromCenter` radians of the crankshaft from where it lifts most:
 * lift · (½ + ½ cos k·x)^γ in the camshaft's angle x, k such that it lifts 0.05 inches a
 * quarter of its duration from the centre.
 */
export function lobeLift(lobe: CamLobe, fromCenter: number): number {
  const camAngle = positiveModulo(fromCenter + 2 * Math.PI, 4 * Math.PI) / 2 - Math.PI;
  const quarter = (lobe.durationAt50Thou * DEGREE) / 4;
  const shape = (2 * 50 * THOU) / lobe.lift;
  // as engine-sim works it out: (2 · 0.05″ / lift)^(1/γ) − 1, exact for γ = 1
  const sharpness = Math.acos(shape ** (1 / lobe.gamma) - 1) / quarter;
  if (Math.abs(camAngle) >= Math.PI / sharpness) return 0;
  return lobe.lift * (0.5 + 0.5 * Math.cos(sharpness * camAngle)) ** lobe.gamma;
}

/** How fast a flame burns through the charge, in m/s, as engine-sim's gasoline: its laminar speed, quickened by the turbulence. */
function flameSpeed(turbulence: number, afr: number, temperature: number, pressure: number): number {
  const equivalence = afr / FUEL_MOLAR_AFR;
  const alpha = 2.4 - 0.271 * equivalence ** 3.51;
  const beta = -0.357 + 0.14 * equivalence ** 2.77;
  const laminarAtRoom = 0.305 - 0.549 * (equivalence - 1.21) ** 2;
  const laminar = laminarAtRoom * (temperature / 298) ** alpha * (pressure / ATMOSPHERE) ** beta;
  // turbulence to flame speed as a share of the laminar speed: 3 still, 1.5 times the ratio stirred up
  const ratio = turbulence / laminar;
  const quickening = ratio >= 45 ? 67.5 : ratio <= 5 ? 3 + ((7.5 - 3) * Math.max(ratio, 0)) / 5 : 1.5 * ratio;
  return quickening * laminar;
}

/** Linear between the points of a curve, held at its ends. */
function sampleCurve(curve: readonly (readonly [number, number])[], at: number): number {
  if (at <= curve[0]![0]) return curve[0]![1];
  for (let index = 1; index < curve.length; index++) {
    const upper = curve[index]!;
    if (at <= upper[0]) {
      const lower = curve[index - 1]!;
      return lower[1] + ((upper[1] - lower[1]) * (at - lower[0])) / (upper[0] - lower[0]);
    }
  }
  return curve[curve.length - 1]![1];
}

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
const positiveModulo = (value: number, modulus: number) => ((value % modulus) + modulus) % modulus;
