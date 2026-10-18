# Buoyancy

`Buoyancy` floats a body on an `Ocean`. It is a [behaviour](/guide/bodies): you add one to each
floating body, and every fixed step it pushes the body up by the weight of the water it
displaces, damps it against the water's motion, and drags on it in the water.

```ts
import { World } from '@eulerjs/core';
import { Buoyancy, Ocean } from '@eulerjs/marine';

const world = new World();
const ocean = new Ocean();
const crate = world.addBody(crateMesh, { density: 450, shape: 'voxels', cellSize: 0.25 });
const buoyancy = crate.addBehavior(new Buoyancy({ ocean }));
```

After each step, `buoyancy.submergedFraction` says how much of the body was under water, from 0
to 1, and `buoyancy.lastForce` the sum of the buoyant and damping forces it applied, in world
space.

## Voxels: where the water is sampled

Buoyancy needs to know how much of the body is under water, and where. It works from the body's
**voxels**: its shape filled with equal cubes, each one a sample of the water.

`Buoyancy` takes the first of these it finds:

1. the `voxels` you give it;
2. the body's own voxels, which a body added with **`shape: 'voxels'`** has;
3. voxels it makes itself when it is added to the body, from the meshes of the object the body is
   bound to, with cells `cellSize` across (by default a sixteenth of the shape's longest side).

If the body has none of these, adding the behaviour throws, saying what it needs.

`shape: 'voxels'` is the way to start, for two reasons. It fills open meshes too, such as a hull
with no deck: a cell counts as inside when lines through it along at least two of the three axes
cross the surface an odd number of times, so an open deck fools the vertical lines but not the
horizontal ones. And it weighs the body from the same cells, so the volume the body's mass is
spread through is exactly the volume the water pushes on: at a density of 450 kg/m³ it floats
with 450/1029 of its volume under seawater.

```ts
// a mesh, any mesh: weighed and floated from the same cells
world.addBody(hull, { mass: 4500, shape: 'voxels', cellSize: 0.25 }).addBehavior(new Buoyancy({ ocean }));
```

For a body you build yourself, make the voxels with `Voxels.fromGeometry(geometry, { cellSize })`
and use them for both its mass properties and its buoyancy:

```ts
import { BoxGeometry } from 'three';
import { Body } from '@eulerjs/core';
import { Buoyancy, Voxels } from '@eulerjs/marine';

const voxels = Voxels.fromGeometry(new BoxGeometry(2, 1, 3), { cellSize: 0.5 });
const body = world.addBody(new Body({ massProperties: voxels.massProperties(400 * voxels.volume), voxels }));
body.addBehavior(new Buoyancy({ ocean }));
```

`voxels.cells` are the cell centres in the body's frame, `voxels.cellSize` their edge,
`cellVolume` and `volume` what they hold, and `massProperties(massOrDensity)` the mass properties
of the cells at a uniform density, from a total mass or a `{ density }`. The sailboat example adds
the keel's lead to them as a point mass, with `combine(MassProperties.point(...))`.

::: tip Choosing a cell size
Small enough to catch the parts that matter (the sailboat's 0.25 m cells catch its keel fin), and
no smaller: how many cells there are is a cost every step. What the water costs to sample does
not grow with the cell count, though; see [The surface under the hull](#the-surface-under-the-hull).
:::

## How the forces are worked out

Every step, for each cell:

- **Depth.** The cell's centre is moved into the world, and the water's height above it found.
  The cell counts as a slab of its own height: half in the water when its centre is at the
  surface, all in when the surface is half a cell over it, none when half a cell under.
- **Buoyancy.** The cell is pushed straight up, against gravity, by the weight of the water it
  displaces: the ocean's density, times its volume, times how much of it is in, times gravity.
  The force acts at the cell's own position, so a tilted hull is pushed back toward upright, and
  a long one pitches as a crest runs along it.
- **Heave damping.** How fast the cell sinks into the water is resisted, `heaveDamping` newton
  seconds per metre for each cubic metre of cell in the water. This is what makes a hull settle
  instead of bobbing and rocking for ever.
- **Slamming.** A partly submerged cell plunging into the water feels an extra drag, quadratic in
  how fast it plunges, times `slamCoefficient`: a hull coming down hard on a wave is stopped hard.

And then, for the whole body:

- **Water drag.** A drag proportional to the body's velocity, and a torque proportional to its
  spin (through its inertia), each at a rate that goes from the minimum, out of the water, to
  `linearDrag` and `angularDrag` fully under it, in proportion to how much of it is in.

Nothing happens in a world without gravity, and the push is always against gravity, whichever way
it points.

### Relative to the water, not the surface

The heave damping resists the cell's motion **relative to the water**, and the water is not the
surface. As a steep crest passes a fixed place, the surface there rises faster than any of the
water in it moves: the crest's shape is travelling, not the water. Damped against the surface's
rise at a place, bodies would be thrown off the crests. So `Buoyancy` damps against
`riseRate`, how fast the water at the surface rises, which both seas provide. (A `WaveSurface` of
your own without `riseRate` is damped against how fast each cell's depth changed since the last
step instead.)

### Asking for the waves ahead

Each step `Buoyancy` also calls the sea's `prefetch` for the next three steps' times. A
`SpectralWaves` in a worker uses that to have each step's waves ready before the step comes (see
[Evaluating in a worker](./spectral-sea#evaluating-in-a-worker)); other seas ignore it.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `ocean` | required | The water: its `waves` and its `density`. |
| `voxels` | the body's | The hull as cells, in the body's frame. |
| `cellSize` | a sixteenth of the longest side | Cell size when `Buoyancy` voxelises the body's meshes itself. |
| `heaveDamping` | `3000` | Resistance to cells moving into or out of the water, in N·s/m per m³ of submerged cell. |
| `slamCoefficient` | `1` | Extra drag, quadratic in speed, on partly submerged cells plunging in. |
| `linearDrag` | `1` | Linear drag a second, fully submerged. |
| `angularDrag` | `1` | Angular drag a second, fully submerged. |
| `minimumLinearDrag` | `0.02` | Linear drag that remains however little of the body is in the water. |
| `minimumAngularDrag` | `0.02` | The same, for turning. |
| `surfaceSampleSpacing` | `0.5` | Spacing of the grid the surface is sampled on under the body, in metres. |

`heaveDamping`, `slamCoefficient` and the four drags are properties you can change while the body
floats (the sailboat example has sliders for them), and so is `ocean.density`. A drag of 1 a
second takes a body's speed down by a factor of e every second fully under water, so it is
mostly what sets how fast a hull goes through the water for a given push. The sailboat uses
`linearDrag: 0.25` and `angularDrag: 1`, which gives it about 3 m/s on a reach in 8 m/s of wind.

::: warning One behaviour for each body
A `Buoyancy` remembers each of its cells' depths from the last step, so it belongs to one body.
Make a new one for every body you float, all with the same `ocean`.
:::

## What floats, and how

The tests check floating against what Archimedes and stability theory say:

- A cube floats at a **draft** of its relative density times its height: a 1 m cube 0.15 times
  as dense as the water floats 15 cm deep, to within a millimetre.
- A body **denser than the water** sinks, and one resting on the sea floor presses on it with its
  weight less its buoyancy; a buoy moored under water pulls on its rope with its buoyancy less its
  weight.
- A weight put on a raft sinks it by that weight over the raft's waterplane: 500 kg on a 4 m by
  4 m raft, about 3 cm.

How a body floats, upright or on its side, is up to its shape and density, as it is in a real sea.

::: info A floating cube is only stable upright below about 0.21 or above about 0.79 of the water's density
In between, upright is a balance it falls off: a cube of pine, half as dense as the water, rolls
over onto an edge and floats that way, keeping half its volume under water. The floating example
drops cubes of cork, pine and oak to show it. A wide, flat raft is stable at any density, and
rights itself when tipped. If something you expect to float flat floats tilted, it is most often
this, not a bug: lower its centre of mass or widen it, as a boat's ballast keel does.
:::

## The surface under the hull

Asking the waves for a height costs more than the arithmetic of a cell, so `Buoyancy` doesn't ask
for each cell. It samples the surface on a horizontal grid fixed in the world, `SurfaceGrid`,
over the rectangle the hull covers, and interpolates each cell's height from it. The cost of a
step then grows with **the area under the hull divided by the spacing squared**, not with the
number of cells, so you can voxelise finely without paying for it in wave lookups.

The grid's nodes remember, between steps, where their surface point came from, so a single step
of the height search is enough for each while the hull moves smoothly.

Interpolating rounds off the sharpest crests. On the default sea, the default 0.5 m spacing is
off by 3 mm on average and up to about 2 cm at the sharpest crests; the error shrinks with the
square of the spacing. For something small, 1 m is often plenty: the sailboat's drifting crates
use `surfaceSampleSpacing: 1`, which floats them as well as the default does for half the cost.

`SurfaceGrid` and `SurfaceSampler` are exported for floating things of your own:

```ts
import { SurfaceGrid } from '@eulerjs/marine';

const grid = new SurfaceGrid(ocean.waves, 0.5); // spacing in metres
grid.update(minimumX, maximumX, minimumZ, maximumZ, world.time); // once a step, over the area you need
const height = grid.heightAt(worldX, worldZ);
const rising = grid.knowsRiseRate ? grid.riseRateAt(worldX, worldZ) : 0;
```

`SurfaceSampler` is the other way round: heights under a fixed set of points that move a little
between calls, each point remembering its own surface point. `ocean.createSurfaceSampler(count)`
makes one; `sampler.heightAt(pointIndex, worldX, worldZ, time)` asks for one point, and
`sampler.reset()` forgets what they remember, after teleporting them, say.

## Floating with everything else

Buoyancy is only forces on a body, so a floating body collides, sleeps and joins as any other
does. The tests moor a buoy on a `DistanceJoint`, sit a crate on a sunken seabed, stack a crate
on a raft, and push floating crates against a quay and each other in a spectral sea. Give
floating things a collider (`collider: 'box'` with `shape: 'voxels'` is common) so they bump into
each other and the boat. See [Colliders](/guide/colliders) and [Joints](/guide/joints).

## Limitations

- **No added mass.** A body moving through water must move the water around it too, which slows
  how fast it can be pushed about. Without it, a light crate shot up by a crest on a tall sea
  leaves the water for a moment, as real crates don't. It is in `TODO.md`.
- **Short waves aren't felt.** The physics floats on the spectral sea's two largest patches, so
  the shorter waves drawn on top don't move anything: fine for boats, a little too smooth for
  small floating things. See [Patches](./spectral-sea#patches).
- **The water doesn't flow.** The ocean's water is still under its moving surface: bodies aren't
  carried along by the waves' orbital motion or by currents, only lifted and damped. A keel feels
  only the boat's motion through the water.
- **Deep water only**: no shoaling or slower waves in the shallows.

## See also

- [The spectral sea](./spectral-sea): the waves, and a worker for them
- [Sails and foils](./sails-and-foils): making a floating body go somewhere
- [Bodies](/guide/bodies): behaviours, `shape: 'voxels'` and mass properties
- [Examples](/examples/): the floating cubes, the ocean's crates and the sailboat
