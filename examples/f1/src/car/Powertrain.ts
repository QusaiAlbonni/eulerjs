import { SPECIFICATION } from './specification.js';

const { engine, gearbox } = SPECIFICATION;

/** Radians a second for each rpm. */
const RPM_TO_SPIN = (2 * Math.PI) / 60;

/** The engine's torque at `rpm` with the throttle wide open, in N·m, read off its curve. */
export function engineTorqueAt(rpm: number): number {
  const curve = engine.torqueCurve;
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let index = 1; index < curve.length; index++) {
    const [upperRpm, upperTorque] = curve[index]!;
    if (rpm <= upperRpm) {
      const [lowerRpm, lowerTorque] = curve[index - 1]!;
      return lowerTorque + ((upperTorque - lowerTorque) * (rpm - lowerRpm)) / (upperRpm - lowerRpm);
    }
  }
  return curve[curve.length - 1]![1];
}

/** What the driver asks of the engine and gearbox this step. */
export interface PowertrainInput {
  /** 0 to 1. */
  throttle: number;
  /** One-step requests, for the manual gearbox. */
  shiftUp: boolean;
  shiftDown: boolean;
}

/**
 * The engine, gearbox and differential between the throttle and the rear wheels: from how fast
 * they spin, the engine's speed, and the torque each wheel is driven with. The clutch slips
 * pulling away, holding the engine up near where it pulls well; above that the engine turns with
 * the wheels through the gear.
 */
export class Powertrain {
  /** 1 to 8. */
  gear = 1;
  /** The engine's speed, in rpm. */
  rpm: number = engine.idleRpm;
  /** Whether the gearbox shifts by itself. */
  automatic = true;
  /** Whether the limiter is cutting the fuel. */
  limiting = false;
  /** Time left in a shift, in seconds, the drive cut meanwhile. */
  private shifting = 0;
  /** The torque the engine gave on the last step, at the crankshaft, in N·m: for the sound. */
  engineTorque = 0;
  /** How far the clutch has closed, 0 to 1: open at a standstill, slipping pulling away. */
  private clutchClosed = 0;
  /** After a shift, the revs it began from, and how long they have left to settle to the new gear's. */
  private settleFrom = 0;
  private settleLeft = 0;
  /** The revs the engine had to lose or gain to the new gear's, as the shift began; undefined until the new gear's are known. */
  private settleGap: number | undefined;
  /**
   * The torque the engine gave up as its revs settled through a shift up, at the crankshaft, in
   * N·m: slowing to the next gear's revs, the energy in its spinning shoves the car on.
   */
  shiftTorque = 0;
  /** Seconds since the last shift. */
  private sinceShift = Infinity;

  /** The torques for the left and right rear wheels, in N·m, given how fast they spin in rad/s. */
  update(input: PowertrainInput, leftSpin: number, rightSpin: number, timestep: number): [number, number] {
    const ratio = gearbox.ratios[this.gear - 1]!;
    const wheelSpin = (leftSpin + rightSpin) / 2;
    const wheelRpm = (Math.abs(wheelSpin) * ratio) / RPM_TO_SPIN;
    // the clutch slips below the speed the engine would drop under its pulling-away revs
    const launchRpm = engine.idleRpm + input.throttle * 4000;
    const coupled = Math.max(wheelRpm, this.gear === 1 ? launchRpm : engine.idleRpm);
    const settling = this.settleLeft > 0;
    this.shiftTorque = 0;
    if (settling) {
      // through a shift the revs close the gap to the new gear's smoothly, not in a step, and
      // the engine's inertia gives up what it loses closing it, or takes what it gains
      this.settleGap ??= this.settleFrom - coupled;
      const before = smoothstep(1 - this.settleLeft / gearbox.shiftSettle);
      this.settleLeft = Math.max(this.settleLeft - timestep, 0);
      const settled = smoothstep(1 - this.settleLeft / gearbox.shiftSettle);
      this.rpm = coupled + this.settleGap * (1 - settled);
      // shifting down, the gearbox blips the throttle, and the engine spins itself up to the lower
      // gear's revs rather than tugging at the rear wheels, which would unsettle the car braking
      this.shiftTorque = Math.max((engine.inertia * this.settleGap * RPM_TO_SPIN * (settled - before)) / timestep, 0);
    } else this.rpm = coupled;

    this.shiftAsked(input, timestep);
    this.shifting = Math.max(this.shifting - timestep, 0);
    this.limiting = this.rpm >= engine.limiterRpm;
    const throttle = this.shifting > 0 || this.limiting ? 0 : input.throttle;
    // off the throttle the engine holds back the wheels it turns with, the harder the faster it
    // turns; at a standstill the clutch is open and it holds back nothing
    const clutchClosed = Math.min(Math.max((wheelRpm - engine.idleRpm) / 1000, 0), 1);
    // pulling away the clutch slips, carrying none of the engine's inertia, and closes as the wheels
    // come up to the engine's revs: gradually, or the wheels, light, would leap past them in a step
    const closing = this.gear === 1 ? Math.min(Math.max((wheelRpm / launchRpm - 0.8) / 0.2, 0), 1) : 1;
    this.clutchClosed = clutchClosed * closing * closing * (3 - 2 * closing);
    const holdingBack = (engine.engineBraking * (1 - throttle) * this.rpm * clutchClosed) / engine.limiterRpm;
    this.engineTorque = throttle * engineTorqueAt(this.rpm) - holdingBack * Math.sign(wheelSpin);
    const driving = (this.engineTorque + this.shiftTorque * Math.sign(wheelSpin)) * ratio * engine.efficiency;

    // the differential shares the drive, and its locking evens out the two wheels' spin, up to
    // a share of the drive (and a little preload) moved across
    const mostLocking = Math.abs(driving) * 0.4 + 200;
    const locking = Math.min(Math.max(SPECIFICATION.differentialLocking * (leftSpin - rightSpin), -mostLocking), mostLocking);
    return [driving / 2 - locking, driving / 2 + locking];
  }

  /**
   * The engine's inertia as the rear wheels feel it, in kg·m², both together: its own times the
   * gear's ratio squared, once the clutch has closed; pulling away, the slipping clutch carries none.
   */
  inertiaAtWheels(): number {
    // through a shift too: the engine keeps turning with the wheels, and `shiftTorque` is only
    // what it gives up closing the gap to the new gear's revs
    const ratio = gearbox.ratios[this.gear - 1]!;
    return engine.inertia * ratio * ratio * this.clutchClosed;
  }

  private shiftAsked(input: PowertrainInput, timestep: number): void {
    this.sinceShift += timestep;
    // not until the last shift has settled, the revs at the new gear's
    if (this.shifting > 0 || this.settleLeft > 0) return;
    let wanted = this.gear;
    if (this.automatic && this.sinceShift >= gearbox.automaticHold) {
      if (this.rpm > gearbox.upshiftRpm) wanted = this.gear + 1;
      // a lower gear only if it won't overrev
      else if (this.rpm < gearbox.downshiftRpm && this.gear > 1) {
        const lower = gearbox.ratios[this.gear - 2]!;
        if ((this.rpm * lower) / gearbox.ratios[this.gear - 1]! < gearbox.upshiftRpm) wanted = this.gear - 1;
      }
    }
    if (input.shiftUp) wanted = this.gear + 1;
    if (input.shiftDown) wanted = this.gear - 1;
    wanted = Math.min(Math.max(wanted, 1), gearbox.ratios.length);
    if (wanted !== this.gear) {
      this.gear = wanted;
      this.shifting = gearbox.shiftTime;
      this.settleFrom = this.rpm;
      this.settleLeft = gearbox.shiftSettle;
      this.settleGap = undefined;
      this.sinceShift = 0;
    }
  }
}

const smoothstep = (share: number) => share * share * (3 - 2 * share);
