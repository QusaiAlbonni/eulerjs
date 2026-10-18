import type { IUniform } from 'three';
import type { SumOfSines } from './SumOfSines.js';

/**
 * GLSL that evaluates a SumOfSines exactly as SumOfSines does on the CPU. Needs the define
 * WAVE_COUNT (= waves.waves.length) and the uniforms from `createSumOfSinesUniforms`.
 */
export const sumOfSinesShaderChunk = /* glsl */ `
uniform float waveTime;
uniform float wavePeakSharpness;
uniform float wavePeakOffset;
uniform float waveShapeMean;
uniform float waveMinSamplesPerPeriod;
uniform float waveFullSamplesPerPeriod;
uniform float waveAmplitude[WAVE_COUNT];
uniform float waveFrequency[WAVE_COUNT];
uniform float waveAngularFrequency[WAVE_COUNT];
uniform vec2 waveDirection[WAVE_COUNT];

float wavePhase(int index, vec2 point) {
  return waveFrequency[index] * dot(waveDirection[index], point) + waveAngularFrequency[index] * waveTime;
}

// 0 when a grid with this spacing has fewer than minSamples samples per period of the wave, 1 from fullSamples.
float waveResolvability(int index, float spacing, float minSamples, float fullSamples) {
  float period = 6.283185307179586 / waveFrequency[index];
  return smoothstep(minSamples, fullSamples, period / spacing);
}

float waveHeight(int index, vec2 point) {
  return waveAmplitude[index] * (exp(wavePeakSharpness * sin(wavePhase(index, point)) - wavePeakOffset) - waveShapeMean);
}

// Exact gradient of waveHeight with respect to the point.
vec2 waveSlope(int index, vec2 point) {
  float phase = wavePhase(index, point);
  float magnitude = wavePeakSharpness * waveAmplitude[index] * waveFrequency[index] * cos(phase)
    * exp(wavePeakSharpness * sin(phase) - wavePeakOffset);
  return waveDirection[index] * magnitude;
}

// How far wave index pushes a point per unit of its direction: its slope with the sharpness
// left out of the exponent, which keeps the warp gentle.
float waveWarpSlope(int index, vec2 point) {
  float phase = wavePhase(index, point);
  return wavePeakSharpness * waveAmplitude[index] * waveFrequency[index] * cos(phase) * exp(sin(phase) - wavePeakOffset);
}

// Surface point for the undisplaced grid position on a mesh whose vertices are spacing apart:
// (displaced x, height, displaced z). Waves the mesh can't resolve are faded out.
vec3 sumOfSinesSurface(vec2 grid, float spacing) {
  vec2 displaced = grid;
  float height = 0.0;
  float previousWeight = 1.0;
  for (int index = 0; index < WAVE_COUNT; index++) {
    float weight = waveResolvability(index, spacing, waveMinSamplesPerPeriod, waveFullSamplesPerPeriod);
    if (weight <= 0.0 && previousWeight <= 0.0) break;
    if (index > 0) {
      int previous = index - 1;
      displaced.x += previousWeight * waveWarpSlope(previous, displaced) * waveDirection[previous].x;
      displaced.y += previousWeight * waveWarpSlope(previous, displaced) * waveDirection[previous].y;
    }
    height += weight * waveHeight(index, grid);
    previousWeight = weight;
  }
  return vec3(displaced.x, height, displaced.y);
}
`;

export type SumOfSinesUniforms = Record<
  | 'waveTime'
  | 'wavePeakSharpness'
  | 'wavePeakOffset'
  | 'waveShapeMean'
  | 'waveMinSamplesPerPeriod'
  | 'waveFullSamplesPerPeriod'
  | 'waveAmplitude'
  | 'waveFrequency'
  | 'waveAngularFrequency'
  | 'waveDirection',
  IUniform
>;

/** Uniform values for `sumOfSinesShaderChunk`. Update `waveTime` with `updateSumOfSinesTime` every frame. */
export function createSumOfSinesUniforms(waves: SumOfSines, time = 0): SumOfSinesUniforms {
  return {
    waveTime: { value: waves.phaseTime(time) },
    wavePeakSharpness: { value: waves.peakSharpness },
    wavePeakOffset: { value: waves.peakOffset },
    waveShapeMean: { value: waves.waveShapeMean },
    waveMinSamplesPerPeriod: { value: waves.minSamplesPerPeriod },
    waveFullSamplesPerPeriod: { value: waves.fullSamplesPerPeriod },
    waveAmplitude: { value: waves.waves.map((wave) => wave.amplitude) },
    waveFrequency: { value: waves.waves.map((wave) => wave.frequency) },
    waveAngularFrequency: { value: waves.waves.map((wave) => wave.angularFrequency) },
    waveDirection: { value: waves.waves.map((wave) => wave.direction.clone()) },
  };
}

export function updateSumOfSinesTime(uniforms: SumOfSinesUniforms, waves: SumOfSines, time: number): void {
  uniforms.waveTime.value = waves.phaseTime(time);
}
