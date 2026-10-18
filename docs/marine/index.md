# @eulerjs/marine

`@eulerjs/marine` is the sea for eulerjs: waves, water that holds things up, and wings that work
in water and air. It gives you

- a **sea surface** the physics can ask for heights, normals and how fast the water rises, in
  two kinds: `SpectralWaves`, the default, and `SumOfSines`, the simpler one for `WebGLRenderer`;
- `Ocean`, the water under that surface, and `Wind`, the air above it;
- `Buoyancy`, a behaviour that floats a body cell by cell, using its `Voxels`;
- `Foil` and its polars, for sails, keels and rudders;
- two **water renderers** that draw exactly the waves the physics floats bodies on:
  `SpectralWater` for three's `WebGPURenderer`, and `WaterMesh` for `WebGLRenderer`.

```sh
npm install @eulerjs/marine eulerjs three
```

It needs three 0.166 or later, and `@eulerjs/marine/webgpu` 0.186 or later: three's
`three/webgpu`, which it draws with, changes quickly. The package has three entry points:

| Import from | What is in it |
| --- | --- |
| `@eulerjs/marine` | the seas, `Ocean`, `Wind`, `Buoyancy`, `Voxels`, `Foil` and the polars, `WaterMesh`, `SurfaceGrid`, `SurfaceSampler` |
| `@eulerjs/marine/webgpu` | `SpectralWater`, `seaFog`, `GpuWaveFields` and the levels of detail: everything that needs `three/webgpu` |
| `@eulerjs/marine/spectral-worker` | the module a `Worker` runs to evaluate a spectral sea's physics off the main thread |

The WebGPU parts live apart so that importing `@eulerjs/marine` never pulls in `three/webgpu`.

## Quick start

A spectral sea drawn to the horizon, and a crate floating on it:

```ts
import { BoxGeometry, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, Scene, Timer, WebGPURenderer } from 'three/webgpu';
import { World } from 'eulerjs';
import { Buoyancy, Ocean } from '@eulerjs/marine';
import { SpectralWater } from '@eulerjs/marine/webgpu';

const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.3, 400_000);
camera.position.set(0, 6, 16);
camera.lookAt(0, 0, 0);

const world = new World();
const ocean = new Ocean(); // a SpectralWaves sea, seawater at 1029 kg/m³
const water = new SpectralWater(ocean.waves); // the very waves the physics floats on
scene.add(water);

const crate = new Mesh(new BoxGeometry(1.6, 1, 2.2), new MeshStandardNodeMaterial({ color: 0xb07a45 }));
crate.position.set(0, 1, 0);
scene.add(crate);
// shape: 'voxels' fills the crate with cells: its mass properties, and where buoyancy samples the water
world.addBody(crate, { density: 450, shape: 'voxels', cellSize: 0.25 }).addBehavior(new Buoyancy({ ocean }));

const timer = new Timer();
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  world.update(timer.getDelta());
  // the sea at the moment the bodies are drawn at, finest around the camera
  water.update(renderer, world.renderTime, camera.position, camera);
  renderer.render(scene, camera);
});
```

Two things in it matter more than they look:

- The water is updated with **`world.renderTime`**, the moment the bodies are drawn at between
  fixed steps (see [Bodies](/guide/bodies)). Give it any other time and the crate seems to float
  a little off the waves it is riding.
- The water is updated with the **camera's position** as its centre, where it lays out its finest
  triangles, and with the camera itself, so that the parts out of view are left out.

Without a sky the water is lit by the scene's lights like any physical material. Given one (an
`environment` from `PMREMGenerator`) it is shaded as a mirror of that sky over the water's
colour, with the sun glinting off it: see [Drawing the water](./water-rendering).

## The two seas

Both seas are a pure function of position and time, so the physics and the GPU agree on every
wave as long as both are given the same time. Both move the surface's points sideways as well
as up, which sharpens the crests, so finding the height *at* a world position takes finding
which point of the undisturbed surface has moved there. They do that for you.

| | `SpectralWaves` (the default) | `SumOfSines` |
| --- | --- | --- |
| What it is | Hundreds of thousands of waves drawn from the JONSWAP spectrum of a wind sea, summed by inverse FFT, in tiled patches from 512 m to 1.2 m across | 46 peaked sine waves, each shorter and lower than the one before |
| Drawn by | `SpectralWater`, with `WebGPURenderer` (on WebGPU or its WebGL 2 fallback) | `WaterMesh`, with `WebGLRenderer` |
| Set by | the wind: `windSpeed`, `windAngle`, `fetch`, plus `heightScale`, `choppiness`, swell and gusts | wavelengths, amplitudes, falloffs and directions |
| Changes while running | yes, with `setSea` | no |
| Off the main thread | yes, with `useWorker` | no |
| Physics cost | one FFT a step (about 0.5 ms), then each height is a few lookups: about ten times faster per height than `SumOfSines` | every height sums its waves afresh |

`SpectralWaves` is what to use unless you draw with `WebGLRenderer`. Its sea reaches to the horizon
without looking tiled, as detailed a metre from the camera as a kilometre away, and from three
floating bodies on it costs the physics less than `SumOfSines` does. [The spectral
sea](./spectral-sea) covers it in depth.

```ts
import { Ocean, SpectralWaves, SumOfSines } from '@eulerjs/marine';

const stormy = new Ocean({ waves: new SpectralWaves({ windSpeed: 20 }) });
const forWebGL = new Ocean({ waves: new SumOfSines() });
const freshWater = new Ocean({ waves: new SpectralWaves({ windSpeed: 9, heightScale: 1 }), density: 1000 });
```

::: tip A flat sea
`new SumOfSines({ waveCount: 0 })` is perfectly still water at height 0. The tests float things on
it when the waves would only get in the way of checking a draft or a force.
:::

Both are a `WaveSurface`, the interface `Ocean`, `Buoyancy` and `SurfaceGrid` take. A sea of your
own only has to implement it: `heightAt`, `heightFrom` (a height search started from a guess),
`lastGridPoint`, `normalAt` and `surfacePoint`, with `riseRate` and `prefetch` if it can.

## Ocean and Wind

`Ocean` is the water: its `waves`, and its `density`, seawater's 1029 kg/m³ unless you give
another. It asks its waves for `surfaceHeight(worldX, worldZ, time)` and
`surfaceNormal(worldX, worldZ, time)`. The water itself is still: only its surface moves. As a
fluid a foil moves through, its velocity is zero everywhere, so a keel feels only the boat's
own motion through it.

`Wind` is the air: a steady, uniform wind, `speed` 13 m/s blowing toward `angle` 1.3 radians
(measured from +x toward +z), through air of `density` 1.293 kg/m³. All three can be changed at
any time.

```ts
import { Wind } from '@eulerjs/marine';

const wind = new Wind({ speed: 8, angle: Math.PI / 2 }); // 8 m/s, blowing toward +z
wind.angle += 0.1; // veer it
```

Both are a `FluidMedium` (a `density`, and a `velocityAt(point, time, target)`), which is all a
`Foil` asks of the fluid it works in.

## Buoyancy and voxels

`Buoyancy` is a [behaviour](/guide/bodies): one per floating body. It applies Archimedes'
principle cell by cell, each cell under the surface pushed up by the weight of the water it
displaces, at its own position, so a tilted hull is pushed back upright and a long one pitches
over a passing crest. It damps the body's heave against the water's own motion, and drags on it
in proportion to how much of it is in the water.

The cells are the body's `Voxels`: equal cubes filling its shape. The easy way to get them is
`shape: 'voxels'` when you add the body, which also weighs it from the same cells, so its mass and
its buoyancy agree. It works for meshes that aren't closed, such as a hull open at the deck.

```ts
const raft = world.addBody(raftMesh, { density: 500, shape: 'voxels', cellSize: 0.25 });
raft.addBehavior(new Buoyancy({ ocean }));
```

`Voxels` lives in the core `eulerjs` package; `@eulerjs/marine` exports it too. See
[Buoyancy](./buoyancy) for the forces, the options and what floats stably.

## Foils

A `Foil` is a wing-like surface on a body, a sail, a keel or a rudder, that turns the flow past
it into lift across the flow and drag along it. You give it the fluid (`Wind` for a sail, the
`Ocean` for a keel), its area, where its force acts, and a polar: its lift and drag coefficients
against the angle of attack. Trimming a sail or turning a rudder is setting its `angle`.

```ts
import { Vector3 } from 'three';
import { camberedSailPolar, Foil, symmetricFoilPolar, Wind } from '@eulerjs/marine';

const wind = new Wind();
const mainsail = boat.addBehavior(
  new Foil({ medium: wind, area: 14, center: new Vector3(0, 3.9, 0.13), pivot: new Vector3(0, 3.88, 1.11), polar: camberedSailPolar() }),
);
boat.addBehavior(new Foil({ medium: ocean, area: 2, center: new Vector3(0, -1, 1), polar: symmetricFoilPolar({ liftSlope: 3 }) }));
mainsail.angle = 0.6; // ease the boom out
```

The polars that come with it are `camberedSailPolar` (a sail), `symmetricFoilPolar` (keels,
rudders, centreboards), `sailPolar` (the table of the three-sails demo this engine came out of)
and `TablePolar` for your own measured one. [Sails and foils](./sails-and-foils) has the details,
and how the sailboat example is put together.

## Drawing the water

The physics and the picture are the same sea, so a crate sits *on* the wave you see, not near it.

- **`SpectralWater`** (from `@eulerjs/marine/webgpu`) draws a `SpectralWaves` sea with three's
  `WebGPURenderer`, every wave of every patch evaluated on the GPU each frame by the same FFT the
  physics runs on the CPU. It works on WebGPU and on `WebGPURenderer`'s own WebGL 2 fallback,
  reaches 262 km around the camera, and has foam, a sky reflection, light scattered through the
  crests, and `seaFog` to haze the horizon.
- **`WaterMesh`** draws a `SumOfSines` sea with the classic `WebGLRenderer`: a `BatchedMesh` of
  chunks around a follow target, displaced in the vertex shader by exactly the physics' waves.

```ts
// drawn with three's WebGLRenderer
import { Ocean, SumOfSines, WaterMesh } from '@eulerjs/marine';

const ocean = new Ocean({ waves: new SumOfSines() });
scene.add(new WaterMesh(ocean, { world, follow: camera })); // animates itself at world.renderTime
```

::: warning Pick the pair
`SpectralWater` throws if it is updated with anything but a `WebGPURenderer`, and `WaterMesh`
throws if it is given a sea that isn't a `SumOfSines`. Since `new Ocean()` makes a `SpectralWaves`
sea, give the `Ocean` a `SumOfSines` when you draw with `WebGLRenderer`.
:::

[Drawing the water](./water-rendering) covers both, the two levels of detail, foam and the
settings you can change while it runs.

## See also

- [The spectral sea](./spectral-sea): the spectrum, the patches, every sea setting, workers
- [Drawing the water](./water-rendering): `SpectralWater`, foam, fog and `WaterMesh`
- [Buoyancy](./buoyancy): how floating works, its options and its limits
- [Sails and foils](./sails-and-foils): `Foil`, `Wind`, polars and the sailboat
- [Examples](/examples/): the sailboat, the ocean and the floating cubes
