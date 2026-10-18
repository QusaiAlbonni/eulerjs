import { Group, Mesh, Vector2 } from 'three/webgpu';
import type { BufferGeometry, Vector3 } from 'three/webgpu';
import { abs, clamp, float, max, positionLocal, uniform, vec2 } from 'three/tsl';
import type { GpuWaveFields } from './GpuWaveFields.js';
import { cellGrid, morphTowardCoarser } from './lod.js';
import { createSpectralWaterMaterial } from './waterMaterial.js';
import type { SpectralWaterMaterial, SpectralWaterMaterialOptions } from './waterMaterial.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface RingLodOptions extends SpectralWaterMaterialOptions {
  /** Metres between vertices nearest the centre. Defaults to 0.25. */
  finestSpacing?: number | undefined;
  /** Cells across each level, a multiple of 4. Defaults to 64. */
  cellsAcross?: number | undefined;
  /** Levels, each with twice the spacing and twice the reach of the one inside it. Defaults to 16, reaching 0.25 × 32 × 2¹⁵ m, about 260 km. */
  levelCount?: number | undefined;
  /** The finest level drawn reaches at least this many times the centre's height, so that from high up the finest levels are left out. Defaults to 2. */
  reachOverHeight?: number | undefined;
}

/** What one of the meshes draws: set before each frame, read by the material per object. */
interface LevelPlacement {
  centre: Vector2;
  spacing: number;
  /** Cells from the level's centre to the piece's own origin: for the trims. */
  offset: Vector2;
  /** Cells from the centre to where morphing is complete, or 0 for no morphing. */
  morphReach: number;
}

/** Where morphing toward the coarser level starts, as a fraction of the reach where it ends. */
const MORPH_START = 0.7;

/**
 * The sea as a geometry clipmap (Losasso and Hoppe 2004): square rings around the centre, each
 * with twice the vertex spacing of the one inside it, every level snapped to its own grid so that
 * vertices stay put on the sea as the centre moves. Snapping leaves the hole in each ring one cell
 * off from the level inside it on two sides; thin trims fill it. The outer band of every level
 * morphs onto the coarser grid, so the rings meet without cracks.
 *
 * Every ring is one mesh, as is each trim: about three draw calls a level, and the same triangles
 * however the centre moves.
 */
export class RingLod extends Group {
  readonly finestSpacing: number;
  readonly cellsAcross: number;
  readonly levelCount: number;
  readonly reachOverHeight: number;
  readonly material: SpectralWaterMaterial;

  private readonly levels: { ring: Mesh; columnTrim: Mesh; rowTrim: Mesh }[] = [];
  private readonly filled: Mesh;

  constructor(fields: GpuWaveFields, options: RingLodOptions = {}) {
    super();
    this.finestSpacing = options.finestSpacing ?? 0.25;
    this.cellsAcross = options.cellsAcross ?? 64;
    if (this.cellsAcross % 4 !== 0) throw new RangeError(`cellsAcross must be a multiple of 4, got ${this.cellsAcross}`);
    this.levelCount = options.levelCount ?? 16;
    this.reachOverHeight = options.reachOverHeight ?? 2;
    const half = this.cellsAcross / 2;
    const quarter = this.cellsAcross / 4;

    // each piece's placement, uniform for each object drawn
    const placementOf = (object: { userData: Record<string, unknown> } | null) => object!.userData.placement as LevelPlacement;
    const centre = uniform(new Vector2()).onObjectUpdate(({ object }) => placementOf(object).centre) as Node;
    const spacing = uniform(1).onObjectUpdate(({ object }) => placementOf(object).spacing) as Node;
    const offset = uniform(new Vector2()).onObjectUpdate(({ object }) => placementOf(object).offset) as Node;
    const morphReach = uniform(0).onObjectUpdate(({ object }) => placementOf(object).morphReach) as Node;

    const cells = vec2(positionLocal.x, positionLocal.z).add(offset);
    const boxDistance = max(abs(cells.x), abs(cells.y));
    const morph = clamp(boxDistance.div(max(morphReach, float(1e-6))).sub(MORPH_START).div(1 - MORPH_START), 0, 1).mul(morphReach.greaterThan(0).select(float(1), float(0)));
    const grid = centre.add(morphTowardCoarser(cells, morph).mul(spacing));
    // morphed onto the coarser grid, a vertex samples the waves as that grid's vertices do, at its spacing
    this.material = createSpectralWaterMaterial(fields, { grid, spacing: spacing.mul(morph.add(1)) }, options);

    const mesh = (geometry: BufferGeometry) => {
      const result = new Mesh(geometry, this.material);
      // placed in the shader
      result.frustumCulled = false;
      result.matrixAutoUpdate = false;
      result.userData.placement = { centre: new Vector2(), spacing: 1, offset: new Vector2(), morphReach: 0 } satisfies LevelPlacement;
      this.add(result);
      return result;
    };
    this.filled = mesh(cellGrid(-half, -half, this.cellsAcross, this.cellsAcross));
    // the hole is one cell wider than the level inside, on the + sides: snapping puts that one there or one cell up
    const ringGeometry = cellGrid(-half, -half, this.cellsAcross, this.cellsAcross, (column, row) => column >= -quarter && column < quarter + 1 && row >= -quarter && row < quarter + 1);
    const columnTrimGeometry = cellGrid(0, 0, 1, half + 1);
    const rowTrimGeometry = cellGrid(0, 0, half, 1);
    for (let level = 1; level < this.levelCount; level++) {
      this.levels.push({ ring: mesh(ringGeometry), columnTrim: mesh(columnTrimGeometry), rowTrim: mesh(rowTrimGeometry) });
    }
  }

  /** Metres from the centre to the edge of the outermost level. */
  get reach(): number {
    return (this.cellsAcross / 2) * this.finestSpacing * 2 ** (this.levelCount - 1);
  }

  /** Places the levels around `centre`: the viewer, usually. */
  update(centre: Vector3): void {
    const half = this.cellsAcross / 2;
    const quarter = this.cellsAcross / 4;
    const neededReach = this.reachOverHeight * Math.abs(centre.y);
    const firstLevel = Math.min(this.levelCount - 1, Math.max(0, Math.ceil(Math.log2(neededReach / (half * this.finestSpacing)))));

    // the first level drawn is the filled grid, centred on its own grid of twice its spacing
    const firstSpacing = this.finestSpacing * 2 ** firstLevel;
    const filled = this.filled.userData.placement as LevelPlacement;
    filled.centre.set(Math.round(centre.x / (2 * firstSpacing)) * 2 * firstSpacing, Math.round(centre.z / (2 * firstSpacing)) * 2 * firstSpacing);
    filled.spacing = firstSpacing;
    filled.morphReach = firstLevel === this.levelCount - 1 ? 0 : half;

    let inner = filled.centre;
    this.levels.forEach((pieces, index) => {
      const level = index + 1;
      const drawn = level > firstLevel;
      pieces.ring.visible = pieces.columnTrim.visible = pieces.rowTrim.visible = drawn;
      if (!drawn) return;
      const spacing = this.finestSpacing * 2 ** level;
      const ring = pieces.ring.userData.placement as LevelPlacement;
      // snapped at or below the level inside, so that one sits no cell or one cell up from this one's centre
      ring.centre.set(Math.floor(inner.x / (2 * spacing)) * 2 * spacing, Math.floor(inner.y / (2 * spacing)) * 2 * spacing);
      ring.spacing = spacing;
      ring.morphReach = level === this.levelCount - 1 ? 0 : half;
      const columnsUp = Math.round((inner.x - ring.centre.x) / spacing);
      const rowsUp = Math.round((inner.y - ring.centre.y) / spacing);
      // the column of the hole the level inside leaves, then the row of it, along the level inside
      const column = pieces.columnTrim.userData.placement as LevelPlacement;
      column.centre.copy(ring.centre);
      column.spacing = spacing;
      column.offset.set(columnsUp === 0 ? quarter : -quarter, -quarter);
      const row = pieces.rowTrim.userData.placement as LevelPlacement;
      row.centre.copy(ring.centre);
      row.spacing = spacing;
      row.offset.set(-quarter + columnsUp, rowsUp === 0 ? quarter : -quarter);
      inner = ring.centre;
    });
  }

  /** Triangles drawn, for comparisons. */
  get triangleCount(): number {
    let total = 0;
    this.traverseVisible((object) => {
      if (object instanceof Mesh) total += object.geometry.getIndex()!.count / 3;
    });
    return total;
  }

  get drawCallCount(): number {
    let total = 0;
    this.traverseVisible((object) => {
      if (object instanceof Mesh) total++;
    });
    return total;
  }
}
