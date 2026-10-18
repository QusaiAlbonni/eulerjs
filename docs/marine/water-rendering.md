# Drawing the water

The water you see should be the water the bodies float on, wave for wave, or a crate seems to
hover over a trough or sink into a crest. `@eulerjs/marine` has a renderer for each sea that
draws exactly the waves the physics uses:

| Sea | Renderer | three.js renderer | Import from |
| --- | --- | --- | --- |
| `SpectralWaves` | `SpectralWater` | `WebGPURenderer` (WebGPU, or its WebGL 2 fallback) | `@eulerjs/marine/webgpu` |
| `SumOfSines` | `WaterMesh` | `WebGLRenderer` | `@eulerjs/marine` |

## SpectralWater

`SpectralWater` draws a `SpectralWaves` sea to the horizon: every wave of every patch, not just
the physics' longest ones, evaluated on the GPU each frame by the same inverse FFT the physics
runs on the CPU, and matching it to a few hundred-thousandths of the waves' size.

```ts
import { WebGPURenderer } from 'three/webgpu';
import { Ocean, SpectralWaves } from '@eulerjs/marine';
import { seaFog, SpectralWater } from '@eulerjs/marine/webgpu';

const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();

const waves = new SpectralWaves();
const ocean = new Ocean({ waves });
const water = new SpectralWater(waves, { environment: scene.environment!, sunDirection });
scene.add(water);
scene.fogNode = seaFog(scene.environment!, { sunDirection });

renderer.setAnimationLoop((timestamp) => {
  // ...step the world...
  water.update(renderer, world.renderTime, camera.position, camera);
  renderer.render(scene, camera);
});
```

`SpectralWater` is a three.js `Group` holding two things you can reach:

- `water.fields`, a `GpuWaveFields`: the waves evaluated into textures, a set for each patch.
- `water.lod`, a `QuadtreeLod` or a `RingLod`: the triangles laid out around the viewer, and their
  material, which moves each vertex by the waves and shades each pixel.

### update

```ts
water.update(renderer, time, centre, camera);
```

Call it once a frame, before rendering.

- `renderer` must be a `WebGPURenderer` from `three/webgpu`; anything else throws.
- `time` is the simulation time to draw the sea at. Use `world.renderTime`, the moment the bodies
  are drawn at between fixed steps, so the waves and the bodies on them agree.
- `centre` is where the sea should be finest, usually `camera.position`. The surface's vertices
  are laid out around it, closer together near it.
- `camera` is optional. Given it, the quadtree leaves out the nodes it can't see.

`update` does both halves, the waves and the layout. The ocean example calls them apart to time
each: `water.fields.update(renderer, time)`, then `water.lod.update(centre, camera)` (a
`RingLod`'s `update` takes the centre alone).

Call `water.dispose()` when you are done with it, to free its render targets, materials and
geometry.

### Two levels of detail

The sea reaches 262 km around the centre, finest there and coarser with distance, in one of two
layouts. Both meet between levels without cracks (`test/waterLod.test.ts` checks every edge), and
both sample the waves at the mipmap level of their vertex spacing, so that waves too short for
the mesh fade out of it instead of shimmering.

- **`lod: 'quadtree'`** (the default): Strugar's CDLOD. Square nodes from 1 m to 262 km across
  split into four while the centre is near enough, so nodes grow with distance in all three
  dimensions, and the sea gets coarser as you rise above it too. Every node is the same small
  grid, drawn in **one instanced draw call**, and nodes out of the camera's view are left out.
  A node's vertices morph onto the grid twice as coarse as they near the distance where its
  parent stops splitting, so it meets a larger neighbour exactly.
- **`lod: 'rings'`**: a geometry clipmap (Losasso and Hoppe). Square rings around the centre, each
  with twice the spacing of the one inside it, snapped to their own grids so vertices stay put
  on the sea as you move. The **same triangles every frame**, next to no time to lay out, but
  **about three draw calls a level**.

What they cost, measured on an integrated GPU (Radeon Renoir, on the WebGL 2 fallback, at 1920 ×
760), for a whole frame of `examples/ocean` (the sky and the FFT's 2 ms included; the CPU's time
is laying the sea out and drawing it):

| From | rings, CPU / GPU | quadtree | quadtree, culled |
| --- | --- | --- | --- |
| 2 m | 1.44 / 5.6 ms | 0.83 / 5.4 ms | 0.79 / 5.3 ms |
| 30 m | 0.94 / 6.7 ms | 0.62 / 6.2 ms | 0.46 / 6.1 ms |
| 400 m | 0.86 / 7.0 ms | 0.48 / 6.5 ms | 0.40 / 6.4 ms |

On the GPU they cost the same: the water is bound by its pixels, and culling, which takes the
quadtree's triangles to a third, barely shows. On the CPU the quadtree's single draw call more
than pays for laying it out. Use the quadtree unless you have a reason not to.

Both report `drawCallCount`, `triangleCount` and `reach` (metres to their edge); the quadtree
also `nodeCount`. The ocean example shows them, and `?compare=1` measures both layouts from three
heights.

| Quadtree option | Default | What it does |
| --- | --- | --- |
| `finestSpacing` | `0.25` | Metres between vertices nearest the centre. |
| `cellsAcross` | `4` | Cells across each node, even. |
| `levelCount` | `19` | Sizes of node, each twice the one before: from 1 m to 262 km. |
| `rangeFactor` | `4` | A node splits when the centre comes within this many times its size. Below about 3.54 neighbours crack apart, so smaller values throw. |
| `waveBound` | follows the sea | How far the waves can move the surface, for culling: by default the significant wave height times one plus the choppiness, and a metre. |
| `capacity` | `4096` | Room for this many nodes. |

| Rings option | Default | What it does |
| --- | --- | --- |
| `finestSpacing` | `0.25` | Metres between vertices nearest the centre. |
| `cellsAcross` | `64` | Cells across each level, a multiple of 4. |
| `levelCount` | `16` | Levels, each twice the spacing and reach of the one inside: about 260 km. |
| `reachOverHeight` | `2` | The finest level drawn reaches at least this many times the centre's height, so from high up the finest levels are left out. |

### Precision

`precision: 'single'` (the default) runs the transform in single-precision floats, off from the
physics' waves by a few hundred-thousandths of their size. `precision: 'half'` halves the memory
each pass reads and writes, about a third less time on the GPU, but is off by up to a few
percent: noise in the slopes of the shortest waves, blotchy close up.

### Shading

Without an `environment`, the water is a `MeshPhysicalNodeMaterial` lit by the scene's lights and
environment like anything else, its roughness raised where a pixel covers many waves.

Given the sky as an `environment` (a texture from `PMREMGenerator`), it is shaded as water looks:

- a mirror of the sky by Fresnel's law: a fiftieth of it looking straight down, all of it at
  grazing angles, so the sea pales toward the horizon; blurred as much as the slopes under each
  pixel vary, so far-off water doesn't flicker;
- over the colour of the water looked into, lit by the sky;
- with the sun's light scattered back through the crests (most when looking toward the sun),
  off faces turned to the eye or to the sun, and off the bubbles in it, as Acerola's sea does
  ([github.com/GarrettGunnell/Water](https://github.com/GarrettGunnell/Water));
- and the sun glinting off it, spread and dimmed by the slopes under the pixel, so it neither
  sparkles nor flickers far off.

::: tip A sky for reflections
Give the water a sky **without the sun's disc** in it. The disc is thousands of times brighter
than the sky and would glare off every wave; the water draws its own glint from `sunDirection`
and `sunColor` instead. The examples render a second `SkyMesh` with `showSunDisc.value = 0` into
a scene of its own and make the environment from that.
:::

| Material option | Default | What it does |
| --- | --- | --- |
| `environment` | none | The sky, from `PMREMGenerator`, best without the sun's disc. |
| `color` | `0x1f6582`, a light sea blue | The colour of the water looked into, lit by the sky. |
| `scatterColor` | `0x33b3aa`, a turquoise | The colour of the light the water scatters back. |
| `scatter` | `1` | How much light the water scatters back; 0 for none. |
| `sunDirection` | straight up | Toward the sun, for its glint and its scattered light. |
| `sunColor` | warm white × 150 | The glint's colour and brightness: the sun is far brighter than the sky. |
| `sunLight` | warm white × 2.5 | The sun's light on the water, which it scatters back and lights the foam with. |

`sunDirection`, `sunColor` and `sunLight` matter only with an `environment`.

### Foam

Foam builds on breaking crests, lingers behind them and fades, as in Acerola's sea. Each patch of
5 m or more keeps its own foam texture from frame to frame:

- it **grows** where the patch's surface bunches up past `foamBias` (a Jacobian of its sideways
  motion; the surface folds over where it falls below 0), as fast as it is bunched past it, times
  `foamGrowth`;
- it forms **sooner on crests** by `foamPeakLift`, the bias lifted where the patch's surface stands
  highest;
- it **fades** at `foamDecay` a second: to a third in a second over that.

Drawn, the patches' foam is added up, and then it **piles up on the waves' peaks**, `foamPeakBoost`
times more there, and is **gone a little way down their faces**, below `foamLowest`. Gusty
stretches foam more, calm ones less.

| Foam option | Default | Belongs to | What it does |
| --- | --- | --- | --- |
| `foamBias` | `0.68` | the fields | Foam grows where the surface bunches up past this: only the steepest crests reach it. |
| `foamGrowth` | `15` | the fields | How fast foam grows, a second, for each unit past the bias. |
| `foamDecay` | `1.8` | the fields | How fast foam fades, a second. |
| `foamPeakLift` | `0` | the fields | How much sooner foam forms on a crest. The default sea's crests foam enough as they are. |
| `foamSmallestPatch` | `5` | the fields | Patches smaller than this, in metres, make no foam: their short waves bunch the surface up a little everywhere, a faint foam all over. |
| `foamAmount` | `1` | the material | How much of the kept foam is drawn; 0 for none. |
| `foamPeakBoost` | `2.8` | the material | How many times more foam there is on a wave's peak than its Jacobian alone makes. |
| `foamLowest` | `-0.15` | the material | How far down a wave foam reaches, as a height over half the significant wave height: 0 is still water's level, 0.5 halfway up a typical crest. |
| `foamSubtract` | none | the material | Taken off each patch's foam, from the largest, before they are added up, to clear the faint foam a patch leaves all over: an array, one number a patch. |

::: info Why a calm sea has little foam
Foam forms from each patch's own waves bunching the surface up, not from all the patches'
together, which bunch it up more where their crests meet. A fresh breeze's sea (10 m/s) makes
almost none, and foam is no finer than each patch's texels (20 cm on the 25 m patch at 128²).
Both are listed in the project's `TODO.md`.
:::

### Changing it while it runs

All the options go to the constructor, as one object:

```ts
import { Color } from 'three/webgpu';

const water = new SpectralWater(waves, {
  lod: 'quadtree',
  environment: scene.environment,
  sunDirection,
  color: new Color(0x1f6582),
  foamBias: 0.6,
  foamPeakBoost: 3,
});
```

Most can be changed afterwards through uniforms: set their `value`. The material's are in
`water.lod.material.userData.uniforms`, typed `SpectralWaterUniforms`; the foam's growth settings
are also in `water.fields.foamSettings`.

```ts
import type { SpectralWaterUniforms } from '@eulerjs/marine/webgpu';

const uniforms = water.lod.material.userData.uniforms as SpectralWaterUniforms;
renderer.setAnimationLoop(() => {
  // the sun's glint and light following a moving sun, as the sailboat's day and night do
  uniforms.sunDirection.value.copy(sky.lightDirection);
  uniforms.sunColor.value.copy(sky.light.color).multiplyScalar(60 * sky.light.intensity);
  uniforms.sunLight.value.copy(sky.light.color).multiplyScalar(1.25 * sky.light.intensity);
  // ...
});

water.fields.foamSettings.bias.value = 0.6;
water.fields.foamSettings.peakLift.value = 0.2;
```

| In `material.userData.uniforms` | In `fields.foamSettings` |
| --- | --- |
| `color`, `scatterColor`, `scatter`, `sunDirection`, `sunColor`, `sunLight`, `foamAmount`, `foamPeakBoost`, `foamLowest`, `foamBias`, `foamPeakLift`, `foamGrowth`, `foamDecay` | `bias`, `growth`, `decay`, `peakLift` |

`foamBias`, `foamGrowth` and `foamDecay` in the material's uniforms are the same uniforms as the
fields' `bias`, `growth` and `decay`. `foamSubtract`, `foamSmallestPatch`, `precision`, the
environment and the layout's options are fixed once the water is made: make another to change
them (the ocean example does, to switch layouts).

The sea itself is changed on the waves, not the water: `waves.setSea(...)` (see [The spectral
sea](./spectral-sea#changing-the-sea-while-it-runs)), which the water picks up on its next update.

### seaFog

The patches repeat, and from far enough off even with swell and gusts over them the sea's
sameness shows; then there is the hard line where it meets the sky. `seaFog` makes a haze for
`scene.fogNode` that hides both:

```ts
scene.fogNode = seaFog(scene.environment!, { sunDirection });
```

It thickens with distance, as e^−(distance / visibility)², thins with height, and is coloured as
the sky is the way one looks, brought down to the horizon, so the sea fades into the sky with no
line between them; toward the sun it glows.

| Option | Default | What it does |
| --- | --- | --- |
| `visibility` | `12_000` | Things this many metres off are a third hidden, twice as far all but gone. |
| `height` | `500` | The haze thins from the sea up to this height, in metres, and is gone above it. |
| `sunDirection` | straight up | Toward the sun, for its glow through the haze. |
| `sunGlow` | warm white × 1.5 | The sun's glow through the haze. |

The node it returns has `uniforms` (`visibility`, `height`, `sunDirection`, `sunGlow`) to change
as it runs. The sailboat example swaps it for its storm's own fog at night.

### GpuWaveFields

`water.fields` is the GPU half of the sea: render passes that turn each patch's spectrum on to the
frame's time, run the inverse FFT's stages over rows and then columns, unpack the result into
textures, and carry each patch's foam on. Its `textures` are what the material samples
(`displacement`, `derivatives`, `slopeMoments` and, if any patch makes foam, the two `foam`
textures written in turn), each a texture array with a layer for each patch, every layer repeating
every patch size; its `patches` give each patch's `size`, and the `foamLayer` it keeps its foam
in. Arrays, so that the water samples a handful of textures however many patches the sea has:
WebGPU allows only 16 to a shader stage unless the renderer asks for more. `passCount` is the number of render passes a frame
(18 for the default sea), and `atlas` the transform's raw result, for checking against the CPU's
(as `examples/ocean/gpu-check.html` does).

You need it directly only to build your own material on the same waves:
`createSpectralWaterMaterial(fields, vertex, options)` is the material both layouts use, given
where a vertex lies on the sea and how far apart its neighbours are.

### WebGPU and the WebGL 2 fallback

`SpectralWater` needs `WebGPURenderer` from `three/webgpu`, which draws with WebGPU where the
browser has it and falls back to WebGL 2 by itself where it doesn't. The FFT is done with render
passes rather than compute shaders precisely so that the same code runs on both: WebGL 2 has
neither workgroup memory nor storage textures.

::: warning What has been checked where
The GPU's FFT is checked against the CPU's on WebGPU and on the WebGL 2 fallback alike
(`examples/ocean/gpu-check.html`), and the costs above were measured on the fallback. Drawing
the water on WebGPU has been checked on Chrome's software adapter, which allows only WebGPU's
default 16 textures a shader stage, but not yet on a GPU's own WebGPU: see `TODO.md`.
:::

On the main thread, sending the FFT's render passes takes close to a millisecond a frame, most
of it three's own work for each `render` call; fewer, fuller passes would cut it (`TODO.md`).

## WaterMesh, for WebGLRenderer

With the classic `WebGLRenderer`, give the `Ocean` a `SumOfSines` sea and draw it with `WaterMesh`:
a `BatchedMesh` of square chunks around a follow target, coarser away from the centre, displaced
in the vertex shader by exactly the waves the physics uses. Its material is a
`MeshPhysicalMaterial` with the wave code spliced into it.

```ts
// drawn with three's WebGLRenderer
import { World } from '@eulerjs/core';
import { Buoyancy, Ocean, SumOfSines, WaterMesh } from '@eulerjs/marine';

const world = new World();
const ocean = new Ocean({ waves: new SumOfSines() });
const water = new WaterMesh(ocean, { world, follow: camera });
scene.add(water);

world.addBody(raft, { density: 500, shape: 'voxels' }).addBehavior(new Buoyancy({ ocean }));
```

With the `world` option the mesh animates itself before every render, at `world.renderTime`, and
you never call `update`. Without it, call `water.update(time)` each frame yourself. With `follow`
it stays centred under that object, moving in whole steps (`water.lod.snapStep`) so its vertices
land where others were and the triangles don't crawl.

The centre chunks resolve the same waves as the physics (both go by `waves.sampleSpacing`);
farther chunks drop the shortest waves from their geometry and keep them only in the per-pixel
normal, and waves too fine even for the pixels turn into roughness instead of sparkling.

| Option | Default | What it does |
| --- | --- | --- |
| `world` | none | The world it belongs to: animate at its render time. |
| `follow` | none | The object it stays centred under. |
| `normalMap` | none | A tiling texture for fine ripples, used as a bump map that drifts with time. |
| `chunkSize` | `150` | Edge length of a chunk, in metres. |
| `chunkCount` | `8` | Chunks along each side, an even number. |
| `chunkDropOff` | `1.25` | How much coarser each ring of chunks is than the ring inside it. |
| `antialiasMinSamplesPerPeriod` | `2` | Waves covering fewer pixels a period than this drop out of the shading normal, their slope turned into roughness. |
| `antialiasFullSamplesPerPeriod` | `4` | Waves are fully shaded from this many pixels a period. |
| `antialiasRoughness` | `1` | How strongly faded waves' slope turns into roughness; 0 turns it off. |
| `material` | | Overrides for the `MeshPhysicalMaterial` (colour `0x112234`, roughness 0.05, IOR 1.333 and so on). |

The shader's uniforms are in `water.uniforms`. `sumOfSinesShaderChunk`, `createSumOfSinesUniforms`
and `updateSumOfSinesTime` give you the same GLSL and uniforms to displace a material of your own
by a `SumOfSines` sea.

::: details SumOfSines options
A `SumOfSines` is `waveCount` peaked waves (Acerola's "sum of sines" with exponential waves), each
`wavelengthFalloff` times as long and `amplitudeFalloff` times as high as the one before, with
directions scattered by `directionStep` and leaning toward `directionBias`. Each wave's
coordinates are pushed sideways by the slope of the waves before it, which sharpens the crests
and moves the surface sideways, like Gerstner waves.

| Option | Default |
| --- | --- |
| `waveCount` | `46` |
| `wavelength` | `90` (the first wave is already one falloff shorter) |
| `amplitude` | `1.1` |
| `amplitudeFalloff` | `0.86` |
| `wavelengthFalloff` | `0.875` |
| `speedFactor` | `0.8`, times the deep-water phase speed |
| `peakSharpness`, `peakOffset` | `2.4`, `1` |
| `directionSeed`, `directionStep` | `187`, `-183.215` |
| `timeOffset`, `timeScale` | `600`, `1` |
| `sampleSpacing` | `150 / 292`, the default mesh's centre vertex spacing |
| `minSamplesPerPeriod`, `fullSamplesPerPeriod` | `4`, `8` |
| `inversionIterations` | `3` |
| `gravity` | `9.807` |

Waves too short for a grid of `sampleSpacing` fade out of the physics surface, as they fade out
of the mesh's finest chunks: that is how the two agree.
:::

## See also

- [The spectral sea](./spectral-sea): the waves `SpectralWater` draws
- [Overview](./): which sea and which renderer
- [Buoyancy](./buoyancy): floating on what you see
- [Examples](/examples/): `examples/ocean` switches layouts and tunes the foam live
