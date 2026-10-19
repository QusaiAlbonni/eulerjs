import { CatmullRomCurve3, Vector3 } from 'three';
import type { GroundSurface } from '@eulerjs/vehicle';

// A circuit from its centre line: the track, kerbs where it bends, run-off beside it (gravel
// outside the corners, grass elsewhere) out to the barriers, and the pit lane. Flat, at y = 0.
// It answers what the ground is like anywhere, for the tyres, and how far round the lap a point
// is, for the lap times and the minimap; the scenery draws it.

/** What the ground is, beside the track. */
export type Surface = 'asphalt' | 'kerb' | 'grass' | 'gravel' | 'runOff';

/**
 * What each surface does to a tyre: grass is slippery, gravel slippery and deep. Their `height`
 * is where the ground stands at the point last asked about, set by `groundAt` for each wheel as
 * it asks: one object to each surface, so that what a wheel stands on can be told by which it is.
 */
export const SURFACES: Record<Surface, Required<GroundSurface>> = {
  asphalt: { grip: 1, rollingResistance: 0, height: 0 },
  kerb: { grip: 0.92, rollingResistance: 0.01, height: 0 },
  runOff: { grip: 0.95, rollingResistance: 0, height: 0 },
  grass: { grip: 0.55, rollingResistance: 0.06, height: 0 },
  gravel: { grip: 0.42, rollingResistance: 0.32, height: 0 },
};

/** How high a kerb stands at its inner edge and its outer, in metres, as the scenery draws it. */
export const KERB_HEIGHTS: readonly [number, number] = [0.015, 0.06];

/** Gentle swells in the ground, in metres, at a point: a few sines across the map, unlike one another. */
function swell(point: Vector3, amplitude: number, scale: number): number {
  const across = point.x / scale;
  const along = point.z / scale;
  return amplitude * (0.5 * Math.sin(0.71 * across + 0.37 * along + 1.3) + 0.3 * Math.sin(-0.43 * across + 1.13 * along + 0.4) + 0.2 * Math.sin(1.9 * across + 1.7 * along + 2.2));
}

/** Metres between the samples along the centre line. */
const SAMPLE_SPACING = 2;
const TRACK_HALF_WIDTH = 6.5;
/** The start-finish straight is wider, as the grid needs. */
const STRAIGHT_HALF_WIDTH = 7.5;
export const KERB_WIDTH = 1.4;
/** How sharply the track must bend for kerbs, in radians a metre, and for a gravel trap outside it. */
const KERB_CURVATURE = 1 / 260;
const GRAVEL_CURVATURE = 1 / 160;
const GRASS_WIDTH = 14;
const GRAVEL_WIDTH = 34;
/** The strip of asphalt between a kerb and a gravel trap. */
const RUN_OFF_WIDTH = 3;
/** How high the walls stand, in metres. */
export const WALL_HEIGHT = 1.1;
/** The least room between a barrier and another part of the track or the pit lane, in metres. */
const BARRIER_CLEARANCE = 4;
/** The size of the cells samples are found in, in metres. */
const CELL = 30;

/** One sample along the centre line. */
export interface TrackSample {
  readonly position: Vector3;
  readonly tangent: Vector3;
  /** Square to the tangent, to the left of the way round. */
  readonly left: Vector3;
  /** How far round the lap, in metres from the start line. */
  readonly distance: number;
  /** How sharply the track turns here, in radians a metre: positive turning left. */
  readonly curvature: number;
  readonly halfWidth: number;
  /** Whether there are kerbs at the edges. */
  readonly kerbs: boolean;
  /** What lies beside the track, left and right, out to the barrier at `barrier` metres from the centre line. */
  readonly sides: readonly [Side, Side];
}

export interface Side {
  readonly runOff: 'grass' | 'gravel';
  readonly barrier: number;
}

/** Where a point is along and across the track. */
export interface TrackPosition {
  readonly sample: TrackSample;
  /** Metres to the left of the centre line; negative to the right. */
  readonly across: number;
}

export interface CircuitData {
  readonly name: string;
  /** Metres east and north, in driving order. */
  readonly centreLine: readonly (readonly [number, number])[];
  readonly pitLane: readonly (readonly [number, number])[];
  readonly start: readonly [number, number];
}

/** Metres east and north to the scene's x and z: x east, z south, y up. */
export function toScene([east, north]: readonly [number, number]): Vector3 {
  return new Vector3(east, 0, -north);
}

export class Circuit {
  readonly name: string;
  readonly samples: readonly TrackSample[];
  readonly length: number;
  readonly pitLane: readonly Vector3[];
  /** Where the start line is, and the way the cars face there (about y). */
  readonly startLine: TrackSample;
  readonly startHeading: number;
  private readonly cells = new Map<string, number[]>();

  constructor(data: CircuitData) {
    this.name = data.name;
    const curve = new CatmullRomCurve3(data.centreLine.map(toScene), true, 'centripetal');
    const curveLength = curve.getLength();
    const count = Math.round(curveLength / SAMPLE_SPACING);
    const points = curve.getSpacedPoints(count).slice(0, count);
    const tangents = points.map((_point, index) => curve.getTangentAt(index / count).setY(0).normalize());
    this.pitLane = data.pitLane.map(toScene);

    // the start line is where the start is, on the track; distances are measured from it
    const startPoint = toScene(data.start);
    let startIndex = 0;
    points.forEach((point, index) => {
      if (point.distanceToSquared(startPoint) < points[startIndex]!.distanceToSquared(startPoint)) startIndex = index;
    });
    const order = points.map((_point, index) => (index + startIndex) % count);

    // how sharply it turns, from the tangents either side, smoothed over a few samples
    const turn = (index: number) => {
      const before = tangents[(index - 2 + count) % count]!;
      const after = tangents[(index + 2) % count]!;
      const angle = Math.atan2(before.x * after.z - before.z * after.x, before.x * after.x + before.z * after.z);
      // with z south, the tangents of a left turn turn the negative way about y
      return -angle / (4 * SAMPLE_SPACING);
    };
    const rawCurvature = points.map((_point, index) => turn(index));
    const curvature = rawCurvature.map((_value, index) => average(rawCurvature, index, 4));

    // the straight the start is on: the run of gently curving samples round the start
    const onStartStraight = new Array<boolean>(count).fill(false);
    for (const direction of [1, -1]) {
      for (let step = 0, index = startIndex; step < count && Math.abs(curvature[index]!) < KERB_CURVATURE; step++, index = (index + direction + count) % count) onStartStraight[index] = true;
    }

    // kerbs and gravel traps through each corner, started a little before it and run on a little after
    const kerbs = spread(curvature.map((value) => Math.abs(value) > KERB_CURVATURE), 12);
    const gravelLeft = spread(curvature.map((value) => value < -GRAVEL_CURVATURE), 25);
    const gravelRight = spread(curvature.map((value) => value > GRAVEL_CURVATURE), 25);

    const samples: TrackSample[] = [];
    let distance = 0;
    order.forEach((index, position) => {
      if (position > 0) distance += points[index]!.distanceTo(points[order[position - 1]!]!);
      const tangent = tangents[index]!;
      const halfWidth = onStartStraight[index] ? STRAIGHT_HALF_WIDTH : TRACK_HALF_WIDTH;
      const side = (gravel: boolean): Side => ({
        runOff: gravel ? 'gravel' : 'grass',
        barrier: halfWidth + (kerbs[index] ? KERB_WIDTH : 0) + (gravel ? RUN_OFF_WIDTH + GRAVEL_WIDTH : GRASS_WIDTH),
      });
      samples.push({
        position: points[index]!,
        tangent,
        left: new Vector3(tangent.z, 0, -tangent.x),
        distance,
        curvature: curvature[index]!,
        halfWidth,
        kerbs: kerbs[index]!,
        sides: [side(gravelLeft[index]!), side(gravelRight[index]!)],
      });
    });
    this.length = distance + points[order[order.length - 1]!]!.distanceTo(points[order[0]!]!);
    this.samples = samples;
    samples.forEach((sample, index) => this.cellFor(sample.position, true).push(index));
    this.samples = this.clearBarriers(samples);
    this.startLine = this.samples[0]!;
    this.startHeading = Math.atan2(this.startLine.tangent.x, this.startLine.tangent.z);
  }

  /** The sample nearest `point`, and how far across the track from it `point` is. */
  locate(point: Vector3): TrackPosition {
    return this.locateWithin(point, 40)!;
  }

  /**
   * As `locate`, looking no further than about `cells` cells (each 30 metres) away: undefined if no
   * sample is that near. Quick for points far from the track, which a full search would scan
   * most of the map for.
   */
  locateWithin(point: Vector3, cells: number): TrackPosition | undefined {
    let nearest = -1;
    let nearestDistance = Infinity;
    const cellX = Math.floor(point.x / CELL);
    const cellZ = Math.floor(point.z / CELL);
    for (let reach = 1; nearest < 0 && reach <= cells; reach *= 2) {
      for (let column = cellX - reach; column <= cellX + reach; column++) {
        for (let row = cellZ - reach; row <= cellZ + reach; row++) {
          for (const index of this.cells.get(`${column},${row}`) ?? []) {
            const distance = this.samples[index]!.position.distanceToSquared(point);
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearest = index;
            }
          }
        }
      }
    }
    if (nearest < 0) return undefined;
    const sample = this.samples[nearest]!;
    const offset = point.clone().sub(sample.position);
    return { sample, across: offset.dot(sample.left) };
  }

  /** What the ground is at `point`: the track, a kerb, run-off, grass or gravel. */
  /**
   * The ground at `point`, for a tyre: what it is, and how high it stands there, for the
   * suspension to feel. The asphalt ripples by a few millimetres over metres; the kerbs rise to
   * their outer edge; the grass swells by a few centimetres; the gravel lets the car sink in.
   */
  groundAt(point: Vector3): Required<GroundSurface> {
    const surface = SURFACES[this.surfaceAt(point)];
    if (surface === SURFACES.kerb) {
      const { sample, across } = this.locate(point);
      const share = Math.min(Math.max((Math.abs(across) - sample.halfWidth) / KERB_WIDTH, 0), 1);
      surface.height = KERB_HEIGHTS[0] + (KERB_HEIGHTS[1] - KERB_HEIGHTS[0]) * share;
    } else if (surface === SURFACES.grass) surface.height = swell(point, 0.03, 1.5);
    else if (surface === SURFACES.gravel) surface.height = -0.03 + swell(point, 0.012, 0.6);
    else surface.height = swell(point, 0.004, 6);
    return surface;
  }

  surfaceAt(point: Vector3): Surface {
    if (this.nearPitLane(point, 6)) return 'asphalt';
    const { sample, across } = this.locate(point);
    const out = Math.abs(across);
    if (out <= sample.halfWidth) return 'asphalt';
    if (sample.kerbs && out <= sample.halfWidth + KERB_WIDTH) return 'kerb';
    const side = sample.sides[across > 0 ? 0 : 1];
    if (side.runOff === 'gravel') return out <= sample.halfWidth + (sample.kerbs ? KERB_WIDTH : 0) + RUN_OFF_WIDTH ? 'runOff' : 'gravel';
    return 'grass';
  }

  /** How far round the lap `point` is, in metres from the start line. */
  progressAt(point: Vector3): number {
    return this.locate(point).sample.distance;
  }

  /** Where the wall on a side (0 left, 1 right) stands at `sample`. */
  barrierPoint(sample: TrackSample, sideIndex: 0 | 1): Vector3 {
    return sample.position.clone().addScaledVector(sample.left, (sideIndex === 0 ? 1 : -1) * sample.sides[sideIndex].barrier);
  }

  /** The runs of samples a side's wall stands along, as [first, last]: all the way round but where the pit lane runs through it. */
  wallRuns(sideIndex: 0 | 1): [number, number][] {
    return sampleRuns(this.samples, (sample) => !this.nearPitLane(this.barrierPoint(sample, sideIndex), 7));
  }

  /** Whether `point` is within `reach` metres of the pit lane. */
  nearPitLane(point: Vector3, reach: number): boolean {
    for (let index = 0; index < this.pitLane.length - 1; index++) {
      if (distanceToSegment(point, this.pitLane[index]!, this.pitLane[index + 1]!) < reach) return true;
    }
    return false;
  }

  private cellFor(point: Vector3, create = false): number[] {
    const key = `${Math.floor(point.x / CELL)},${Math.floor(point.z / CELL)}`;
    let cell = this.cells.get(key);
    if (!cell && create) this.cells.set(key, (cell = []));
    return cell ?? [];
  }

  /**
   * Brings in each barrier wherever it would stand on, or too near, another part of the track
   * (where the circuit passes close by itself) or the pit lane: halfway to it at most.
   */
  private clearBarriers(samples: TrackSample[]): TrackSample[] {
    const probe = new Vector3();
    return samples.map((sample) => {
      const cleared = (side: Side, outward: number): Side => {
        let barrier = side.barrier;
        for (let reach = sample.halfWidth + 1; reach <= side.barrier + BARRIER_CLEARANCE; reach += 2) {
          probe.copy(sample.position).addScaledVector(sample.left, outward * reach);
          const other = this.locate(probe);
          const lapsApart = Math.abs(other.sample.distance - sample.distance);
          // straight out sideways, the nearest sample is this one or a few metres either side; further
          // round the lap, it is another part of the track, as a chicane's other leg is
          const elsewhere = Math.min(lapsApart, this.length - lapsApart) > 15;
          if ((elsewhere && Math.abs(other.across) < other.sample.halfWidth + BARRIER_CLEARANCE) || this.nearPitLane(probe, BARRIER_CLEARANCE + 6)) {
            barrier = Math.max(Math.min(barrier, reach - BARRIER_CLEARANCE), sample.halfWidth + 1.5);
            break;
          }
        }
        return { ...side, barrier };
      };
      return { ...sample, sides: [cleared(sample.sides[0], 1), cleared(sample.sides[1], -1)] };
    });
  }
}

/** Contiguous runs of samples (wrapping round the lap) for which `wanted` holds, as [first, last] indices. */
export function sampleRuns(samples: readonly TrackSample[], wanted: (sample: TrackSample) => boolean): [number, number][] {
  const found: [number, number][] = [];
  let first = -1;
  for (let index = 0; index < samples.length; index++) {
    const holds = wanted(samples[index]!);
    if (holds && first < 0) first = index;
    if (!holds && first >= 0) {
      found.push([first, index - 1]);
      first = -1;
    }
  }
  if (first >= 0) {
    // a run to the end of the lap joins one from its start
    if (found.length > 0 && found[0]![0] === 0) found[0] = [first, found[0]![1] + samples.length];
    else found.push([first, samples.length - 1]);
  }
  return found;
}

/** The samples from `first` to `last` (which may wrap round), with the lap's distance carried on past its end. */
export function samplesFrom(samples: readonly TrackSample[], first: number, last: number): { sample: TrackSample; distance: number }[] {
  const out: { sample: TrackSample; distance: number }[] = [];
  const lapLength = samples[samples.length - 1]!.distance + samples[samples.length - 1]!.position.distanceTo(samples[0]!.position);
  for (let index = first; index <= last; index++) {
    const sample = samples[index % samples.length]!;
    out.push({ sample, distance: sample.distance + (index >= samples.length ? lapLength : 0) });
  }
  return out;
}

/** The mean of `values` over `reach` either side of `index`, round the loop. */
function average(values: readonly number[], index: number, reach: number): number {
  let sum = 0;
  for (let offset = -reach; offset <= reach; offset++) sum += values[(index + offset + values.length) % values.length]!;
  return sum / (2 * reach + 1);
}

/** `flags`, each true one spread `reach` either way round the loop. */
function spread(flags: readonly boolean[], reach: number): boolean[] {
  return flags.map((_flag, index) => {
    for (let offset = -reach; offset <= reach; offset++) if (flags[(index + offset + flags.length) % flags.length]) return true;
    return false;
  });
}

function distanceToSegment(point: Vector3, from: Vector3, to: Vector3): number {
  const alongX = to.x - from.x;
  const alongZ = to.z - from.z;
  const lengthSquared = alongX * alongX + alongZ * alongZ;
  const share = lengthSquared > 0 ? Math.min(Math.max(((point.x - from.x) * alongX + (point.z - from.z) * alongZ) / lengthSquared, 0), 1) : 0;
  return Math.hypot(point.x - (from.x + alongX * share), point.z - (from.z + alongZ * share));
}
