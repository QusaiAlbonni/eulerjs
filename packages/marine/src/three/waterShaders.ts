/**
 * GLSL the water material splices into MeshPhysicalMaterial. All of it runs after
 * `sumOfSinesShaderChunk`, whose uniforms and wave functions it uses.
 */

/** Vertex stage declarations: level-of-detail uniforms and the undisplaced coordinate for shading. */
export const waterVertexDeclarations = /* glsl */ `
uniform float waterBaseSpacing;
uniform float waterSpacingGrowth;
uniform float waterChunkSize;
varying vec2 vWaveCoord;

// Vertex spacing of the chunk under worldXZ. Chunks get coarser by waterSpacingGrowth every
// chunk away from the centre; growing it continuously instead of per chunk keeps neighbouring
// chunks agreeing on which waves exist along their shared edge.
float waterVertexSpacingAt(vec2 worldXZ, vec2 centerXZ) {
  vec2 offset = abs(worldXZ - centerXZ);
  return waterBaseSpacing * pow(waterSpacingGrowth, max(offset.x, offset.y) / waterChunkSize);
}
`;

/** Replaces `#include <begin_vertex>`: moves each grid vertex onto the wave surface. */
export const waterBeginVertex = /* glsl */ `
vec4 waterWorldPosition = modelMatrix * vec4(position, 1.0);
vWaveCoord = waterWorldPosition.xz;
float waterSpacing = waterVertexSpacingAt(waterWorldPosition.xz, modelMatrix[3].xz);
vec3 waterSurface = sumOfSinesSurface(waterWorldPosition.xz, waterSpacing);
waterWorldPosition.xyz = vec3(waterSurface.x, waterWorldPosition.y + waterSurface.y, waterSurface.z);
vec3 transformed = (inverse(modelMatrix) * waterWorldPosition).xyz;
`;

/** Fragment stage declarations: the per-pixel wave normal with anti-aliasing. */
export const waterFragmentDeclarations = /* glsl */ `
uniform float waterAntialiasMinSamples;
uniform float waterAntialiasFullSamples;
uniform float waterAntialiasRoughness;
uniform float waterSlopeVariance;
varying vec2 vWaveCoord;

// World-space normal of every wave, evaluated per pixel. Waves smaller than a few pixels are
// faded out so they can't sparkle; lostSlopeVariance is how much slope they took with them.
vec3 waterNormal(vec2 point, out float lostSlopeVariance) {
  float footprint = max(length(dFdx(point)), length(dFdy(point)));
  vec2 slope = vec2(0.0);
  lostSlopeVariance = 0.0;
  for (int index = 0; index < WAVE_COUNT; index++) {
    float weight = waveResolvability(index, footprint, waterAntialiasMinSamples, waterAntialiasFullSamples);
    slope += weight * waveSlope(index, point);
    float slopeScale = waveAmplitude[index] * waveFrequency[index];
    lostSlopeVariance += (1.0 - weight) * slopeScale * slopeScale * waterSlopeVariance;
  }
  return normalize(vec3(-slope.x, 1.0, -slope.y));
}
`;

/** Goes after `#include <roughnessmap_fragment>`. */
export const waterRoughnessFragment = /* glsl */ `
float waterLostSlopeVariance;
vec3 waterNormalWorld = waterNormal(vWaveCoord, waterLostSlopeVariance);
// Fold the slope of the faded-out waves into the GGX alpha, so far water gets a wider,
// dimmer highlight instead of the flat mirror you'd get from dropping them.
float waterAlpha = roughnessFactor * roughnessFactor;
roughnessFactor = sqrt(sqrt(waterAlpha * waterAlpha + waterAntialiasRoughness * waterLostSlopeVariance));
`;

/** Goes after `#include <normal_fragment_begin>`: swaps the flat geometry normal for the wave normal. */
export const waterNormalFragment = /* glsl */ `
normal = normalize((viewMatrix * vec4(waterNormalWorld, 0.0)).xyz);
#ifdef DOUBLE_SIDED
normal *= faceDirection;
#endif
nonPerturbedNormal = normal;
`;
