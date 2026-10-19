// A volume of gas, as engine-sim models it (github.com/ange-yaghi/engine-sim, MIT, © 2022 Ange
// Yaghi; see ENGINE_SIM_LICENSE): so many moles of an ideal gas with so much thermal energy in
// so much volume, moving as a whole with some momentum, and a mix of fuel, oxygen and inert gas.
// Gas flows between two such volumes through an orifice as compressible flow does, choked once
// the pressures are far enough apart. Ported to TypeScript as it is, in SI units.

/** The gas constant, in J/(mol·K). */
export const GAS_CONSTANT = 8.31446261815324;
/** Air's molar mass, in kg/mol. */
export const AIR_MOLAR_MASS = 0.02897;
export const ATMOSPHERE = 101_325;
export const celsius = (degrees: number) => degrees + 273.15;

/** Shares of the gas that are fuel, inert, and oxygen, adding up to 1. */
export interface Mix {
  fuel: number;
  inert: number;
  oxygen: number;
}

export const AIR: Readonly<Mix> = { fuel: 0, inert: 1, oxygen: 0 };

export class GasSystem {
  moles = 0;
  /** The gas's thermal energy, in J. */
  energy = 0;
  volume = 0;
  momentumX = 0;
  momentumY = 0;
  readonly mix: Mix = { fuel: 0, inert: 1, oxygen: 0 };
  degreesOfFreedom = 5;
  /** Half its degrees of freedom, and its heat capacity ratio, kept for the flows, which work them out often. */
  halfDegreesOfFreedom = 2.5;
  ratio = 1.4;
  /** The pressure ratio below which flow out of it chokes, and the choked flow's factor, kept for the flows. */
  chokedFlowLimit = 0;
  chokedFlowFactor = 0;
  /** Its shape, for how its own motion pushes on its walls: a box this wide and high, its length along (dx, dy). */
  private width = 0;
  private height = 0;
  private directionX = 0;
  private directionY = 0;

  setGeometry(width: number, height: number, directionX: number, directionY: number): void {
    this.width = width;
    this.height = height;
    this.directionX = directionX;
    this.directionY = directionY;
  }

  initialize(pressure: number, volume: number, temperature: number, mix: Readonly<Mix> = AIR, degreesOfFreedom = 5): void {
    this.degreesOfFreedom = degreesOfFreedom;
    this.halfDegreesOfFreedom = 0.5 * degreesOfFreedom;
    this.ratio = 1 + 2 / degreesOfFreedom;
    this.moles = (pressure * volume) / (GAS_CONSTANT * temperature);
    this.volume = volume;
    this.energy = temperature * (0.5 * degreesOfFreedom * this.moles * GAS_CONSTANT);
    copyMix(this.mix, mix);
    this.momentumX = this.momentumY = 0;
    const ratio = this.heatCapacityRatio();
    this.chokedFlowLimit = (2 / (ratio + 1)) ** (ratio / (ratio - 1));
    this.chokedFlowFactor = Math.sqrt(ratio) * (2 / (ratio + 1)) ** ((ratio + 1) / (2 * (ratio - 1)));
  }

  reset(pressure: number, temperature: number, mix: Readonly<Mix>): void {
    this.moles = (pressure * this.volume) / (GAS_CONSTANT * temperature);
    this.energy = temperature * (0.5 * this.degreesOfFreedom * this.moles * GAS_CONSTANT);
    copyMix(this.mix, mix);
    this.momentumX = this.momentumY = 0;
  }

  heatCapacityRatio(): number {
    return 1 + 2 / this.degreesOfFreedom;
  }

  pressure(): number {
    return this.volume !== 0 ? this.energy / (0.5 * this.degreesOfFreedom * this.volume) : 0;
  }

  temperature(): number {
    return this.moles === 0 ? 0 : this.energy / (0.5 * this.degreesOfFreedom * this.moles * GAS_CONSTANT);
  }

  mass(): number {
    return AIR_MOLAR_MASS * this.moles;
  }

  energyPerMole(): number {
    return this.energy / this.moles;
  }

  /** The speed of sound in it. */
  soundSpeed(): number {
    if (this.moles === 0 || this.energy === 0) return 0;
    return Math.sqrt((this.pressure() * this.heatCapacityRatio()) / (this.mass() / this.volume));
  }

  bulkKineticEnergy(): number {
    const mass = this.mass();
    if (mass === 0) return 0;
    return (0.5 * (this.momentumX * this.momentumX + this.momentumY * this.momentumY)) / mass;
  }

  totalEnergy(): number {
    return this.moles === 0 ? 0 : this.energy + this.bulkKineticEnergy();
  }

  /** The pressure its motion adds against a wall facing (dx, dy), as stagnation pressure does: 0 moving away. */
  dynamicPressure(directionX: number, directionY: number): number {
    return dynamicPressureOf(this, directionX, directionY);
  }

  /** Compressed or let expand by `change` m³, the work done on it or by it changing its energy. */
  changeVolume(change: number): void {
    const side = Math.cbrt(this.volume + change);
    const surface = side * side;
    const travel = -change / surface;
    this.energy += travel * this.pressure() * surface;
    this.volume += change;
  }

  setVolume(volume: number): void {
    this.changeVolume(volume - this.volume);
  }

  changeEnergy(change: number): void {
    this.energy += change;
  }

  /** Burns up to `moles` of a charge mixed as `charge` is, as 25 O₂ + 2 C₈H₁₆ → 16 CO₂ + 18 H₂O: the moles of fuel burnt. */
  react(moles: number, charge: Readonly<Mix>): number {
    const chargeFuel = charge.fuel * moles;
    const chargeOxygen = charge.oxygen * moles;
    const systemFuel = this.mix.fuel * this.moles;
    const systemOxygen = this.mix.oxygen * this.moles;
    const systemInert = this.mix.inert * this.moles;
    const systemMoles = this.moles;
    const idealFuel = (2 / 25) * chargeOxygen;
    const idealOxygen = (25 / 2) * chargeFuel;
    const fuelBurnt = Math.min(systemFuel, chargeFuel, idealFuel);
    const oxygenBurnt = Math.min(systemOxygen, chargeOxygen, idealOxygen);
    const reactants = fuelBurnt + oxygenBurnt;
    const products = ((16 + 18) / (25 + 2)) * reactants;
    const change = products - reactants;
    this.moles += change;
    const nextMoles = systemMoles + change;
    if (nextMoles !== 0) {
      this.mix.fuel = (systemFuel - fuelBurnt) / nextMoles;
      this.mix.inert = (systemInert + products) / nextMoles;
      this.mix.oxygen = (systemOxygen - oxygenBurnt) / nextMoles;
    } else this.mix.fuel = this.mix.inert = this.mix.oxygen = 0;
    return fuelBurnt;
  }

  loseMoles(moles: number, energyPerMole: number): void {
    this.energy -= energyPerMole * moles;
    this.moles = Math.max(this.moles - moles, 0);
  }

  gainMoles(moles: number, energyPerMole: number, mix: Readonly<Mix>): void {
    const current = this.moles;
    const next = current + moles;
    this.energy += moles * energyPerMole;
    this.moles = next;
    if (next !== 0) {
      this.mix.fuel = (this.mix.fuel * current + moles * mix.fuel) / next;
      this.mix.inert = (this.mix.inert * current + moles * mix.inert) / next;
      this.mix.oxygen = (this.mix.oxygen * current + moles * mix.oxygen) / next;
    } else this.mix.fuel = this.mix.inert = this.mix.oxygen = 0;
  }

  /** Slows the gas to the speed of sound if it moves faster, its motion's excess turned to heat. */
  dissipateExcessVelocity(): void {
    const mass = this.mass();
    if (mass === 0) return;
    const velocityX = this.momentumX / mass;
    const velocityY = this.momentumY / mass;
    const velocitySquared = velocityX * velocityX + velocityY * velocityY;
    const soundSpeed = this.soundSpeed();
    const soundSpeedSquared = soundSpeed * soundSpeed;
    if (soundSpeedSquared >= velocitySquared || velocitySquared === 0) return;
    const scale = Math.sqrt(soundSpeedSquared / velocitySquared);
    this.momentumX *= scale;
    this.momentumY *= scale;
    this.energy = Math.max(this.energy + 0.5 * mass * (velocitySquared - soundSpeedSquared), 0);
  }

  /** The gas pushed back by its own motion against the walls it moves toward. */
  updateVelocity(timestep: number, beta: number): void {
    if (this.moles === 0) return;
    if (this.energy === 0) return;
    const depth = this.volume / (this.width * this.height);
    const alongX = this.directionX;
    const alongY = this.directionY;
    const mass = this.mass();
    // its speed along its length and across it: of each pair of opposite walls, it pushes on the one it moves toward
    const along = (alongX * this.momentumX + alongY * this.momentumY) / mass;
    const sideways = (alongY * this.momentumX + alongX * this.momentumY) / mass;
    const ahead = along > 0 ? stagnationPressureOf(this, along) * this.height * depth : 0;
    const behind = along < 0 ? stagnationPressureOf(this, -along) * this.height * depth : 0;
    const across = sideways > 0 ? stagnationPressureOf(this, sideways) * this.width * depth : 0;
    const acrossBack = sideways < 0 ? stagnationPressureOf(this, -sideways) * this.width * depth : 0;
    const pushX = ahead * alongX - behind * alongX + across * alongY - acrossBack * alongY;
    const pushY = ahead * alongY - behind * alongY + across * alongX - acrossBack * alongX;
    const before = this.momentumX * this.momentumX + this.momentumY * this.momentumY;
    this.momentumX -= pushX * timestep * beta;
    this.momentumY -= pushY * timestep * beta;
    const after = this.momentumX * this.momentumX + this.momentumY * this.momentumY;
    this.energy = Math.max(this.energy - (0.5 * (after - before)) / mass, 0);
  }

  /**
   * Flow with the surroundings, at `pressure` and `temperature` and mixed as `mix`, through an
   * orifice of flow constant `flowConstant`: the moles that left (negative came in).
   */
  flowWithSurroundings(flowConstant: number, timestep: number, pressure: number, temperature: number, mix: Readonly<Mix> = AIR): number {
    const maxFlow = this.equilibriumFlowWithSurroundings(pressure, temperature);
    let flow = timestep * orificeFlowRate(flowConstant, this.pressure(), pressure, this.temperature(), temperature, this.heatCapacityRatio(), this.chokedFlowLimit, this.chokedFlowFactor);
    if (Math.abs(flow) > Math.abs(maxFlow)) flow = maxFlow;
    if (flow < 0) {
      const before = this.bulkKineticEnergy();
      this.gainMoles(-flow, 0.5 * temperature * GAS_CONSTANT * this.degreesOfFreedom, mix);
      this.energy += this.bulkKineticEnergy() - before;
    } else {
      const startingMoles = this.moles;
      this.loseMoles(flow, this.energyPerMole());
      this.momentumX -= (flow / startingMoles) * this.momentumX;
      this.momentumY -= (flow / startingMoles) * this.momentumY;
    }
    return flow;
  }

  private equilibriumFlowWithSurroundings(pressure: number, temperature: number): number {
    const toEqual = pressure * (0.5 * this.degreesOfFreedom * this.volume) - this.energy;
    if (this.pressure() > pressure) return -toEqual / this.energyPerMole();
    return -toEqual / (0.5 * temperature * GAS_CONSTANT * this.degreesOfFreedom);
  }
}

function copyMix(into: Mix, from: Readonly<Mix>): void {
  into.fuel = from.fuel;
  into.inert = from.inert;
  into.oxygen = from.oxygen;
}

/** Moles a second through an orifice of flow constant `flowConstant`, from the higher pressure to the lower: positive from the first side. */
export function orificeFlowRate(flowConstant: number, firstPressure: number, secondPressure: number, firstTemperature: number, secondTemperature: number, ratio: number, chokedLimit: number, chokedFactor: number): number {
  if (flowConstant === 0) return 0;
  const forward = firstPressure > secondPressure;
  const upstream = forward ? firstPressure : secondPressure;
  const downstream = forward ? secondPressure : firstPressure;
  const upstreamTemperature = forward ? firstTemperature : secondTemperature;
  const pressureRatio = downstream / upstream;
  let rate: number;
  if (pressureRatio <= chokedLimit) rate = chokedFactor / Math.sqrt(GAS_CONSTANT * upstreamTemperature);
  else {
    const scaled = pressureRatio ** (1 / ratio);
    rate = Math.sqrt(Math.max(((2 * ratio) / (ratio - 1)) * scaled * (scaled - pressureRatio), 0) / (GAS_CONSTANT * upstreamTemperature));
  }
  return (forward ? 1 : -1) * upstream * rate * flowConstant;
}

/** The flow constant that passes `flowRate` moles a second from `pressure` down `pressureDrop`, at `temperature`. */
export function flowConstantFor(flowRate: number, pressure: number, pressureDrop: number, temperature: number, ratio = 1.4): number {
  const chokedLimit = (2 / (ratio + 1)) ** (ratio / (ratio - 1));
  const pressureRatio = (pressure - pressureDrop) / pressure;
  let rate: number;
  if (pressureRatio <= chokedLimit) rate = Math.sqrt(ratio) * (2 / (ratio + 1)) ** ((ratio + 1) / (2 * (ratio - 1)));
  else rate = Math.sqrt(((2 * ratio) / (ratio - 1)) * (1 - pressureRatio ** ((ratio - 1) / ratio))) * pressureRatio ** (1 / ratio);
  return flowRate / ((rate * pressure) / Math.sqrt(GAS_CONSTANT * temperature));
}

/** A standard cubic foot a minute, as moles a second. */
const SCFM = (0.002641 * 453.59237) / 60;
const INCH_OF_MERCURY = 3386.3886666666713;

/** The flow constant of a port that flows `cfm` on a flow bench at 28 inches of water, as cylinder heads are rated. */
export const flowConstantOfPort = (cfm: number) => flowConstantFor(cfm * SCFM, ATMOSPHERE, 28 * INCH_OF_MERCURY * 0.0734824, celsius(25));
/** The flow constant of a throat that flows `cfm` at 1.5 inches of mercury, as carburettors and throttle bodies are rated. */
export const flowConstantOfThroat = (cfm: number) => flowConstantFor(cfm * SCFM, ATMOSPHERE, 1.5 * INCH_OF_MERCURY, celsius(25));

/**
 * Gas flowing between two volumes through an orifice, as engine-sim's GasSystem::flow: the moles
 * that passed, the fraction carrying its share of the source's momentum and energy, and the
 * stream driving momentum into each side along (dx, dy). Positive from the first to the second.
 */
export function flowBetween(flowConstant: number, timestep: number, directionX: number, directionY: number, firstArea: number, secondArea: number, first: GasSystem, second: GasSystem): number {
  // through a shut valve nothing flows, and so nothing drives either side's gas: engine-sim works
  // its way through all of it to the same result
  if (flowConstant === 0) return 0;
  // the gas's properties are worked out here as GasSystem's methods work them out, in the same
  // order and so to the same bits: this runs some 400 000 times a simulated second, and calling
  // out for each costs more than the arithmetic
  const firstPressure = first.energy / (first.halfDegreesOfFreedom * first.volume) + dynamicPressureOf(first, directionX, directionY);
  const secondPressure = second.energy / (second.halfDegreesOfFreedom * second.volume) + dynamicPressureOf(second, -directionX, -directionY);
  const forward = firstPressure > secondPressure;
  const source = forward ? first : second;
  const sink = forward ? second : first;
  const alongX = forward ? directionX : -directionX;
  const alongY = forward ? directionY : -directionY;
  const sourceArea = forward ? firstArea : secondArea;
  const sinkArea = forward ? secondArea : firstArea;

  // the orifice's flow from the higher pressure to the lower, choked once they are far enough apart
  const upstream = forward ? firstPressure : secondPressure;
  const downstream = forward ? secondPressure : firstPressure;
  const upstreamTemperature = source.moles === 0 ? 0 : source.energy / (source.halfDegreesOfFreedom * source.moles * GAS_CONSTANT);
  const ratio = source.ratio;
  const pressureRatio = downstream / upstream;
  let rate: number;
  if (pressureRatio <= source.chokedFlowLimit) rate = source.chokedFlowFactor / Math.sqrt(GAS_CONSTANT * upstreamTemperature);
  else {
    const scaled = pressureRatio ** (1 / ratio);
    rate = Math.sqrt(Math.max(((2 * ratio) / (ratio - 1)) * scaled * (scaled - pressureRatio), 0) / (GAS_CONSTANT * upstreamTemperature));
  }
  let flow = timestep * (upstream * rate * flowConstant);
  flow = Math.min(Math.max(flow, 0), 0.9 * source.moles);

  const fraction = source.moles === 0 ? 0 : flow / source.moles;
  const fractionVolume = fraction * source.volume;
  const fractionMass = fraction * (AIR_MOLAR_MASS * source.moles);
  if (flow !== 0) {
    // the fraction moves from source to sink, its thermal energy and momentum with it
    const bulkBefore = bulkKineticEnergyOf(source) + bulkKineticEnergyOf(sink);
    const energyPerMole = source.energy / source.moles;
    sink.gainMoles(flow, energyPerMole, source.mix);
    source.loseMoles(flow, energyPerMole);
    const movedX = source.momentumX * fraction;
    const movedY = source.momentumY * fraction;
    source.momentumX -= movedX;
    source.momentumY -= movedY;
    sink.momentumX += movedX;
    sink.momentumY += movedY;
    const bulkAfter = bulkKineticEnergyOf(source) + bulkKineticEnergyOf(sink);
    sink.energy -= bulkAfter - bulkBefore;
  }

  // and the stream through the orifice drives each side's gas along it
  const sourceMass = AIR_MOLAR_MASS * source.moles;
  const sinkMass = AIR_MOLAR_MASS * sink.moles;
  const sourceMomentumX = source.momentumX;
  const sourceMomentumY = source.momentumY;
  const sinkMomentumX = sink.momentumX;
  const sinkMomentumY = sink.momentumY;
  if (sinkArea !== 0) {
    const speed = Math.min(Math.max(fractionVolume / sinkArea / timestep, 0), soundSpeedOf(sink));
    sink.momentumX += speed * alongX * fractionMass;
    sink.momentumY += speed * alongY * fractionMass;
  }
  if (sourceArea !== 0 && sourceMass !== 0) {
    const speed = Math.min(Math.max(fractionVolume / sourceArea / timestep, 0), soundSpeedOf(source));
    source.momentumX += speed * alongX * fractionMass;
    source.momentumY += speed * alongY * fractionMass;
  }
  // energy kept: what the stream gave each side's motion comes out of its heat
  if (sourceMass !== 0) {
    source.energy -= (0.5 * (source.momentumX ** 2 - sourceMomentumX ** 2 + source.momentumY ** 2 - sourceMomentumY ** 2)) / sourceMass;
  }
  if (sinkMass > 0) {
    sink.energy -= (0.5 * (sink.momentumX ** 2 - sinkMomentumX ** 2 + sink.momentumY ** 2 - sinkMomentumY ** 2)) / sinkMass;
  }
  if (sink.energy < 0) sink.energy = 0;
  if (source.energy < 0) source.energy = 0;
  return forward ? flow : -flow;
}

/** GasSystem's bulkKineticEnergy, written out. */
function bulkKineticEnergyOf(gas: GasSystem): number {
  const mass = AIR_MOLAR_MASS * gas.moles;
  if (mass === 0) return 0;
  return (0.5 * (gas.momentumX * gas.momentumX + gas.momentumY * gas.momentumY)) / mass;
}

/** GasSystem's soundSpeed, written out. */
function soundSpeedOf(gas: GasSystem): number {
  if (gas.moles === 0 || gas.energy === 0) return 0;
  return Math.sqrt(((gas.energy / (gas.halfDegreesOfFreedom * gas.volume)) * gas.ratio) / ((AIR_MOLAR_MASS * gas.moles) / gas.volume));
}

/** GasSystem's dynamicPressure, written out. */
function dynamicPressureOf(gas: GasSystem, directionX: number, directionY: number): number {
  if (gas.moles === 0 || gas.energy === 0) return 0;
  return stagnationPressureOf(gas, (directionX * gas.momentumX + directionY * gas.momentumY) / (AIR_MOLAR_MASS * gas.moles));
}

/** The pressure a gas's motion adds at `speed` toward a wall: p · ((1 + (γ − 1)/2 · M²)^(γ/(γ − 1)) − 1). */
function stagnationPressureOf(gas: GasSystem, speed: number): number {
  if (speed <= 0) return 0;
  const ratio = gas.ratio;
  const staticPressure = gas.energy / (gas.halfDegreesOfFreedom * gas.volume);
  const soundSpeedSquared = (staticPressure * ratio * gas.volume) / (AIR_MOLAR_MASS * gas.moles);
  const base = 1 + ((ratio - 1) / 2) * ((speed * speed) / soundSpeedSquared);
  // base^(γ / (γ − 1)), by multiplication for the usual 5 degrees of freedom
  let power: number;
  if (gas.degreesOfFreedom === 5) {
    const squared = base * base;
    const cubed = squared * base;
    power = cubed * cubed * base;
  } else if (gas.degreesOfFreedom === 3) power = base ** 5;
  else power = base;
  return staticPressure * (Math.sqrt(power) - 1);
}
