import { Box3, Frustum, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import type { Camera } from 'three/webgpu';
import { attribute, clamp, float, positionLocal, uniform, vec2, vec3 } from 'three/tsl';
import type { SpectralWaves } from '../waves/SpectralWaves.js';
import type { GpuWaveFields } from './GpuWaveFields.js';
import { cellGrid, morphTowardCoarser } from './lod.js';
import { createSpectralWaterMaterial } from './waterMaterial.js';
import type { SpectralWaterMaterial, SpectralWaterMaterialOptions } from './waterMaterial.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface QuadtreeLodOptions extends SpectralWaterMaterialOptions {
  /** Metres between vertices nearest the centre. Defaults to 0.25. */
  finestSpacing?: number | undefined;
  /** Cells across each node, even. Defaults to 4, which with `rangeFactor` 4 spaces vertices as RingLod's defaults do. */
  cellsAcross?: number | undefined;
  /** Sizes of node, each twice the one before. Defaults to 19: nodes from 1 m to 262 km, the root around the centre's and those around it reaching as far as RingLod's defaults. */
  levelCount?: number | undefined;
  /**
   * A node splits into four when the centre comes within this many times its size. A node can reach
   * this many times its size and its parent's diagonal from the centre, and its coarser neighbour
   * must not have begun to morph there, or the two crack apart: at least √2 / (2 × 0.7 - 1), about
   * 3.54. Defaults to 4.
   */
  rangeFactor?: number | undefined;
  /**
   * How far above and below sea level, and to the side, the waves can move the surface, for
   * culling nodes out of view. Defaults to following the sea: its significant wave height times
   * one and its choppiness, and a metre.
   */
  waveBound?: number | undefined;
  /** Room for this many nodes. Defaults to 4096. */
  capacity?: number | undefined;
}

/** Where morphing toward the coarser level starts, as a fraction of the distance where it ends. */
const MORPH_START = 0.7;
/** The least `rangeFactor` that keeps a node's coarser neighbours from morphing where they meet it. */
const LEAST_RANGE_FACTOR = Math.SQRT2 / (2 * MORPH_START - 1);

const box = new Box3();
const frustum = new Frustum();
const viewProjection = new Matrix4();

/**
 * The sea as a quadtree of square nodes (Strugar's CDLOD, 2009): from a few nodes the size of the
 * whole sea around the centre, each splits into four while the centre is near enough, so that
 * nodes grow with distance from it. Every node is the same grid, drawn in one instanced call; its
 * vertices morph onto the grid twice as coarse by the distance its parent stops splitting at,
 * so neighbours of different sizes meet without cracks. Given the camera, nodes out of its view
 * are left out.
 */
export class QuadtreeLod extends Mesh {
  readonly finestSpacing: number;
  readonly cellsAcross: number;
  readonly levelCount: number;
  readonly rangeFactor: number;
  /** As set, or undefined to follow the sea. */
  waveBound: number | undefined;
  private readonly waves: SpectralWaves;
  declare geometry: InstancedBufferGeometry;
  declare material: SpectralWaterMaterial;
  /** Nodes drawn the last update. */
  nodeCount = 0;

  /** Per node: its corner's x and z, its vertex spacing, and the distance its morphing ends at (0 for none). */
  private readonly nodes: InstancedBufferAttribute;
  private readonly centre = new Vector3();
  private readonly centreUniform = uniform(new Vector3());
  private cullingCamera: Camera | undefined;
  private cullingBound = 0;

  constructor(fields: GpuWaveFields, options: QuadtreeLodOptions = {}) {
    const finestSpacing = options.finestSpacing ?? 0.25;
    const cellsAcross = options.cellsAcross ?? 4;
    if (cellsAcross % 2 !== 0) throw new RangeError(`cellsAcross must be even, got ${cellsAcross}`);
    const rangeFactor = options.rangeFactor ?? 4;
    if (!(rangeFactor >= LEAST_RANGE_FACTOR)) throw new RangeError(`rangeFactor must be at least ${LEAST_RANGE_FACTOR.toFixed(2)}, got ${rangeFactor}`);
    const capacity = options.capacity ?? 4096;

    const grid = cellGrid(0, 0, cellsAcross, cellsAcross);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', grid.getAttribute('position'));
    geometry.setIndex(grid.getIndex());
    const nodes = new InstancedBufferAttribute(new Float32Array(4 * capacity), 4);
    nodes.setUsage(35048 /* DynamicDrawUsage */);
    geometry.setAttribute('node', nodes);
    geometry.instanceCount = 0;

    const centreUniform = uniform(new Vector3());
    const node = attribute('node', 'vec4') as Node;
    const cells = vec2(positionLocal.x, positionLocal.z);
    const spacing = node.z;
    const before = vec2(node.x, node.y).add(cells.mul(spacing));
    const distance = vec3(before.x, 0, before.y).sub(centreUniform).length();
    const morphEnd = node.w;
    const morph = clamp(distance.div(morphEnd.max(1e-6)).sub(MORPH_START).div(1 - MORPH_START), 0, 1).mul(morphEnd.greaterThan(0).select(float(1), float(0)));
    const gridPosition = vec2(node.x, node.y).add(morphTowardCoarser(cells, morph).mul(spacing));
    // morphed onto the coarser grid, a vertex samples the waves as that grid's vertices do, at its spacing
    const material = createSpectralWaterMaterial(fields, { grid: gridPosition, spacing: spacing.mul(morph.add(1)) }, options);
    super(geometry, material);

    this.finestSpacing = finestSpacing;
    this.cellsAcross = cellsAcross;
    this.levelCount = options.levelCount ?? 19;
    this.rangeFactor = rangeFactor;
    this.waveBound = options.waveBound;
    this.waves = fields.waves;
    this.nodes = nodes;
    this.centreUniform = centreUniform;
    this.frustumCulled = false;
    this.matrixAutoUpdate = false;
  }

  /** The size of the largest nodes, those of the last level. */
  get rootSize(): number {
    return this.cellsAcross * this.finestSpacing * 2 ** (this.levelCount - 1);
  }

  /** Metres from the centre the sea reaches at least: the roots around the centre's. */
  get reach(): number {
    return this.rootSize;
  }

  get triangleCount(): number {
    return this.nodeCount * this.cellsAcross * this.cellsAcross * 2;
  }

  get drawCallCount(): number {
    return this.nodeCount > 0 ? 1 : 0;
  }

  /** Chooses the nodes around `centre`, the viewer usually; with `camera`, only those in its view. */
  update(centre: Vector3, camera?: Camera): void {
    this.centre.copy(centre);
    this.centreUniform.value.copy(centre);
    this.cullingCamera = camera;
    this.cullingBound = this.reachOfWaves;
    if (camera) {
      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem);
    }
    this.nodeCount = 0;
    const rootSize = this.rootSize;
    const rootColumn = Math.floor(centre.x / rootSize);
    const rootRow = Math.floor(centre.z / rootSize);
    for (let row = rootRow - 1; row <= rootRow + 1; row++) {
      for (let column = rootColumn - 1; column <= rootColumn + 1; column++) this.select(column * rootSize, row * rootSize, this.levelCount - 1);
    }
    this.geometry.instanceCount = this.nodeCount;
    this.nodes.clearUpdateRanges();
    this.nodes.addUpdateRange(0, 4 * this.nodeCount);
    this.nodes.needsUpdate = true;
  }

  /** Draws the node at (cornerX, cornerZ) of level `level`, or its children if the centre is near enough. */
  /** How far the waves can move the surface, as `waveBound` is. */
  private get reachOfWaves(): number {
    return this.waveBound ?? this.waves.significantWaveHeight * (1 + this.waves.choppiness) + 1;
  }

  private select(cornerX: number, cornerZ: number, level: number): void {
    const size = this.cellsAcross * this.finestSpacing * 2 ** level;
    if (this.cullingCamera) {
      // as far as the waves can move it
      const bound = this.cullingBound;
      box.min.set(cornerX - bound, -bound, cornerZ - bound);
      box.max.set(cornerX + size + bound, bound, cornerZ + size + bound);
      if (!frustum.intersectsBox(box)) return;
    }
    // from the node itself, flat, as the vertices measure it for their morphing
    box.min.set(cornerX, 0, cornerZ);
    box.max.set(cornerX + size, 0, cornerZ + size);
    const distance = box.distanceToPoint(this.centre);
    if (level > 0 && distance < this.rangeFactor * size) {
      const half = size / 2;
      this.select(cornerX, cornerZ, level - 1);
      this.select(cornerX + half, cornerZ, level - 1);
      this.select(cornerX, cornerZ + half, level - 1);
      this.select(cornerX + half, cornerZ + half, level - 1);
      return;
    }
    if (this.nodeCount * 4 >= this.nodes.array.length) return;
    const at = 4 * this.nodeCount++;
    const data = this.nodes.array as Float32Array;
    data[at] = cornerX;
    data[at + 1] = cornerZ;
    data[at + 2] = size / this.cellsAcross;
    // the parent stops splitting at rangeFactor times its size: fully morphed onto its grid by then
    data[at + 3] = level === this.levelCount - 1 ? 0 : this.rangeFactor * 2 * size;
  }
}
