import { DataTexture, FloatType, Vector4, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, NearestFilter, NodeMaterial, QuadMesh, RenderTarget, RepeatWrapping, RGBAFormat } from 'three/webgpu';
import type { Renderer, Texture } from 'three/webgpu';
import { bitAnd, clamp, cos, exp, float, floor, fract, int, ivec2, max, mrt, screenCoordinate, sin, smoothstep, sqrt, textureLoad, uniform, vec2, vec4 } from 'three/tsl';
import type { SpectralWaves } from '../waves/SpectralWaves.js';
import { stageCount, transformStages } from '../waves/fft.js';
import { slotOf } from '../waves/spectralFields.js';

// TSL's node types, loosely: the shader graph is checked when it's built, not by TypeScript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface GpuWaveFieldsOptions {
  /**
   * What the transform works in: 'single' precision floats, off from the physics' waves by a few
   * hundred-thousandths of their size, or 'half', which halves the memory each pass reads and
   * writes (about a third less time on the GPU) but is off by up to a few percent: noise in the
   * slopes of the shortest waves, blotchy close up. Defaults to 'single'.
   */
  precision?: 'single' | 'half' | undefined;
  /**
   * Foam grows where a patch's surface bunches up past this, a Jacobian of its sideways motion,
   * as fast as it is bunched past it: only the steepest crests reach it. (Acerola's foam bias, for
   * a sea less choppy than his.) Defaults to 0.68.
   */
  foamBias?: number | undefined;
  /** How fast foam grows, a second, for each unit the surface is bunched up past the bias. Defaults to 15. */
  foamGrowth?: number | undefined;
  /** How fast foam fades, a second: it falls to a third in a second over this. Defaults to 1.8. */
  foamDecay?: number | undefined;
  /**
   * How much sooner foam forms on a crest: the bias lifted by this much where a patch's surface
   * stands highest. Crests are where the surface bunches up, so this foams the peaks and leaves
   * the faces and troughs clear. Defaults to 0: the default sea's crests foam enough as they are.
   */
  foamPeakLift?: number | undefined;
  /** Patches smaller than this, in metres, make no foam: waves so short bunch the surface up a little everywhere, a faint foam all over. Defaults to 5. */
  foamSmallestPatch?: number | undefined;
}

/**
 * The textures every patch's waves are drawn from: texture arrays, layer i of each holding patch
 * i (as `GpuWaveFields.patches` numbers them), each layer repeating every patch size. Arrays, so
 * that a material samples a handful of textures however many patches the sea has: WebGPU allows
 * only 16 to a shader stage unless asked for more.
 */
export interface WaveFieldTextures {
  /** Sideways x, height, sideways z, and the Jacobian of the sideways motion (below 0 where the surface folds over, for foam). */
  readonly displacement: Texture;
  /** ∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z. */
  readonly derivatives: Texture;
  /**
   * The slopes squared, ∂h/∂x² and ∂h/∂z²: mipmapped, their mean over a pixel's footprint less
   * the mean slope's square is how much the slopes vary within it, which a mipmapped slope alone
   * loses (LEAN mapping, Olano and Baker 2010).
   */
  readonly slopeMoments: Texture;
  /**
   * The foam the patches make, kept from frame to frame, in the red channel: two arrays, written
   * in turn, the newer chosen by `GpuWaveFields.foamPhase` (1 for the second), each patch that
   * makes foam at its own `foamLayer`; none if no patch makes foam.
   */
  readonly foam: readonly [Texture, Texture] | undefined;
}

/** One patch of the sea as the fields hold it: layer i of the field textures is patch i. */
export interface FieldPatch {
  readonly size: number;
  /** Its layer of the foam textures; undefined if the patch makes no foam. */
  readonly foamLayer: number | undefined;
}

/**
 * The full sea of a SpectralWaves, every wave of every patch, evaluated on the GPU each frame
 * with the same inverse FFT the physics does on the CPU (`waves/fft.ts`): one render pass to turn
 * the spectra on to the frame's time, one per stage of the transform's rows and of its columns,
 * and one per patch to unpack the result into textures the water's material samples.
 *
 * The patches lie side by side in one atlas, so each pass does them all, and each texel carries
 * four complex fields in two render targets: the eight real fields height, sideways x and z,
 * the height's slopes and the sideways motion's gradients, two to a complex field.
 *
 * Render passes rather than compute shaders, so the same code runs on WebGPU and on
 * WebGPURenderer's WebGL 2 fallback, which has neither workgroup memory nor storage textures.
 */
export class GpuWaveFields {
  readonly waves: SpectralWaves;
  readonly resolution: number;
  readonly patches: readonly FieldPatch[];
  readonly textures: WaveFieldTextures;
  /** Render passes a frame: for the comparisons in the ocean example. */
  readonly passCount: number;
  /** Which of each patch's two foam textures is the newer: 0 or 1. */
  readonly foamPhase = uniform(0);
  /** The sea's significant wave height, Hs, in metres: for gauging how near a crest the surface stands. */
  readonly waveHeight = uniform(0);
  /**
   * The swell's long waves, which no patch holds, each (kx, kz, amplitude, phase): its wavenumber
   * along its way, how high it is, and its phase this frame, worked out on the CPU in double
   * precision. Summed where they are, as SpectralWaves sums them for the physics.
   */
  readonly swell: { value: Vector4 }[];
  /** The waves' choppiness, as the transform has it: for the swell's sideways motion too. */
  readonly choppinessNode: Node;
  private readonly swellPhases: Float64Array;
  /** How much the gusting patches' waves are scaled from place to place: as `SpectralWaves.gustAt`. */
  readonly gustiness = uniform(0);
  /** Settings of the foam that can change as it runs: set their `value`. */
  readonly foamSettings: { bias: { value: number }; growth: { value: number }; decay: { value: number }; peakLift: { value: number } };
  /** Each patch's own significant wave height, for gauging where its crests are. */
  private readonly patchWaveHeights: { value: number }[];

  /**
   * The time, as fractions of a turn: each wave turns by 2π (fract(r · coarseTime) + r · fineTime),
   * r its frequency in turns a loop period (see `loopPeriod`), the loop's fraction gone split so
   * that r · coarseTime is exact in single precision, and r · fineTime is small.
   */
  private readonly coarseTime = uniform(0);
  private readonly fineTime = uniform(0);
  /** Steps of coarseTime, a power of two, as fine as keeps r · coarseTime exact for the fastest wave. */
  private readonly coarseStep: number;
  private readonly spectrumPass: QuadMesh;
  private readonly transformPasses: QuadMesh[] = [];
  private readonly unpackPasses: QuadMesh[] = [];
  /** The foam targets, written in turn, a layer for each patch that makes foam; and for each such patch, the pass writing each from the other. */
  private readonly foamTargets: [RenderTarget, RenderTarget] | undefined;
  private readonly foamPasses: ([QuadMesh, QuadMesh] | undefined)[];
  /** How many patches make foam: the foam targets' layers in use. */
  private readonly foamLayerCount: number;
  /** Whether the targets have been made on the GPU, with room for their mipmaps. */
  private targetsReady = false;
  private readonly foamStep = uniform(0);
  private lastTime = Number.NaN;
  /** The atlas the transform ping-pongs between: the spectrum is written to the first, and the transform ends there too. */
  private readonly atlases: [RenderTarget, RenderTarget];
  /** The fields' targets: displacement, derivatives and slope moments, a layer a patch. */
  private readonly fieldTarget: RenderTarget;
  private readonly inputs: DataTexture[];
  private readonly choppiness = uniform(0);
  /** The waves' version the amplitudes were last packed for. */
  private packedVersion: number;

  constructor(waves: SpectralWaves, options: GpuWaveFieldsOptions = {}) {
    this.waves = waves;
    const resolution = waves.patches[0]!.resolution;
    this.resolution = resolution;
    stageCount(resolution);
    const patchCount = waves.patches.length;
    const width = patchCount * resolution;

    const atlasTarget = () => {
      const target = new RenderTarget(width, resolution, {
        count: 2,
        type: options.precision === 'half' ? HalfFloatType : FloatType,
        format: RGBAFormat,
        depthBuffer: false,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        generateMipmaps: false,
      });
      target.textures[0]!.name = 'first';
      target.textures[1]!.name = 'second';
      return target;
    };
    this.atlases = [atlasTarget(), atlasTarget()];

    // r · coarseTime has as many bits as r and coarseStep's together: no more than single precision's 24
    const fastestTurns = Math.max(...waves.patches.map((patch) => patch.angularFrequencies.reduce((fastest, frequency) => Math.max(fastest, this.turnsOf(frequency)), 0)));
    this.coarseStep = 2 ** -(24 - Math.ceil(Math.log2(fastestTurns + 1)));
    const { amplitudes, waveNumbers } = this.packInputs(width);
    this.inputs = [amplitudes, waveNumbers];
    this.choppiness.value = waves.choppiness;
    this.choppinessNode = this.choppiness;
    this.swell = waves.swell.map(() => uniform(new Vector4()));
    this.swellPhases = new Float64Array(waves.swell.length);
    this.gustiness.value = waves.sea.gustiness;
    this.packedVersion = waves.version;
    this.waveHeight.value = waves.significantWaveHeight;
    this.spectrumPass = new QuadMesh(this.spectrumMaterial(amplitudes, waveNumbers));

    for (const direction of ['rows', 'columns'] as const) {
      for (const { radix, merged } of transformStages(resolution)) {
        const source = this.atlases[this.transformPasses.length % 2]!;
        this.transformPasses.push(new QuadMesh(transformMaterial(source, direction, radix, merged, resolution)));
      }
    }

    // texture arrays, a layer a patch; never fewer than two layers, which three draws into as
    // an array where one it would take for a plain texture
    const layeredTarget = (layers: number, count: number) => {
      const target = new RenderTarget(resolution, resolution, {
        depth: Math.max(layers, 2),
        count,
        type: HalfFloatType,
        format: RGBAFormat,
        depthBuffer: false,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: true,
      });
      for (const texture of target.textures) {
        texture.wrapS = texture.wrapT = RepeatWrapping;
        texture.anisotropy = 4;
      }
      return target;
    };
    this.fieldTarget = layeredTarget(patchCount, 3);
    this.fieldTarget.textures[0]!.name = 'displacement';
    this.fieldTarget.textures[1]!.name = 'derivatives';
    this.fieldTarget.textures[2]!.name = 'slopeMoments';
    waves.patches.forEach((_patch, index) => this.unpackPasses.push(new QuadMesh(unpackMaterial(this.atlases[0], index, resolution))));
    const bias = uniform(options.foamBias ?? 0.68);
    const growth = uniform(options.foamGrowth ?? 15);
    const decay = uniform(options.foamDecay ?? 1.8);
    const peakLift = uniform(options.foamPeakLift ?? 0);
    this.foamSettings = { bias, growth, decay, peakLift };
    this.patchWaveHeights = waves.patches.map(() => uniform(0));
    this.measurePatchWaveHeights();
    const smallestFoamPatch = options.foamSmallestPatch ?? 5;
    let foamLayers = 0;
    this.patches = waves.patches.map((patch) => ({ size: patch.size, foamLayer: patch.size < smallestFoamPatch ? undefined : foamLayers++ }));
    this.foamLayerCount = foamLayers;
    this.foamTargets = foamLayers > 0 ? [layeredTarget(foamLayers, 1), layeredTarget(foamLayers, 1)] : undefined;
    const displacement = this.fieldTarget.textures[0]!;
    this.foamPasses = this.patches.map((patch, index) => {
      const targets = this.foamTargets;
      if (patch.foamLayer === undefined || !targets) return undefined;
      // the pass into the first reads the second, and the other way about
      const waveHeight = this.patchWaveHeights[index]!;
      return [
        new QuadMesh(foamMaterial(displacement, index, targets[1].texture, patch.foamLayer, this.foamSettings, waveHeight, this.foamStep)),
        new QuadMesh(foamMaterial(displacement, index, targets[0].texture, patch.foamLayer, this.foamSettings, waveHeight, this.foamStep)),
      ];
    });
    this.textures = {
      displacement,
      derivatives: this.fieldTarget.textures[1]!,
      slopeMoments: this.fieldTarget.textures[2]!,
      foam: this.foamTargets ? [this.foamTargets[0].texture, this.foamTargets[1].texture] : undefined,
    };
    this.passCount = 1 + this.transformPasses.length + this.unpackPasses.length + this.foamPasses.filter(Boolean).length;
  }

  /** How much the gusting patches' waves are scaled by at the undisplaced grid position `grid` (vec2), as `SpectralWaves.gustAt` works it out. */
  gustAt(grid: Node): Node {
    let pattern: Node = float(0);
    for (const gust of this.waves.gusts) pattern = pattern.add(sin(grid.x.mul(gust.waveNumberX).add(grid.y.mul(gust.waveNumberZ)).add(gust.phase)));
    return max(float(1).add(this.gustiness.mul(pattern).div(Math.sqrt(this.waves.gusts.length / 2))), float(0.05));
  }

  /** Whether a patch's waves gust. */
  gusts(patchIndex: number): boolean {
    return this.waves.patches[patchIndex]!.size <= this.waves.gustPatches;
  }

  /** Evaluates the sea at `time`, the same time the physics is given, into `patches`' textures. */
  update(renderer: Renderer, time: number): void {
    const phaseTime = this.waves.phaseTime(time);
    if (Number.isFinite(this.waves.loopPeriod)) {
      const loopFraction = phaseTime / this.waves.loopPeriod;
      this.coarseTime.value = Math.floor(loopFraction / this.coarseStep) * this.coarseStep;
      this.fineTime.value = loopFraction - this.coarseTime.value;
    } else {
      // no loop: frequencies are in radians a second, and all the time is fine time
      this.coarseTime.value = 0;
      this.fineTime.value = phaseTime / (2 * Math.PI);
    }
    if (this.waves.version !== this.packedVersion) {
      // the sea was changed: its waves' new heights, and choppiness
      this.packAmplitudes(this.inputs[0]!.image.data as Float32Array, this.inputs[0]!.image.width);
      this.inputs[0]!.needsUpdate = true;
      this.choppiness.value = this.waves.choppiness;
      this.gustiness.value = this.waves.sea.gustiness;
      this.packedVersion = this.waves.version;
      this.waveHeight.value = this.waves.significantWaveHeight;
      this.measurePatchWaveHeights();
    }
    this.waves.swellPhasesAt(time, this.swellPhases);
    this.waves.swell.forEach((wave, index) => {
      this.swell[index]!.value.set(wave.directionX * wave.waveNumber, wave.directionZ * wave.waveNumber, wave.amplitude, this.swellPhases[index]!);
    });
    if (!this.targetsReady) {
      // made now, while their textures still ask for mipmaps, so that they have room for them
      for (const target of [this.fieldTarget, ...(this.foamTargets ?? [])]) renderer.initRenderTarget(target);
      this.targetsReady = true;
    }
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.atlases[0]);
    this.spectrumPass.render(renderer);
    this.transformPasses.forEach((pass, index) => {
      renderer.setRenderTarget(this.atlases[(index + 1) % 2]!);
      pass.render(renderer);
    });
    // three remakes every layer's mipmaps after each pass into a layer: only after the last, then
    this.unpackPasses.forEach((pass, index) => {
      makeMipmapsAfter(this.fieldTarget, index === this.unpackPasses.length - 1);
      renderer.setRenderTarget(this.fieldTarget, index);
      pass.render(renderer);
    });
    // the foam carried on from the last frame into the other texture, as long after it as the time
    // gone; none at all at the first, or after a pause long enough for all foam to be gone
    const step = time - this.lastTime;
    this.foamStep.value = Number.isFinite(step) ? Math.min(Math.max(step, 0), 0.1) : 0;
    this.lastTime = time;
    const next = this.foamPhase.value === 0 ? 1 : 0;
    this.foamPasses.forEach((passes, index) => {
      const foamLayer = this.patches[index]!.foamLayer;
      if (!passes || !this.foamTargets || foamLayer === undefined) return;
      const target = this.foamTargets[next];
      makeMipmapsAfter(target, foamLayer === this.foamLayerCount - 1);
      renderer.setRenderTarget(target, foamLayer);
      passes[next].render(renderer);
    });
    this.foamPhase.value = next;
    renderer.setRenderTarget(previousTarget);
  }

  /** The transform's result for every patch before unpacking, as `evaluateFields` lays it out on the CPU: for checking one against the other. */
  get atlas(): RenderTarget {
    return this.atlases[0];
  }

  dispose(): void {
    for (const target of [...this.atlases, this.fieldTarget, ...(this.foamTargets ?? [])]) target.dispose();
    for (const passes of this.foamPasses) for (const pass of passes ?? []) (pass.material as NodeMaterial).dispose();
    for (const texture of this.inputs) texture.dispose();
    for (const pass of [this.spectrumPass, ...this.transformPasses, ...this.unpackPasses]) (pass.material as NodeMaterial).dispose();
  }

  /** Each patch's significant wave height, four times its waves' standard deviation, as the whole sea's is. */
  private measurePatchWaveHeights(): void {
    this.waves.patches.forEach((patch, index) => {
      let variance = 0;
      for (const amplitude of patch.amplitudes) variance += amplitude * amplitude;
      this.patchWaveHeights[index]!.value = 4 * Math.sqrt(variance);
    });
  }

  /** A wave's frequency in whole turns a loop period, or with no loop, in radians a second. */
  private turnsOf(angularFrequency: number): number {
    const loopPeriod = this.waves.loopPeriod;
    return Number.isFinite(loopPeriod) ? Math.round((angularFrequency * loopPeriod) / (2 * Math.PI)) : angularFrequency;
  }

  /** The patches' h₀ side by side, in texel order, into `data`, the atlas `width` texels across. */
  private packAmplitudes(data: Float32Array, width: number): void {
    const resolution = this.resolution;
    this.waves.patches.forEach((patch, index) => {
      for (let row = 0; row < resolution; row++) {
        // a row of a patch is a row of the atlas
        data.set(patch.amplitudes.subarray(4 * row * resolution, 4 * (row + 1) * resolution), 4 * (row * width + index * resolution));
      }
    });
  }

  /** The patches' h₀ and wavenumbers (kx, kz, and the frequency as `turnsOf` gives it), side by side, in texel order. */
  private packInputs(width: number): {
    amplitudes: DataTexture;
    waveNumbers: DataTexture;
  } {
    const resolution = this.resolution;
    const amplitudeData = new Float32Array(4 * width * resolution);
    const waveNumberData = new Float32Array(4 * width * resolution);
    this.packAmplitudes(amplitudeData, width);
    this.waves.patches.forEach((patch, index) => {
      const step = (2 * Math.PI) / patch.size;
      for (let row = -resolution / 2; row < resolution / 2; row++) {
        for (let column = -resolution / 2; column < resolution / 2; column++) {
          const slot = slotOf(row, resolution) * resolution + slotOf(column, resolution);
          const texel = slotOf(row, resolution) * width + index * resolution + slotOf(column, resolution);
          waveNumberData.set([column * step, row * step, this.turnsOf(patch.angularFrequencies[slot]!), 0], 4 * texel);
        }
      }
    });
    const texture = (data: Float32Array) => {
      const result = new DataTexture(data, width, resolution, RGBAFormat, FloatType);
      result.minFilter = result.magFilter = NearestFilter;
      result.needsUpdate = true;
      return result;
    };
    return {
      amplitudes: texture(amplitudeData),
      waveNumbers: texture(waveNumberData),
    };
  }

  /**
   * h(k, t) = h₀(k) e^(-iωt) + h₀*(-k) e^(iωt), as `fillSpectrum` makes it, and from it the other
   * seven fields' spectra: sideways motion i (k̂ λ) h, slopes i k h, and the motion's gradients
   * i k (i k̂ λ h); packed as h + i Dx and Dz + i hx in the first target, hz + i Dxx and
   * Dzz + i Dxz in the second.
   */
  private spectrumMaterial(amplitudes: DataTexture, waveNumbers: DataTexture): NodeMaterial {
    const choppiness = this.choppiness;
    const coarseTime = this.coarseTime;
    const fineTime = this.fineTime;
    const material = new NodeMaterial();
    const texel = fragmentTexel();
    const initial = textureLoad(amplitudes, texel) as Node;
    const wave = textureLoad(waveNumbers, texel) as Node;
    const turn = fract(wave.z.mul(coarseTime)).add(wave.z.mul(fineTime)).mul(2 * Math.PI);
    const cosine = cos(turn);
    const sine = sin(turn);
    const real = initial.x.mul(cosine).add(initial.y.mul(sine)).add(initial.z.mul(cosine)).sub(initial.w.mul(sine));
    const imaginary = initial.x.negate().mul(sine).add(initial.y.mul(cosine)).add(initial.z.mul(sine)).add(initial.w.mul(cosine));
    const heightSpectrum = vec2(real, imaginary);
    const waveNumber = max(sqrt(wave.x.mul(wave.x).add(wave.y.mul(wave.y))), float(1e-9));
    const towardX = wave.x.div(waveNumber).mul(choppiness);
    const towardZ = wave.y.div(waveNumber).mul(choppiness);
    const sidewaysX = timesI(heightSpectrum).mul(towardX);
    const sidewaysZ = timesI(heightSpectrum).mul(towardZ);
    const slopeX = timesI(heightSpectrum).mul(wave.x);
    const slopeZ = timesI(heightSpectrum).mul(wave.y);
    const sidewaysXAlongX = timesI(sidewaysX).mul(wave.x);
    const sidewaysZAlongZ = timesI(sidewaysZ).mul(wave.y);
    const sidewaysXAlongZ = timesI(sidewaysX).mul(wave.y);
    const first = vec4(pack(heightSpectrum, sidewaysX), pack(sidewaysZ, slopeX));
    const second = vec4(pack(slopeZ, sidewaysXAlongX), pack(sidewaysZAlongZ, sidewaysXAlongZ));
    material.mrtNode = mrt({ first, second });
    material.outputNode = first;
    return material;
  }
}

/**
 * The texel a full-screen pass is drawing, as textureLoad numbers them. three keeps to WebGPU's
 * rows from the top on both backends, flipping render targets' rows on WebGL as it reads them, so
 * a pass reads back the very texel it wrote at screenCoordinate.
 */
function fragmentTexel(): Node {
  return ivec2(floor(screenCoordinate));
}

/** i z, for z = (real, imaginary). */
function timesI(value: Node): Node {
  return vec2(value.y.negate(), value.x);
}

/** The spectrum of a + i b, from the spectra of the real fields a and b. */
function pack(first: Node, second: Node): Node {
  return vec2(first.x.sub(second.y), first.y.add(second.x));
}

/**
 * One stage of the inverse transform along the atlas's rows or its columns, of both targets'
 * two complex fields at once, as `stage` and `stage4` in `waves/fft.ts` do it on the CPU. Each
 * output works out its own value: output p of butterfly (block, k) is Σ_q x_q e^(2πi q (k + p m) / R m),
 * x_q the inputs j + q N/R, with j = block m + k, which is the twiddle and the R-point transform
 * at once.
 */
function transformMaterial(source: RenderTarget, direction: 'rows' | 'columns', radix: 2 | 4, merged: number, resolution: number): NodeMaterial {
  const material = new NodeMaterial();
  const texel = fragmentTexel();
  const along = direction === 'rows' ? texel.x : texel.y;
  const across = direction === 'rows' ? texel.y : texel.x;
  // the patch's own index along the transform, and where its patch starts in the atlas
  const local = bitAnd(along, int(resolution - 1));
  const start = along.sub(local);
  const within = bitAnd(local, int(radix * merged - 1));
  const position = bitAnd(within, int(merged - 1));
  const block = local.sub(within).div(int(radix * merged));
  const firstIndex = start.add(block.mul(int(merged)).add(position));
  const texelAt = (index: Node) => (direction === 'rows' ? ivec2(index, across) : ivec2(across, index));
  const inputTexels = Array.from({ length: radix }, (_unused, input) => texelAt(firstIndex.add(int((input * resolution) / radix))));
  // e^(2πi q within / R m), for each input q but the first
  const angle = float(within).mul((2 * Math.PI) / (radix * merged));
  const turn = vec2(cos(angle), sin(angle));
  const turns = [vec2(1, 0), turn];
  if (radix === 4) {
    turns.push(complexMultiply(turn, turn));
    turns.push(complexMultiply(turns[2], turn));
  }
  const transform = (texture: Texture) => {
    let firstSum: Node = vec2(0);
    let secondSum: Node = vec2(0);
    inputTexels.forEach((inputTexel, input) => {
      const value = textureLoad(texture, inputTexel) as Node;
      firstSum = firstSum.add(input === 0 ? value.xy : complexMultiply(turns[input], value.xy));
      secondSum = secondSum.add(input === 0 ? value.zw : complexMultiply(turns[input], value.zw));
    });
    return vec4(firstSum, secondSum);
  };
  const first = transform(source.textures[0]!);
  const second = transform(source.textures[1]!);
  material.mrtNode = mrt({ first, second });
  material.outputNode = first;
  return material;
}

/** Whether three should remake `target`'s mipmaps after the next pass into it. */
function makeMipmapsAfter(target: RenderTarget, after: boolean): void {
  for (const texture of target.textures) texture.generateMipmaps = after;
}

function complexMultiply(first: Node, second: Node): Node {
  return vec2(first.x.mul(second.x).sub(first.y.mul(second.y)), first.x.mul(second.y).add(first.y.mul(second.x)));
}

/**
 * One patch's fields out of the atlas into its layer of the field textures: displacement (Dx, h,
 * Dz, Jacobian), derivatives (hx, hz, Dxx, Dzz) and the slopes' squares. The Jacobian (1 + Dxx)(1 + Dzz) - Dxz² of the sideways
 * motion falls below 1 where the surface bunches up at the crests, and below 0 where it folds.
 */
function unpackMaterial(atlas: RenderTarget, patchIndex: number, resolution: number): NodeMaterial {
  const material = new NodeMaterial();
  const texel = fragmentTexel();
  const atlasTexel = ivec2(texel.x.add(int(patchIndex * resolution)), texel.y);
  const first = textureLoad(atlas.textures[0]!, atlasTexel) as Node;
  const second = textureLoad(atlas.textures[1]!, atlasTexel) as Node;
  const jacobian = float(1).add(second.y).mul(float(1).add(second.z)).sub(second.w.mul(second.w));
  const displacement = vec4(first.y, first.x, first.z, jacobian);
  const derivatives = vec4(first.w, second.x, second.y, second.z);
  const slopeMoments = vec4(first.w.mul(first.w), second.x.mul(second.x), 0, 0);
  material.mrtNode = mrt({ displacement, derivatives, slopeMoments });
  material.outputNode = displacement;
  return material;
}

/**
 * A patch's foam, carried on a step, as Acerola's sea makes it (github.com/GarrettGunnell/Water):
 * the foam there before, fading, and more of it where the surface bunches up past the bias, as
 * much more as it bunches up past it; so foam builds on a breaking crest, lingers behind it and
 * fades. It is kept where the water was before the waves moved it, so it rides along with the
 * water, and the shortest waves' foam is its fine detail.
 */
function foamMaterial(
  displacement: Texture,
  patchIndex: number,
  previous: Texture,
  foamLayer: number,
  settings: { bias: Node; growth: Node; decay: Node; peakLift: Node },
  waveHeight: Node,
  step: Node,
): NodeMaterial {
  const material = new NodeMaterial();
  const texel = fragmentTexel();
  const moved = (textureLoad(displacement, texel) as Node).depth(int(patchIndex));
  const jacobian = moved.w;
  // on the patch's own crests, foam forms sooner: its bias lifted, as high as the crest stands over half its waves' height
  const nearPeak = moved.y.div(max(waveHeight.mul(0.5), float(0.001)));
  const bias = settings.bias.add(settings.peakLift.mul(smoothstep(float(0.3), float(1), nearPeak)));
  const kept = clamp((textureLoad(previous, texel) as Node).depth(int(foamLayer)).x, 0, 1).mul(exp(settings.decay.negate().mul(step)));
  const added = max(bias.sub(jacobian), float(0)).mul(settings.growth).mul(step);
  material.outputNode = vec4((kept as Node).add(added), 0, 0, 1);
  return material;
}
