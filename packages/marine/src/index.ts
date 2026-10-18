/**
 * Waves, buoyancy and foils: the spectral and sum-of-sines seas, `Ocean` and `Wind`, `Buoyancy`, sails, keels and rudders as `Foil`s, and `WaterMesh` for WebGLRenderer.
 *
 * @packageDocumentation
 * @module @eulerjs/marine
 */
export { SumOfSines } from './waves/SumOfSines.js';
export type { SumOfSinesOptions, WaveComponent } from './waves/SumOfSines.js';
export { SpectralWaves } from './waves/SpectralWaves.js';
export type { SeaSettings, SpectralWavesOptions, SwellWave, WavePatch } from './waves/SpectralWaves.js';
export type { WaveSurface } from './waves/WaveSurface.js';
export { directionalSpread, jonswap, jonswapParameters, wavenumberSpectrum } from './waves/spectrum.js';
export type { SeaState } from './waves/spectrum.js';
export { inverseFft2d } from './waves/fft.js';
export { serveSpectralFields } from './waves/spectralWorker.js';
export type { SpectralPort } from './waves/spectralWorker.js';
export { SurfaceSampler } from './waves/SurfaceSampler.js';
export { SurfaceGrid } from './waves/SurfaceGrid.js';
export { createSumOfSinesUniforms, sumOfSinesShaderChunk, updateSumOfSinesTime } from './waves/sumOfSinesShader.js';
export type { SumOfSinesUniforms } from './waves/sumOfSinesShader.js';
export { Ocean, Wind } from './media.js';
export type { FluidMedium, OceanOptions, WindOptions } from './media.js';
// Voxels moved to the core package; re-exported so existing imports keep working.
export { Voxels } from '@eulerjs/core';
export type { VoxelizeOptions } from '@eulerjs/core';
export { Buoyancy } from './Buoyancy.js';
export type { BuoyancyOptions } from './Buoyancy.js';
export { Foil } from './foils/Foil.js';
export type { FoilOptions } from './foils/Foil.js';
export { camberedSailPolar, sailPolar, symmetricFoilPolar, TablePolar } from './foils/polars.js';
export type { CamberedSailOptions, Polar, SymmetricFoilOptions } from './foils/polars.js';
export { WaterMesh } from './three/WaterMesh.js';
export type { WaterMeshOptions, WaterUniforms } from './three/WaterMesh.js';
export { computeWaterLod } from './three/waterLod.js';
export type { WaterLod, WaterLodOptions } from './three/waterLod.js';
