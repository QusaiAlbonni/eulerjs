import { MathUtils, Quaternion, Vector3 } from 'three';
import { geometryOfObject, Voxels } from '@eulerjs/core';
import type { Behavior, Body, World } from '@eulerjs/core';
import type { Ocean } from './media.js';
import type { WaveSurface } from './waves/WaveSurface.js';
import { SurfaceGrid } from './waves/SurfaceGrid.js';

/**
 * How many steps ahead to ask the sea to get ready for. A worker's answers arrive between frames,
 * so it can only be ready for the steps of frames to come: enough for frames of up to this many.
 */
const PREFETCH_STEPS = 3;

export interface BuoyancyOptions {
  ocean: Ocean<WaveSurface>;
  /**
   * The hull as cells in the body frame. Defaults to the body's own voxels (a body added with
   * `shape: 'voxels'`), or else to voxelizing the body's meshes when the behaviour is attached.
   */
  voxels?: Voxels | undefined;
  /** Cell size used when the behaviour voxelizes the body's meshes itself. */
  cellSize?: number | undefined;
  /**
   * Resistance to cells moving into or out of the water, in N·s/m per m³ of submerged cell. It
   * is what makes a hull settle instead of bobbing and rocking forever.
   */
  heaveDamping?: number | undefined;
  /** Extra drag, quadratic in speed, on partly submerged cells plunging into the water (slamming). */
  slamCoefficient?: number | undefined;
  /** Linear drag (per second) when fully submerged; it scales down to the minimum as the hull leaves the water. */
  linearDrag?: number | undefined;
  angularDrag?: number | undefined;
  /** Drag that remains however little of the hull is in the water. */
  minimumLinearDrag?: number | undefined;
  minimumAngularDrag?: number | undefined;
  /**
   * Spacing of the grid the wave surface is sampled on under the hull, in metres (default 0.5).
   * The cost of a step grows with the hull's area divided by this squared, not with the number
   * of cells; see SurfaceGrid for the accuracy.
   */
  surfaceSampleSpacing?: number | undefined;
}

const cellPosition = new Vector3();
const cellForce = new Vector3();
const upward = new Vector3();
const dragForce = new Vector3();
const dragTorque = new Vector3();
const cellVelocity = new Vector3();
const fromCentre = new Vector3();

/** The velocity of the body's point at `point`: its centre's, and its turning's, ω × r. */
function pointVelocity(body: Body, point: Vector3, target: Vector3): Vector3 {
  fromCentre.copy(point).sub(body.worldCenterOfMass);
  return target.crossVectors(body.angularVelocity, fromCentre).add(body.velocity);
}
const inverseOrientation = new Quaternion();

/**
 * Archimedes' principle per cell: each cell under the surface is pushed up by the weight of the
 * water it displaces, at its own position, so a tilted hull is pushed back upright. One instance
 * per body: it remembers each cell's depth between steps.
 */
export class Buoyancy implements Behavior {
  readonly ocean: Ocean<WaveSurface>;
  heaveDamping: number;
  slamCoefficient: number;
  linearDrag: number;
  angularDrag: number;
  minimumLinearDrag: number;
  minimumAngularDrag: number;

  /** Fraction of the hull's volume under water on the last step, from 0 to 1. */
  submergedFraction = 0;
  /** Sum of the buoyant and damping forces applied on the last step, in world space. */
  readonly lastForce = new Vector3();

  private readonly givenVoxels: Voxels | undefined;
  private readonly cellSize: number | undefined;
  private readonly surface: SurfaceGrid;
  // Set up for the body in attach().
  private resolvedVoxels: Voxels | undefined;
  /** How far below the surface each cell centre was on the previous step (NaN before the first). */
  private previousDepths = new Float64Array(0);
  /** World position of every cell on the current step, three numbers per cell. */
  private cellPositions = new Float64Array(0);

  constructor(options: BuoyancyOptions) {
    this.ocean = options.ocean;
    this.heaveDamping = options.heaveDamping ?? 3000;
    this.slamCoefficient = options.slamCoefficient ?? 1;
    this.linearDrag = options.linearDrag ?? 1;
    this.angularDrag = options.angularDrag ?? 1;
    this.minimumLinearDrag = options.minimumLinearDrag ?? 0.02;
    this.minimumAngularDrag = options.minimumAngularDrag ?? 0.02;
    this.givenVoxels = options.voxels;
    this.cellSize = options.cellSize;
    this.surface = new SurfaceGrid(options.ocean.waves, options.surfaceSampleSpacing);
  }

  /** The cells the hull is sampled at, once the behaviour is attached to a body. */
  get voxels(): Voxels {
    if (!this.resolvedVoxels) throw new Error('Buoyancy has no voxels until it is added to a body');
    return this.resolvedVoxels;
  }

  attach(body: Body): void {
    this.resolvedVoxels = this.givenVoxels ?? body.voxels ?? this.voxelizeObjectOf(body);
    this.previousDepths = new Float64Array(this.resolvedVoxels.cells.length).fill(Number.NaN);
    this.cellPositions = new Float64Array(this.resolvedVoxels.cells.length * 3);
  }

  private voxelizeObjectOf(body: Body): Voxels {
    const geometry = body.object ? geometryOfObject(body.object) : undefined;
    if (!geometry) {
      throw new Error('Buoyancy needs voxels, or a body bound to an object with meshes to voxelize');
    }
    return Voxels.fromGeometry(geometry, { cellSize: this.cellSize });
  }

  fixedUpdate(body: Body, timestep: number, world: World): void {
    const gravityStrength = world.gravity.length();
    if (gravityStrength === 0) return;
    upward.copy(world.gravity).divideScalar(-gravityStrength);

    const { cellSize, cellVolume, cells } = this.voxels;
    const density = this.ocean.density;
    const buoyancyPerCell = density * cellVolume * gravityStrength;
    let submergedCells = 0;
    this.lastForce.set(0, 0, 0);

    // the steps to come, from the steps done, as the world counts its time
    const stepsDone = Math.round(world.time / timestep);
    for (let ahead = 1; ahead <= PREFETCH_STEPS; ahead++) this.ocean.waves.prefetch?.((stepsDone + ahead) * timestep);
    this.sampleSurfaceUnderCells(body, world.time);
    cells.forEach((_cell, index) => {
      cellPosition.fromArray(this.cellPositions, index * 3);
      const depth = this.surface.heightAt(cellPosition.x, cellPosition.z) - cellPosition.y;
      const submerged = MathUtils.clamp(depth / cellSize + 0.5, 0, 1);
      const previousDepth = this.previousDepths[index]!;
      this.previousDepths[index] = depth;
      if (submerged === 0) return;
      submergedCells += submerged;

      let upwardForce = buoyancyPerCell * submerged;
      if (!Number.isNaN(previousDepth)) {
        // How fast the cell sinks relative to the water; resisting it damps heave, pitch and roll.
        // Relative to the water itself where the waves say how it moves: the surface at a place
        // rises faster than the water does as a steep crest passes, and damping against that
        // would throw bodies off the crests
        const sinkRate = this.surface.knowsRiseRate
          ? this.surface.riseRateAt(cellPosition.x, cellPosition.z) - pointVelocity(body, cellPosition, cellVelocity).dot(upward)
          : (depth - previousDepth) / timestep;
        upwardForce += this.heaveDamping * cellVolume * submerged * sinkRate;
        if (sinkRate > 0 && submerged < 1) {
          upwardForce += 0.5 * density * this.slamCoefficient * cellSize * cellSize * sinkRate * sinkRate;
        }
      }
      cellForce.copy(upward).multiplyScalar(upwardForce);
      this.lastForce.add(cellForce);
      body.applyForce(cellForce, cellPosition);
    });

    this.submergedFraction = cells.length === 0 ? 0 : submergedCells / cells.length;
    this.applyWaterDrag(body);
  }

  /** Moves every cell into world space and samples the surface over the area they cover. */
  private sampleSurfaceUnderCells(body: Body, time: number): void {
    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumZ = Infinity;
    let maximumZ = -Infinity;
    this.voxels.cells.forEach((cell, index) => {
      body.localToWorld(cellPosition.copy(cell)).toArray(this.cellPositions, index * 3);
      minimumX = Math.min(minimumX, cellPosition.x);
      maximumX = Math.max(maximumX, cellPosition.x);
      minimumZ = Math.min(minimumZ, cellPosition.z);
      maximumZ = Math.max(maximumZ, cellPosition.z);
    });
    if (this.voxels.cells.length > 0) this.surface.update(minimumX, maximumX, minimumZ, maximumZ, time);
  }

  /** Damping proportional to velocity, stronger the more of the hull is in the water. */
  private applyWaterDrag(body: Body): void {
    const linearRate = MathUtils.lerp(this.minimumLinearDrag, this.linearDrag, this.submergedFraction);
    const angularRate = MathUtils.lerp(this.minimumAngularDrag, this.angularDrag, this.submergedFraction);
    body.applyForce(dragForce.copy(body.velocity).multiplyScalar(-linearRate * body.mass));

    // Torque -rate · I ω, with the inertia rotated into world space.
    const inertia = body.massProperties?.inertia;
    if (!inertia) return;
    inverseOrientation.copy(body.quaternion).invert();
    dragTorque.copy(body.angularVelocity).applyQuaternion(inverseOrientation).applyMatrix3(inertia).applyQuaternion(body.quaternion);
    body.applyTorque(dragTorque.multiplyScalar(-angularRate));
  }
}
