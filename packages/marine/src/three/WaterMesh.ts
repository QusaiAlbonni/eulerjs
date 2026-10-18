import { BatchedMesh, MathUtils, MeshPhysicalMaterial, PlaneGeometry, RepeatWrapping, Vector3 } from 'three';
import type { IUniform, MeshPhysicalMaterialParameters, Object3D, Texture, WebGLProgramParametersWithUniforms } from 'three';
import type { World } from 'eulerjs';
import { Ocean } from '../media.js';
import { SumOfSines } from '../waves/SumOfSines.js';
import { createSumOfSinesUniforms, sumOfSinesShaderChunk, updateSumOfSinesTime } from '../waves/sumOfSinesShader.js';
import type { SumOfSinesUniforms } from '../waves/sumOfSinesShader.js';
import { computeWaterLod } from './waterLod.js';
import type { WaterLod } from './waterLod.js';
import {
  waterBeginVertex,
  waterFragmentDeclarations,
  waterNormalFragment,
  waterRoughnessFragment,
  waterVertexDeclarations,
} from './waterShaders.js';

export interface WaterMeshOptions {
  /** The mesh stays centred under this object, moving in steps of `lod.snapStep`. */
  follow?: Object3D | undefined;
  /**
   * The world the water belongs to. With it, the mesh animates itself every render at
   * `world.renderTime`, in step with the bodies, and you never call `update`.
   */
  world?: World | undefined;
  /** Tiling texture for fine ripples, used as a bump map that drifts with time. */
  normalMap?: Texture;
  /** Edge length of one chunk, in metres. Defaults to 150. */
  chunkSize?: number;
  /** Chunks along each side of the grid (even). Defaults to 8. */
  chunkCount?: number;
  /** How much coarser each ring of chunks is than the ring inside it. Defaults to 1.25. */
  chunkDropOff?: number;
  /**
   * Waves covering fewer than this many pixels per period are dropped from the shading normal
   * and their slope is turned into roughness instead. Defaults to 2...
   */
  antialiasMinSamplesPerPeriod?: number;
  /** ...and waves are fully shaded from this many pixels per period. Defaults to 4. */
  antialiasFullSamplesPerPeriod?: number;
  /** How strongly the slope of faded-out waves turns into roughness; 0 disables it. Defaults to 1. */
  antialiasRoughness?: number;
  /** Overrides for the water's MeshPhysicalMaterial. */
  material?: MeshPhysicalMaterialParameters;
}

export type WaterUniforms = SumOfSinesUniforms &
  Record<
    | 'waterBaseSpacing'
    | 'waterSpacingGrowth'
    | 'waterChunkSize'
    | 'waterAntialiasMinSamples'
    | 'waterAntialiasFullSamples'
    | 'waterAntialiasRoughness'
    | 'waterSlopeVariance',
    IUniform
  >;

const DEFAULT_MATERIAL: MeshPhysicalMaterialParameters = {
  color: 0x112234,
  roughness: 0.05,
  metalness: 0.1,
  reflectivity: 0.8,
  ior: 1.333,
  thickness: 0.5,
  envMapIntensity: 1,
  specularIntensity: 0.5,
  specularColor: 0xffffff,
  bumpScale: 0.4,
};

/** How fast the ripple texture drifts, in texture repeats per second. */
const RIPPLE_DRIFT_SPEED = 0.01;

const followPosition = new Vector3();

/**
 * Renders a SumOfSines ocean: a grid of chunks around the follow target, displaced on the GPU
 * by exactly the waves the physics uses. The centre chunks resolve the same waves as the
 * physics (both use `waves.sampleSpacing`); farther chunks drop the shortest waves from the
 * geometry and keep them only in the per-pixel normal.
 */
export class WaterMesh extends BatchedMesh {
  readonly waves: SumOfSines;
  readonly lod: WaterLod;
  readonly chunkSize: number;
  readonly uniforms: WaterUniforms;
  follow: Object3D | undefined;
  world: World | undefined;
  declare material: MeshPhysicalMaterial;

  /** Renders an Ocean's surface, or a SumOfSines directly. */
  constructor(source: Ocean<SumOfSines> | SumOfSines, options: WaterMeshOptions = {}) {
    const waves = source instanceof Ocean ? source.waves : source;
    if (!(waves instanceof SumOfSines)) {
      throw new Error("WaterMesh draws a SumOfSines sea: give the Ocean `waves: new SumOfSines()`, or draw a SpectralWaves one with SpectralWater from '@eulerjs/marine/webgpu'");
    }
    const chunkSize = options.chunkSize ?? 150;
    const chunkCount = options.chunkCount ?? 8;
    const lod = computeWaterLod({
      chunkSize,
      chunkCount,
      chunkDropOff: options.chunkDropOff ?? 1.25,
      centerSpacing: waves.sampleSpacing,
    });
    const chunks = createChunkGeometries(lod, chunkSize);
    const vertexCapacity = chunks.reduce((total, chunk) => total + chunk.getAttribute('position').count, 0);
    const indexCapacity = chunks.reduce((total, chunk) => total + chunk.getIndex()!.count, 0);
    super(chunks.length, vertexCapacity, indexCapacity, createWaterMaterial(options));

    this.waves = waves;
    this.lod = lod;
    this.chunkSize = chunkSize;
    this.follow = options.follow;
    this.world = options.world;
    this.receiveShadow = true;
    this.uniforms = {
      ...createSumOfSinesUniforms(waves),
      waterBaseSpacing: { value: lod.baseSpacing },
      waterSpacingGrowth: { value: lod.growth },
      waterChunkSize: { value: chunkSize },
      waterAntialiasMinSamples: { value: options.antialiasMinSamplesPerPeriod ?? 2 },
      waterAntialiasFullSamples: { value: options.antialiasFullSamplesPerPeriod ?? 4 },
      waterAntialiasRoughness: { value: options.antialiasRoughness ?? 1 },
      waterSlopeVariance: { value: waveSlopeVariance(waves.peakSharpness, waves.peakOffset) },
    };
    this.material.defines = { ...this.material.defines, WAVE_COUNT: String(waves.waves.length) };
    this.material.onBeforeCompile = (shader) => this.injectWaterShader(shader);

    for (const chunk of chunks) {
      this.addInstance(this.addGeometry(chunk));
      chunk.dispose();
    }
  }

  /**
   * Moves the mesh under the follow target and advances the waves to `time` (simulation seconds,
   * by default the world's render time). Only needed without the `world` option.
   */
  update(time = this.world?.renderTime ?? 0): void {
    if (this.follow) {
      this.follow.updateWorldMatrix(true, false);
      followPosition.setFromMatrixPosition(this.follow.matrixWorld);
      const step = this.lod.snapStep;
      this.position.x = Math.round(followPosition.x / step) * step;
      this.position.z = Math.round(followPosition.z / step) * step;
    }
    updateSumOfSinesTime(this.uniforms, this.waves, time);
    this.material.bumpMap?.offset.set(time * RIPPLE_DRIFT_SPEED, time * RIPPLE_DRIFT_SPEED);
  }

  override onBeforeRender(...renderArguments: Parameters<BatchedMesh['onBeforeRender']>): void {
    if (this.world) {
      this.update();
      // the scene's matrices were updated before rendering started; refresh ours after moving
      this.updateMatrixWorld();
    }
    // BatchedMesh builds its draw list here
    super.onBeforeRender(...renderArguments);
  }

  private injectWaterShader(shader: WebGLProgramParametersWithUniforms): void {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = sumOfSinesShaderChunk + waterVertexDeclarations + shader.vertexShader.replace('#include <begin_vertex>', waterBeginVertex);
    shader.fragmentShader =
      sumOfSinesShaderChunk +
      waterFragmentDeclarations +
      shader.fragmentShader
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${waterRoughnessFragment}`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${waterNormalFragment}`);
  }
}

/** One flat grid per chunk, laid out row by row from +z to -z and column by column from -x to +x. */
function createChunkGeometries(lod: WaterLod, chunkSize: number): PlaneGeometry[] {
  const chunkCount = lod.counts.length;
  const firstCenter = chunkSize * (chunkCount / 2) - chunkSize / 2;
  const chunks: PlaneGeometry[] = [];
  lod.counts.forEach((row, rowIndex) =>
    row.forEach((segments, columnIndex) => {
      const chunk = new PlaneGeometry(chunkSize, chunkSize, segments, segments);
      chunk.rotateX(MathUtils.degToRad(-90));
      chunk.translate(-firstCenter + columnIndex * chunkSize, 0, firstCenter - rowIndex * chunkSize);
      chunks.push(chunk);
    }),
  );
  return chunks;
}

function createWaterMaterial(options: WaterMeshOptions): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({ ...DEFAULT_MATERIAL, ...options.material });
  if (options.normalMap) {
    options.normalMap.wrapS = RepeatWrapping;
    options.normalMap.wrapT = RepeatWrapping;
    material.bumpMap = options.normalMap;
  }
  return material;
}

/**
 * Mean squared slope of one wave over a period, per unit of amplitude and frequency: how much
 * slope a wave takes with it when the shader fades it out.
 */
function waveSlopeVariance(peakSharpness: number, peakOffset: number): number {
  const samples = 256;
  let sum = 0;
  for (let sample = 0; sample < samples; sample++) {
    const phase = (2 * Math.PI * sample) / samples;
    const slope = peakSharpness * Math.cos(phase) * Math.exp(peakSharpness * Math.sin(phase) - peakOffset);
    sum += slope * slope;
  }
  return sum / samples;
}
