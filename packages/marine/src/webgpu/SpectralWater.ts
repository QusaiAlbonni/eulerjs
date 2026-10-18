import { Group } from 'three/webgpu';
import type { Camera, Renderer, Vector3 } from 'three/webgpu';
import type { SpectralWaves } from '../waves/SpectralWaves.js';
import { GpuWaveFields } from './GpuWaveFields.js';
import type { GpuWaveFieldsOptions } from './GpuWaveFields.js';
import { QuadtreeLod } from './QuadtreeLod.js';
import type { QuadtreeLodOptions } from './QuadtreeLod.js';
import { RingLod } from './RingLod.js';
import type { RingLodOptions } from './RingLod.js';

export type SpectralWaterOptions = GpuWaveFieldsOptions &
  (
    | ({ /** Quadtree nodes around the centre (CDLOD), culled to the camera's view if given one: one draw call. The default. */ lod?: 'quadtree' } & QuadtreeLodOptions)
    | ({ /** Concentric rings around the centre (a geometry clipmap): the same triangles every frame, about three draw calls a level. */ lod: 'rings' } & RingLodOptions)
  );

/**
 * A SpectralWaves sea drawn to the horizon with three's WebGPURenderer, on WebGPU or its WebGL 2
 * fallback: every wave of every patch on the GPU, the same sea the physics floats bodies on.
 * For WebGLRenderer, draw a SumOfSines sea with WaterMesh instead.
 *
 *     const water = new SpectralWater(waves);
 *     scene.add(water);
 *     // each frame, with the time the physics was last stepped to (world.renderTime) and the viewer:
 *     water.update(renderer, world.renderTime, camera.position, camera);
 */
export class SpectralWater extends Group {
  readonly waves: SpectralWaves;
  readonly fields: GpuWaveFields;
  readonly lod: RingLod | QuadtreeLod;

  constructor(waves: SpectralWaves, options: SpectralWaterOptions = {}) {
    super();
    this.waves = waves;
    this.fields = new GpuWaveFields(waves, options);
    this.lod = options.lod === 'rings' ? new RingLod(this.fields, options) : new QuadtreeLod(this.fields, options);
    this.add(this.lod);
  }

  /**
   * Evaluates the waves at `time` and lays the surface out around `centre`, the point it is
   * finest at: usually the camera's position. With `camera`, a quadtree leaves out what it can't see.
   */
  update(renderer: Renderer, time: number, centre: Vector3, camera?: Camera): void {
    if (!(renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      throw new Error('SpectralWater draws with three/webgpu\'s WebGPURenderer (which falls back to WebGL 2 by itself); with WebGLRenderer, draw a SumOfSines sea with WaterMesh instead');
    }
    this.fields.update(renderer, time);
    if (this.lod instanceof QuadtreeLod) this.lod.update(centre, camera);
    else this.lod.update(centre);
  }

  override dispose(): void {
    this.fields.dispose();
    this.lod.material.dispose();
    this.lod.traverse((object) => (object as { geometry?: { dispose(): void } }).geometry?.dispose());
  }
}
