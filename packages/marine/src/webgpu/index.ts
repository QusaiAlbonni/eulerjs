/**
 * The spectral sea drawn with three's WebGPURenderer (on WebGPU, or on its WebGL 2 fallback),
 * apart from the main entry so that importing `@eulerjs/marine` doesn't pull in three/webgpu.
 *
 * @packageDocumentation
 * @module @eulerjs/marine/webgpu
 */
export { GpuWaveFields } from './GpuWaveFields.js';
export type { FieldPatch, GpuWaveFieldsOptions, WaveFieldTextures } from './GpuWaveFields.js';
export { SpectralWater } from './SpectralWater.js';
export type { SpectralWaterOptions } from './SpectralWater.js';
export { RingLod } from './RingLod.js';
export type { RingLodOptions } from './RingLod.js';
export { QuadtreeLod } from './QuadtreeLod.js';
export type { QuadtreeLodOptions } from './QuadtreeLod.js';
export { createSpectralWaterMaterial } from './waterMaterial.js';
export type { SpectralWaterMaterial, SpectralWaterMaterialOptions, SpectralWaterUniforms, WaterVertex } from './waterMaterial.js';
export { seaFog } from './seaFog.js';
export type { SeaFogOptions, SeaFogUniforms } from './seaFog.js';
