import { MathUtils } from 'three';
import { SAIL_DRAG_BY_DEGREE, SAIL_LIFT_BY_DEGREE } from './sailTables.js';

/**
 * Lift and drag coefficients of a foil against its angle of attack: the angle, from 0 to π,
 * between the foil's chord (pointing at the leading edge) and the direction the flow comes from.
 * Past π/2 the flow arrives from the trailing edge; lift then normally changes sign.
 */
export interface Polar {
  liftCoefficient(angleOfAttack: number): number;
  dragCoefficient(angleOfAttack: number): number;
}

/** A polar sampled once per degree from 0° to 180°, linearly interpolated in between. */
export class TablePolar implements Polar {
  private readonly liftByDegree: readonly number[];
  private readonly dragByDegree: readonly number[];

  constructor(liftByDegree: readonly number[], dragByDegree: readonly number[]) {
    if (liftByDegree.length !== 181 || dragByDegree.length !== 181) {
      throw new RangeError('A TablePolar needs 181 lift and 181 drag samples, one per degree from 0 to 180');
    }
    this.liftByDegree = liftByDegree;
    this.dragByDegree = dragByDegree;
  }

  liftCoefficient(angleOfAttack: number): number {
    return interpolateByDegree(this.liftByDegree, angleOfAttack);
  }

  dragCoefficient(angleOfAttack: number): number {
    return interpolateByDegree(this.dragByDegree, angleOfAttack);
  }
}

function interpolateByDegree(table: readonly number[], angleOfAttack: number): number {
  const degrees = MathUtils.clamp(MathUtils.radToDeg(angleOfAttack), 0, 180);
  const lower = Math.min(Math.floor(degrees), 179);
  return MathUtils.lerp(table[lower]!, table[lower + 1]!, degrees - lower);
}

/** The sail polar of the three-sails demo, used there for both the main sail and the jib. */
export const sailPolar: Polar = new TablePolar(SAIL_LIFT_BY_DEGREE, SAIL_DRAG_BY_DEGREE);

export interface SymmetricFoilOptions {
  /** dCl/dα before stall, per radian. 2π for a thin foil of infinite span; less for short, stubby ones. */
  liftSlope?: number;
  /** Angle at which the flow starts to separate, in radians. */
  stallAngle?: number;
  /** Width of the blend from attached flow to the flat-plate behaviour past stall, in radians. */
  stallBlend?: number;
  /** Drag of the foil at zero lift. */
  zeroLiftDrag?: number;
  /** Induced drag as a multiple of Cl², i.e. 1 / (π e AR). */
  inducedDragFactor?: number;
}

/**
 * A symmetric foil such as a keel, rudder or centreboard: thin-airfoil lift before stall,
 * blending into flat-plate behaviour (Cl = sin 2α, Cd = 2 sin² α) past it.
 */
export function symmetricFoilPolar(options: SymmetricFoilOptions = {}): Polar {
  const liftSlope = options.liftSlope ?? 2 * Math.PI;
  const stallAngle = options.stallAngle ?? MathUtils.degToRad(15);
  const stallBlend = options.stallBlend ?? MathUtils.degToRad(10);
  const zeroLiftDrag = options.zeroLiftDrag ?? 0.008;
  const inducedDragFactor = options.inducedDragFactor ?? 0.1;

  /** Angle between the flow and the chord line regardless of which edge leads, and the lift sign. */
  const chordLineAngle = (angleOfAttack: number) =>
    angleOfAttack <= Math.PI / 2 ? { angle: angleOfAttack, sign: 1 } : { angle: Math.PI - angleOfAttack, sign: -1 };
  const separation = (angle: number) => MathUtils.smoothstep(angle, stallAngle, stallAngle + stallBlend);

  return {
    liftCoefficient(angleOfAttack: number): number {
      const { angle, sign } = chordLineAngle(angleOfAttack);
      const separated = separation(angle);
      return sign * ((1 - separated) * liftSlope * angle + separated * Math.sin(2 * angle));
    },
    dragCoefficient(angleOfAttack: number): number {
      const { angle } = chordLineAngle(angleOfAttack);
      const separated = separation(angle);
      const attachedLift = liftSlope * angle;
      const attachedDrag = zeroLiftDrag + inducedDragFactor * attachedLift * attachedLift;
      return (1 - separated) * attachedDrag + separated * Math.max(2 * Math.sin(angle) ** 2, zeroLiftDrag);
    },
  };
}

export interface CamberedSailOptions {
  /** Lift with the flow along the chord, from the sail's curve. */
  zeroAngleLift?: number;
  /** dCl/dα before stall, per radian. Below 2π because a sail's aspect ratio is about 3. */
  liftSlope?: number;
  /** Most lift the sail can make. */
  maximumLift?: number;
  stallAngle?: number;
  stallBlend?: number;
  zeroLiftDrag?: number;
  /** Induced drag as a multiple of Cl², i.e. 1 / (π e AR). */
  inducedDragFactor?: number;
}

/**
 * A cambered sail: some lift even with the flow along the chord, rising until it stalls around
 * 20° and then behaving like a flat plate, with drag that stays low until stall. Lift-to-drag
 * peaks around 6, which is what lets a boat sail about 45° off the wind.
 */
export function camberedSailPolar(options: CamberedSailOptions = {}): Polar {
  const zeroAngleLift = options.zeroAngleLift ?? 0.3;
  const liftSlope = options.liftSlope ?? 3.8;
  const maximumLift = options.maximumLift ?? 1.5;
  const stallAngle = options.stallAngle ?? MathUtils.degToRad(18);
  const stallBlend = options.stallBlend ?? MathUtils.degToRad(12);
  const zeroLiftDrag = options.zeroLiftDrag ?? 0.05;
  const inducedDragFactor = options.inducedDragFactor ?? 0.12;

  const separation = (angleOfAttack: number) => MathUtils.smoothstep(angleOfAttack, stallAngle, stallAngle + stallBlend);
  const attachedLift = (angleOfAttack: number) => Math.min(zeroAngleLift + liftSlope * angleOfAttack, maximumLift);
  // Past stall the sail acts like a flat plate, scaled so the blend doesn't dip.
  const separatedLift = (angleOfAttack: number) => 0.95 * maximumLift * Math.sin(2 * angleOfAttack);

  return {
    liftCoefficient(angleOfAttack: number): number {
      const separated = separation(angleOfAttack);
      return (1 - separated) * attachedLift(angleOfAttack) + separated * separatedLift(angleOfAttack);
    },
    dragCoefficient(angleOfAttack: number): number {
      const separated = separation(angleOfAttack);
      const lift = attachedLift(angleOfAttack);
      const attachedDrag = zeroLiftDrag + inducedDragFactor * lift * lift;
      const separatedDrag = Math.max(2 * Math.sin(angleOfAttack) ** 2, 6 * zeroLiftDrag);
      return (1 - separated) * attachedDrag + separated * separatedDrag;
    },
  };
}
