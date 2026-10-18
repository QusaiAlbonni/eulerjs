# The spectral sea

`SpectralWaves` is the sea `Ocean` makes when you don't give it one. It is a wind sea as
oceanographers describe one: hundreds of thousands of waves drawn from the **JONSWAP spectrum**
(after Horvath's "Empirical directional wave spectra for computer graphics", 2015) and summed by
**inverse FFT** (Tessendorf's "Simulating Ocean Water"). The waves are linear, sharpened at the
crests by moving the surface's points sideways toward them, and in deep water throughout.

```ts
import { Ocean, SpectralWaves } from '@eulerjs/marine';

const waves = new SpectralWaves({ windSpeed: 11, windAngle: 0.3 });
const ocean = new Ocean({ waves });
```

The same object serves the physics, on the CPU, and the water drawn, on the GPU
([`SpectralWater`](./water-rendering)), and the two agree on every wave they share.

## From the wind to the waves

A sea is described by the wind that raised it. The spectrum says how much of the sea's energy
there is at each frequency, from how hard the wind blows (`windSpeed`, ten metres up) and how far
it has blown over open water (`fetch`); a directional spread (Mitsuyasu's) says how that energy
fans out about the wind's direction, the longest waves keeping closest to it. Each wave on the
grid gets a random height and phase drawn from that, from a hash of its own place and the `seed`,
so a different seed is a different sea of the same kind.

The functions behind it are exported, for plotting or checking a sea: `jonswap(angularFrequency,
seaState)`, `jonswapParameters(seaState)` (the peak frequency and energy scale),
`directionalSpread(angularFrequency, angle, seaState)` and `wavenumberSpectrum(waveNumberX,
waveNumberZ, windAngle, seaState)`, where a `SeaState` is `{ windSpeed, fetch, peakEnhancement,
gravity }`.

## Patches

No single grid can hold waves from half a kilometre long down to a couple of centimetres, so the
sea is a few square **patches** of different sizes, tiled over the world, each holding its own
band of wavelengths. Each patch holds the waves from 4 of its own fundamental wavenumbers (four
waves across it) up to where the next, smaller patch takes over. Sizes that don't divide each
other keep their repeats from lining up.

| Option | Default | What it does |
| --- | --- | --- |
| `patchSizes` | `[512, 113, 25, 5.5, 1.2]` | Edge lengths of the patches in metres, from the largest. The smallest sets how fine the water drawn close up gets. |
| `resolution` | `128` | Waves across each patch the water drawn holds, a power of two. Since each patch only holds the waves from 4 to about 20 across it, this matters for the smallest patch only: 128 takes it down to waves 2 cm long, 64 to 4 cm for a sixth less time on the GPU. |
| `physicsResolution` | `64` | Waves across each patch the physics evaluates, a power of two no more than `resolution`. |
| `physicsPatches` | `2` | How many patches, from the largest, the physics evaluates. |

The physics floats bodies on the **longest** waves: the two largest patches, 64 waves across
each. Those are the waves a hull rides on, and they are the same waves in the water drawn, which
adds every shorter one on top. With the default patches, the waves the 25 m patch and the
smaller ones hold, about 6 m long and shorter, are drawn but not felt. That is right for boats; a
small floating thing rides a little too smoothly.

`waves.patches` lists the patches, each with its `size`, `resolution` and the band of wavenumbers
it holds (`lowestWaveNumber`, `highestWaveNumber`).

## The sea's settings

These describe the wind and the waves, and can all be changed while the sea runs, with
[`setSea`](#changing-the-sea-while-it-runs). `waves.sea` holds them as they are now.

| Option | Default | What it does |
| --- | --- | --- |
| `windSpeed` | `12.5` | Wind speed ten metres up, in m/s: a strong breeze. From 5 a calm sea, through 10 a fresh breeze's, to 20 a gale's. |
| `windAngle` | `0` | The way the wind blows, in radians from +x toward +z, as `Wind`'s `angle`. |
| `fetch` | `100_000` | How far the wind has blown over open water, in metres. |
| `peakEnhancement` | `3.3` | JONSWAP's γ: 3.3 for a young sea, 1 for a fully grown one. |
| `choppiness` | `1.3` | How far the surface's points move sideways toward the crests: 0 for none, 1 for the full Gerstner motion, more to fold the crests over. 1.3 gives sharp crests, folding over at the steepest. |
| `heightScale` | `2.05` | Every wave's height times this. Above 1 the sea is larger and wilder than its wind would raise, as seas in films are. |
| `swellHeight` | `2` | Significant height of a swell running under the wind's sea, in metres; 0 for none. |
| `gustiness` | `0.3` | How much rougher and calmer the sea is from place to place; 0 for an even sea. |
| `shortWaveFade` | `0` | Fades the shortest waves out: the spectrum times e^(−k²ℓ²) for this length ℓ in metres, so waves much shorter than 2πℓ are gone, for a smoother, glassier sea. |

`windSpeed`, `fetch`, `peakEnhancement` and `heightScale` must be positive, the rest no less than
zero; anything else throws a `RangeError`.

### How high

`waves.significantWaveHeight` is the sea's significant wave height, Hs: four times the standard
deviation of its height, about the mean height of the highest third of the waves, as sea states
are given. It includes the swell. For a feel of the numbers, with the default fetch:

| `windSpeed` | Wind sea at `heightScale: 1` | Wind sea at the default 2.05 |
| --- | --- | --- |
| 5 m/s | 1.2 m | 2.4 m |
| 10 m/s | 2.1 m | 4.4 m |
| 12.5 m/s (default) | 2.6 m | 5.3 m |
| 20 m/s | 3.9 m | 8.1 m |

These are without the swell. The default 2 m swell adds to them in quadrature (heights add as
the square root of the sum of their squares), so `new SpectralWaves().significantWaveHeight` is
about 5.6 m. `heightScale` scales the wind's waves, not the swell.

::: tip Rougher, the real way or the film way
`windSpeed` is the way to a rougher sea that is still a real one: its waves grow longer as well as
taller. `heightScale` makes the same waves taller, which looks wilder than any wind would make
them. For a sea that matches a real wind, use `heightScale: 1`.
:::

### Swell

The patches repeat, every 512 m at most. Under them runs a **swell** that doesn't: a few long
waves, hundreds of metres to a kilometre long, too long for any patch, summed where they are
rather than tiled. From afar they break up the patches' repeats, as well as lifting everything
on long, slow hills. Besides `swellHeight`, set when the sea is made:

| Option | Default | What it does |
| --- | --- | --- |
| `swellCount` | `8` | How many long waves the swell is made of. |
| `swellWavelengths` | `[200, 1000]` | The shortest and longest of them, in metres. |
| `swellAngle` | the wind's way | The way the swell runs, in radians as `windAngle`. |
| `swellSpread` | `0.5` | How far, in radians either side, its waves run from `swellAngle`. |

The swell's direction is fixed when the sea is made: turning the wind with `setSea` turns the
wind's sea, not the swell, as a real swell from a distant storm keeps its own way.

### Gusts

Real seas are rougher in some stretches than others, where the wind gusts. `gustiness` scales
the waves of the patches up to `gustPatches` in size up and down by about that much, over
stretches a kilometre or two across, in a pattern of four long sines that never repeats. From
afar the sea's texture then varies as a real one's does, which hides the patches' repeats.

| Option | Default | What it does |
| --- | --- | --- |
| `gustPatches` | `150` | Patches up to this size, in metres, gust: by default all but the largest. |
| `gustScale` | `1500` | About how far across the gusts' stretches are, in metres. |

`waves.gustAt(gridX, gridZ)` says how much the gusting waves are scaled by at a point: one, plus
the gustiness times the pattern, never below 0.05. The gusts are in the physics' heights as in the
water drawn. They don't move: real gusts run downwind.

### Time

| Option | Default | What it does |
| --- | --- | --- |
| `timeScale` | `1` | Speeds the sea up (above 1) or slows it down. |
| `timeOffset` | `0` | Added to the time the sea is evaluated at. |
| `loopPeriod` | `1000` | The sea repeats exactly every this many seconds; `Infinity` for no loop. |
| `seed` | `1` | A different seed, a different sea. |
| `gravity` | `9.807` | For the waves' speeds: deep water's ω = √(g k). It is the sea's own, not the world's. |
| `inversionIterations` | `3` | Fixed-point steps to find the undisplaced point under a world position. |

`loopPeriod` exists for the GPU. It works in single precision, which over an hour would let its
waves drift from the physics' by a part in a few thousand. So every wave's frequency is rounded to
a whole number of turns in the loop period (by at most π / `loopPeriod` rad/s), the time the
waves are evaluated at wraps round, and the GPU's waves stay on the physics' however long the sea
runs. `waves.phaseTime(time)` is the time the waves are evaluated at for a simulation time:
scaled, offset and wrapped.

## Changing the sea while it runs

```ts
waves.setSea({ windSpeed: 22, heightScale: 2.5, choppiness: 1.3 }); // a storm
console.log(waves.significantWaveHeight.toFixed(1)); // about 11 m
```

`setSea` takes any of the sea's settings above and leaves the rest as they are. Each wave keeps
the random draw it was made with, so the sea grows or calms into the new one, wave by wave,
instead of jumping to another: each wave keeps its place and phase. The physics, the worker and the water
drawn all follow: `waves.version` counts the changes, and `SpectralWater` notices a new version
on its next update.

Changing the sea costs about a frame's work, since every patch's waves are drawn again, so don't
call it every frame. The sailboat example turns the sea to its wind at most four times a second,
and only when the wind has turned by more than about a degree:

```ts
import type { SpectralWaves, Wind } from '@eulerjs/marine';

const SECONDS_BETWEEN_CHANGES = 0.25;
const SMALLEST_TURN = 0.02;

function followWind(waves: SpectralWaves, wind: Wind, secondsSinceChange: number): boolean {
  if (secondsSinceChange < SECONDS_BETWEEN_CHANGES) return false;
  const difference = wind.angle - waves.sea.windAngle;
  const turn = Math.atan2(Math.sin(difference), Math.cos(difference));
  if (Math.abs(turn) < SMALLEST_TURN) return false;
  waves.setSea({ windAngle: wind.angle });
  return true;
}
```

## Asking the sea

| Method | Returns |
| --- | --- |
| `heightAt(worldX, worldZ, time)` | The surface's height directly above or below a world position. |
| `heightFrom(worldX, worldZ, time, startGridX, startGridZ, iterations)` | The same, starting the search from a guess (a good one needs one iteration); the grid point found is left in `lastGridPoint`. |
| `surfacePoint(gridX, gridZ, time, target?)` | Where the surface point that started at a grid position is now, moved sideways as well as up. |
| `riseRate(gridX, gridZ, time)` | How fast that surface point rises, in m/s: the water's own vertical velocity. |
| `normalAt(worldX, worldZ, time, target?)` | The surface's upward unit normal. |

The surface moves sideways, so the point of the surface over a world position at some time
started somewhere else. `heightAt` finds where, by a few fixed-point steps: guess the point under
the position, see where the waves have moved it, correct the guess by the miss, repeat. That is
why the methods come in two kinds, by world position and by grid position.

`riseRate` is not how fast the height at a fixed place changes. As a steep crest passes, the
surface at a place rises faster than the water itself does; a floating body moving with the
water must move with the latter. [Buoyancy](./buoyancy) uses it for exactly that.

## What the physics costs

The physics evaluates its patches by FFT **once a time step**, two 64² patches in about 0.5 ms,
and every height asked for during that step is then a few bilinear lookups in their grids (and
the swell's few waves). That makes a height about ten times cheaper than on a `SumOfSines`, so
from three floating bodies on the spectral sea costs less. The last two evaluations are kept, so
a render frame asking about the time the bodies are drawn at, between steps, doesn't redo either
step's.

::: warning One time at a time
Each new time the sea is asked about costs a whole evaluation. Asking about many different
times in one step (sampling ahead, say) runs the FFT for each of them.
:::

`physicsResolution` and `physicsPatches` trade cost against detail: fewer or coarser patches
are cheaper to evaluate, and leave more of the shorter waves unfelt. `npm run bench` prints what
every combination from 32² to 128² and from one patch to three costs on your machine.

## Evaluating in a worker

`useWorker` moves the physics' evaluation off the main thread. The worker is the module at
`@eulerjs/marine/spectral-worker`; how to start a module worker depends on your bundler:

```ts
import { SpectralWaves } from '@eulerjs/marine';
import SpectralWorker from '@eulerjs/marine/spectral-worker?worker'; // Vite's way

const waves = new SpectralWaves();
waves.useWorker(new SpectralWorker());
```

Without Vite's `?worker` suffix, the standard way works too:

```ts
waves.useWorker(new Worker(new URL('@eulerjs/marine/spectral-worker', import.meta.url), { type: 'module' }));
```

The worker can only answer between frames, so it has to be asked ahead. `prefetch(time)` asks it
to evaluate the sea at a time before it is needed, and `Buoyancy` does that for you, asking each
step for the next three steps' waves. After the first few frames every step's waves are ready when
the step comes, and the main thread only looks heights up. A step whose waves haven't arrived is
evaluated on the main thread as before, so nothing waits on the worker.

What comes back is exactly what the main thread would have worked out: a body floats the same,
to the last bit, with or without the worker. `waves.workerStatistics` counts the evaluations the
worker had `ready` and those it `missed`, which is worth a glance while you tune.

::: details Serving the worker's protocol yourself
The worker module only calls `serveSpectralFields(globalThis)`. `serveSpectralFields(port)`
answers `SpectralWaves`' requests on any `SpectralPort`, which is anything with `postMessage` and
`onmessage`: a worker's global scope, or one end of a `MessageChannel`. The tests serve it on a
`MessageChannel`, to run the protocol without a real thread. The fields travel as transferred
buffers, so nothing is copied.
:::

## See also

- [Drawing the water](./water-rendering): `SpectralWater` draws every patch, not just the physics'
- [Buoyancy](./buoyancy): what floats on these heights
- [Overview](./): the two seas side by side
- [Examples](/examples/): `examples/ocean` has sliders for the wind, the height and the choppiness
