import { Color, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, Vector3 } from 'three/webgpu';
import type { Texture } from 'three/webgpu';
import { abs, cameraPosition, clamp, cos, dot, exp, float, int, log2, max, mix, normalize, pmremTexture, positionWorld, pow, reflect, sin, smoothstep, texture, transformNormalToView, uniform, varying, vec2, vec3 } from 'three/tsl';
import type { GpuWaveFields } from './GpuWaveFields.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface SpectralWaterMaterialOptions {
  /** The colour of the water looked into, lit by the sky. Defaults to a light sea blue: lighter than the open ocean's, which is all but black. */
  color?: Color | undefined;
  /** The colour of the light the water scatters back, brightest through the crests and looked into toward the sun. Defaults to a turquoise. */
  scatterColor?: Color | undefined;
  /** How much light the water scatters back, 0 for none. Defaults to 1. */
  scatter?: number | undefined;
  /** How much of the foam GpuWaveFields keeps is drawn, 0 for none. Defaults to 1. */
  foamAmount?: number | undefined;
  /** Taken off each patch's foam, from the largest, before they are added up: to clear the faint foam a patch leaves all over. Defaults to none. */
  foamSubtract?: readonly number[] | undefined;
  /** How many times more foam there is on a wave's peak than its Jacobian alone makes. Defaults to 2.8. */
  foamPeakBoost?: number | undefined;
  /**
   * How far down a wave foam reaches before it is gone, as a height over half the significant
   * wave height: 0, the still water's level; 0.5, halfway up a typical crest. Defaults to -0.15,
   * a little below it, so foam trails a way down the backs of the waves.
   */
  foamLowest?: number | undefined;
  /**
   * The sky, as PMREMGenerator makes it, best without the sun's disc in it. Given it, the water
   * is shaded as water looks: a mirror of the sky by Fresnel's law (a fiftieth looking straight
   * down, all of it at grazing angles, so the sea pales toward the horizon), over the deep water's
   * colour, with the sun glinting off it. Without it, it is a MeshPhysicalNodeMaterial lit by the
   * scene's lights and environment.
   */
  environment?: Texture | undefined;
  /** Toward the sun, for its glint, with `environment`. Defaults to straight up. */
  sunDirection?: Vector3 | undefined;
  /** The glint's colour and brightness, with `environment`: the sun is far brighter than the sky. Defaults to a warm white, 150. */
  sunColor?: Color | undefined;
  /** The sun's light on the water, which it scatters back and lights the foam with, with `environment`. Defaults to a warm white, 2.5. */
  sunLight?: Color | undefined;
}

/** Either material: physically lit, or shaded as a mirror of the sky given one. */
export type SpectralWaterMaterial = MeshPhysicalNodeMaterial | MeshBasicNodeMaterial;

/** The material's settings that can change as it runs, in `material.userData.uniforms`: set their `value`. */
export interface SpectralWaterUniforms {
  color: { value: Color };
  scatterColor: { value: Color };
  scatter: { value: number };
  sunDirection: { value: Vector3 };
  sunColor: { value: Color };
  sunLight: { value: Color };
  foamAmount: { value: number };
  foamPeakBoost: { value: number };
  foamLowest: { value: number };
  /** GpuWaveFields' own, for where foam grows, how fast, and how fast it fades. */
  foamBias: { value: number };
  foamPeakLift: { value: number };
  foamGrowth: { value: number };
  foamDecay: { value: number };
}

/** How strongly the water scatters the sun's light: through the crests, off faces turned to the eye, off sunlit faces, and off the bubbles in it. */
const SCATTER = { peaks: 1.5, faces: 0.06, sunlit: 0.04, bubbles: 0.015 };

/** How far the sun's glint spreads off a single wave, as 1 - cos of its angle: the sun's own size and then some. */
const GLINT_SPREAD = 1 / 600;

/** How high above the still water the crest under the pixel stands, from 0 to 1, given its height: the light it scatters. */
function crestOf(height: Node): Node {
  return clamp(height.mul(0.3), 0, 1);
}

/** Where a level of detail puts a vertex of the water before the waves move it: its undisplaced position on the sea, and the spacing of its vertices there. */
export interface WaterVertex {
  /** vec2: x and z in the world. */
  grid: Node;
  /**
   * float: metres between this vertex and its neighbours, which sets how finely it samples the
   * waves. Where levels meet, a vertex must sample them as the vertex of the other level it sits
   * on does, or the two get different heights and the surface cracks between them.
   */
  spacing: Node;
}

/**
 * The material of a SpectralWater: each vertex moved by every patch's displacement, each
 * sampled at the mip level of the vertex spacing so that waves too short for the mesh fade out of
 * it instead of aliasing; each pixel lit with the slopes of every wave, mipmapped too, and
 * foam where GpuWaveFields keeps it.
 */
export function createSpectralWaterMaterial(fields: GpuWaveFields, vertex: WaterVertex, options: SpectralWaterMaterialOptions = {}): SpectralWaterMaterial {
  const material = options.environment ? new MeshBasicNodeMaterial() : new MeshPhysicalNodeMaterial();
  const resolution = fields.resolution;

  // the gusts, where the vertex is, scaling the shorter patches' waves
  const vertexGust = fields.gustAt(vertex.grid);
  let displacement: Node = vec3(0);
  fields.patches.forEach((patch, index) => {
    const texelSize = patch.size / resolution;
    const level = max(log2(vertex.spacing.div(texelSize)), float(0));
    const moved = (texture(fields.textures.displacement, vertex.grid.div(patch.size)).level(level).depth(int(index)) as Node).xyz;
    displacement = displacement.add(fields.gusts(index) ? moved.mul(vertexGust) : moved);
  });
  // the wind sea's own height, before the swell under it: where its peaks are, for the foam
  const seaHeight = displacement.y;
  // and the swell, summed where it is: each wave fading out of the mesh where the vertices are too
  // far apart to carry it, a quarter of its length
  const choppiness = fields.choppinessNode;
  for (const swellWave of fields.swell) {
    const wave = swellWave as unknown as Node;
    const waveNumber = vec2(wave.x, wave.y).length();
    const angle = dot(vec2(wave.x, wave.y), vertex.grid).add(wave.w);
    const carried = float(1).sub(smoothstep(float(Math.PI / 2).div(waveNumber), float(Math.PI).div(waveNumber), vertex.spacing));
    const amplitude = wave.z.mul(carried);
    const sideways = amplitude.mul(choppiness).mul(sin(angle)).negate().div(waveNumber);
    displacement = displacement.add(vec3(sideways.mul(wave.x), amplitude.mul(cos(angle)), sideways.mul(wave.y)));
  }
  material.positionNode = vec3(vertex.grid.x, 0, vertex.grid.y).add(displacement);

  // the pixel's waves are those of the point of the sea it shows, before the waves moved it
  const grid = varying(vertex.grid, 'seaGrid') as Node;
  let slope: Node = vec2(0);
  let stretchX: Node = float(0);
  let stretchZ: Node = float(0);
  // how much the slopes vary within the pixel: each patch's mean square less its mean's square,
  // the patches' waves being independent of each other
  let slopeVariance: Node = float(0);
  // and where the pixel is: the slopes as much steeper, their squares the square of it
  const gust = fields.gustAt(grid);
  fields.patches.forEach((patch, index) => {
    const uv = grid.div(patch.size);
    const scale = fields.gusts(index) ? gust : float(1);
    const derivatives = (texture(fields.textures.derivatives, uv).depth(int(index)) as Node).mul(scale);
    const moments = (texture(fields.textures.slopeMoments, uv).depth(int(index)) as Node).mul(scale.mul(scale));
    slope = slope.add(derivatives.xy);
    stretchX = stretchX.add(derivatives.z);
    stretchZ = stretchZ.add(derivatives.w);
    slopeVariance = slopeVariance.add(max(moments.x.sub(derivatives.x.mul(derivatives.x)), 0)).add(max(moments.y.sub(derivatives.y.mul(derivatives.y)), 0));
  });
  // the swell's slopes and stretching, from its waves where the pixel is
  for (const swellWave of fields.swell) {
    const wave = swellWave as unknown as Node;
    const waveNumber = vec2(wave.x, wave.y).length();
    const angle = dot(vec2(wave.x, wave.y), grid).add(wave.w);
    const sine = sin(angle);
    const cosine = cos(angle);
    slope = slope.add(vec2(wave.x, wave.y).mul(wave.z.mul(sine).negate()));
    const stretching = wave.z.mul(choppiness).mul(cosine).negate().div(waveNumber);
    stretchX = stretchX.add(stretching.mul(wave.x).mul(wave.x));
    stretchZ = stretchZ.add(stretching.mul(wave.y).mul(wave.y));
  }
  // as a variance of the normal's angle, about each axis
  const roughness = clamp(slopeVariance.mul(0.5).sqrt(), 0, 1);
  // the displaced surface's normal: the height's slope over how far the sideways motion stretches the surface
  const towardX = stretchX.add(1);
  const towardZ = stretchZ.add(1);
  const normal = normalize(vec3(slope.x.div(towardX).negate(), 1, slope.y.div(towardZ).negate()));

  // the foam the fields keep, every patch's added up, each less as much as asked (Acerola's foam
  // subtract), to clear the faint foam a patch leaves all over
  const foamAmount = uniform(options.foamAmount ?? 1);
  let foamSum: Node = float(0);
  const foamTextures = fields.textures.foam;
  fields.patches.forEach((patch, index) => {
    if (!foamTextures || patch.foamLayer === undefined) return;
    const uv = grid.div(patch.size);
    const layer = int(patch.foamLayer);
    const kept = mix((texture(foamTextures[0], uv).depth(layer) as Node).x, (texture(foamTextures[1], uv).depth(layer) as Node).x, fields.foamPhase);
    // gusty stretches break more, calm ones less
    const gusting = fields.gusts(index) ? kept.mul(gust.mul(gust)) : kept;
    foamSum = foamSum.add(gusting.sub(options.foamSubtract?.[index] ?? 0));
  });
  // on a wave's peak, foam piles up: as much again as there is, several times over; down its
  // face it thins out fast and is gone a little below halfway down from the crest. How near the
  // peak, as a fraction of half the significant wave height, about a typical crest's
  const height = varying(seaHeight, 'seaHeight') as Node;
  const nearPeak = height.div(max(fields.waveHeight.mul(0.5), float(0.01)));
  const foamPeakBoost = uniform(options.foamPeakBoost ?? 2.8);
  const foamLowest = uniform(options.foamLowest ?? -0.15);
  const onPeak = smoothstep(float(0.2), float(0.9), nearPeak);
  const downTheWave = smoothstep(foamLowest, foamLowest.add(0.3), nearPeak);
  // a little contrast too: the patches' foam is no finer than their texels, and summed as it is
  // it would be all soft edges
  const foam = smoothstep(float(0.1), float(0.8), foamSum.mul(foamAmount).mul(onPeak.mul(foamPeakBoost).add(1))).mul(downTheWave);
  const deepColor = uniform(options.color ?? new Color(0x1f6582));
  const scatterColor = uniform(options.scatterColor ?? new Color(0x33b3aa));
  const scatter = uniform(options.scatter ?? 1);
  const foamColor = vec3(0.92, 0.95, 0.97);
  const sunDirection = uniform(options.sunDirection?.clone().normalize() ?? new Vector3(0, 1, 0));
  const sunColor = uniform(options.sunColor ?? new Color(1, 0.95, 0.85).multiplyScalar(150));
  const sunLight = uniform(options.sunLight ?? new Color(1, 0.95, 0.85).multiplyScalar(2.5));

  if (material instanceof MeshPhysicalNodeMaterial) {
    material.normalNode = transformNormalToView(normal);
    material.colorNode = mix(mix(deepColor, scatterColor, crestOf(height).mul(scatter).mul(0.5)), foamColor, foam);
    // a pixel over many waves is as rough as their slopes vary
    material.roughnessNode = max(roughness, float(0.04)).add(foam.mul(0.6));
    material.metalness = 0;
    material.ior = 1.333;
  } else {
    const environment = options.environment!;
    const toEye = normalize(cameraPosition.sub(positionWorld));
    const facing = max(dot(normal, toEye), float(0));
    // Schlick's Fresnel for water, F₀ = 0.02
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(facing), 5)));
    // the sea reflects no sea: a reflection bent below the horizon by a steep wave shows the sky above it instead
    const bounced = reflect(toEye.negate(), normal);
    const reflected = vec3(bounced.x, abs(bounced.y), bounced.z);
    // a pixel over many waves reflects the sky blurred by how much their slopes vary, not one sharp mirror's worth that flickers as they move
    // and foam is rough: it blurs what it reflects
    const sky = pmremTexture(environment, reflected, max(roughness.add(foam.mul(0.5)), float(0.02))) as Node;
    // the water looked into, lit by the whole sky, and the sun's light it scatters back, as
    // Acerola's sea does (github.com/GarrettGunnell/Water): through the crests, the more so looking
    // toward the sun through them, on the faces turned from it; off every face turned toward the
    // eye; off every face the sun lights; and off the bubbles in the water
    const skyLight = pmremTexture(environment, vec3(0, 1, 0), float(1)) as Node;
    const crest = crestOf(height);
    const towardSun = max(dot(sunDirection, toEye.negate()), float(0));
    const turnedFromSun = float(0.5).sub(dot(sunDirection, normal).mul(0.5));
    const throughCrests = crest.mul(pow(towardSun, 4)).mul(pow(turnedFromSun, 3)).mul(SCATTER.peaks);
    const faces = pow(facing, 2).mul(SCATTER.faces);
    const sunlit = max(dot(normal, sunDirection), float(0)).mul(SCATTER.sunlit);
    const scattered = (scatterColor as Node)
      .mul(sunLight)
      .mul(throughCrests.add(faces).add(sunlit))
      .add((scatterColor as Node).mul(sunLight).mul(SCATTER.bubbles))
      .mul(scatter);
    // and under thick foam, the water paled by the bubbles in it
    const body = deepColor.mul(skyLight).add(scattered).add(scatterColor.mul(skyLight).mul(foam.mul(0.35)));
    // the sun's glint, spread as the slopes under the pixel spread its reflection (twice their
    // angle), and dimmed as much as it spreads, so that it neither sparkles nor flickers far off
    const spread = slopeVariance.mul(2).add(GLINT_SPREAD).add(foam.mul(0.05));
    const glint = sunColor
      .mul(exp(float(1).sub(dot(reflected, sunDirection)).negate().div(spread)))
      .mul(float(GLINT_SPREAD).div(spread))
      // as much of it as the water reflects
      .mul(fresnel);
    // foam lit by the sky and, where it faces the sun, by the sun, much less bright than its glint
    const foamLight = skyLight.mul(1.1).add(sunLight.mul(0.25).mul(max(dot(normal, sunDirection), float(0))));
    const water = mix(body, sky, fresnel).add(glint.mul(float(1).sub(foam)));
    material.colorNode = mix(water, foamColor.mul(foamLight), foam);
  }
  material.userData.uniforms = {
    color: deepColor,
    scatterColor,
    scatter,
    sunDirection,
    sunColor,
    sunLight,
    foamAmount,
    foamPeakBoost,
    foamLowest,
    foamBias: fields.foamSettings.bias,
    foamPeakLift: fields.foamSettings.peakLift,
    foamGrowth: fields.foamSettings.growth,
    foamDecay: fields.foamSettings.decay,
  } satisfies SpectralWaterUniforms;
  return material;
}
