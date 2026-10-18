# Sails and foils

A sail, a keel and a rudder are the same thing working in different fluids: a wing that turns the
flow past it into **lift**, across the flow, and **drag**, along it. In `@eulerjs/marine` each is a
`Foil`, a [behaviour](/guide/bodies) on the boat's body that works out its force every step from
the flow it meets and pushes the body with it, where the force acts.

```ts
import { Vector3 } from 'three';
import { camberedSailPolar, Foil, Ocean, symmetricFoilPolar, Wind } from '@eulerjs/marine';

const wind = new Wind({ speed: 8 });
const ocean = new Ocean();

const mainsail = boat.addBehavior(
  new Foil({ medium: wind, area: 14, center: new Vector3(0, 3.9, 0.13), pivot: new Vector3(0, 3.88, 1.11), polar: camberedSailPolar() }),
);
const keel = boat.addBehavior(new Foil({ medium: ocean, area: 2, center: new Vector3(0, -1, 1), polar: symmetricFoilPolar({ liftSlope: 3 }) }));

mainsail.angle = 0.6; // trim: turn the sail about the mast
```

## How a foil works out its force

Every step, a foil:

1. turns its chord (and its centre of effort, about its `pivot`) by its `angle`, about its span
   axis, and carries both into the world with the body;
2. finds the flow **relative to the foil**: the fluid's velocity at the centre of effort less the
   body's own velocity there, its spin included. That is the apparent wind for a sail, and for a
   keel, the water rushing past as the boat moves;
3. keeps only the part of that flow **across the span**: flow along a mast or down a keel makes no
   force;
4. measures the **angle of attack**, from 0 to π, between the chord (pointing at the leading edge)
   and the direction the flow comes from;
5. pushes with lift and drag of ½ ρ v² A times the polar's coefficients at that angle, ρ being the
   fluid's density, v the flow's speed across the span and A the foil's area. Drag is along the
   flow; lift is square to the flow and the span, toward the side the flow is not coming from
   (to leeward), as on a flat plate.

The force is applied at the centre of effort, so a sail high on a mast heels the boat as well as
driving it, and a rudder far aft turns it.

## Foil options

| Option | Default | What it is |
| --- | --- | --- |
| `medium` | required | The fluid it works in: a `Wind` for sails, an `Ocean` for keels and rudders, or any `FluidMedium`. |
| `area` | required | Planform area, in m². |
| `center` | required | Where the force acts at angle 0, the centre of effort, in the body's frame. |
| `polar` | required | Its lift and drag coefficients against the angle of attack. |
| `pivot` | `center` | The point it turns about (a mast, a rudder post), in the body's frame. The centre of effort swings around it with the angle. |
| `spanAxis` | +y | The axis it turns about, in the body's frame. |
| `chordAxis` | +z | The way its leading edge points at angle 0, in the body's frame; made square to the span. |
| `angle` | `0` | How far the chord is turned about the span axis, in radians. |

`medium`, `area`, `polar` and `angle` are properties you can change at any time. A chord along the
span throws a `RangeError`, since such a foil has no chord to speak of.

After each step a foil reports what it did, for instruments, telltales or tests:

- `lastForce`: the force it applied, in world space;
- `lastCenter`: where it acted, in world space;
- `lastAngleOfAttack`: in radians, from 0 to π;
- `lastFlowSpeed`: the speed of the flow across its span, in m/s: the apparent wind's, for a sail.

`foil.computeForce(body, time, target)` works the force out without applying it (and updates the
`last…` fields), which is how you can ask what a trim would do before setting it.

## Trimming, steering

Trimming a sail, and turning a rudder, is setting the foil's `angle`. With the default axes (span
+y, chord +z), a positive angle turns the leading edge toward +x, and so swings whatever is
behind the pivot, a boom or a rudder blade, toward −x. Ease a sail out to leeward and it drives
the boat forward; sheet it to the windward side and it drives far less. The sailboat example
moves each angle at a limited rate while a key is held, and clamps it:

```ts
import { MathUtils } from 'three';

const MAXIMUM_SAIL_ANGLE = MathUtils.degToRad(80);
const TRIM_RATE = MathUtils.degToRad(40); // radians a second

function trim(sail: Foil, direction: -1 | 0 | 1, frameDelta: number): void {
  sail.angle = MathUtils.clamp(sail.angle + direction * TRIM_RATE * frameDelta, -MAXIMUM_SAIL_ANGLE, MAXIMUM_SAIL_ANGLE);
}
```

Its rudder turns up to 35° at 60° a second and recentres at 45° a second when let go. In its frame
(+z toward the bow, +y up), a positive rudder angle turns the boat to starboard.

::: tip Where to put the pivot
For a sail, the pivot is the mast (or, for a jib, the tack, with `spanAxis` along the forestay),
and the centre of effort the sail's centroid, behind it: trimming then swings the force round the
mast as the boom swings. For a rudder, the pivot is the rudder post at its leading edge, and the
centre a quarter of the chord behind it. A keel doesn't turn, so it needs neither.
:::

## Keels and rudders

A keel is a foil in the `Ocean`. The ocean's water is still, so the flow a keel meets is only the
boat's own motion through it. Sailing, a boat slips a little sideways (leeway), the keel meets the
water at a small angle, and its lift pushes back against the slip far harder than its drag holds
the boat back: that is what lets a boat sail across the wind, and even toward it, instead of being
blown sideways.

Where the keel's centre is matters as much as its size. The sailboat's keel fin is centred at
z = 0.1, but the hull's forefoot pulls the centre of lateral resistance forward, so its keel foil
is put at z = 1: there the boat holds a beam reach with almost no rudder. Where the keel's force
acts against where the sails' do decides which way a boat turns by itself, so this is the number
to tune when a boat of yours needs a lot of rudder to sail straight.

## Polars

A polar is a foil's lift and drag coefficients against its angle of attack: anything with
`liftCoefficient(angleOfAttack)` and `dragCoefficient(angleOfAttack)`, the angle from 0 to π. Past
π/2 the flow arrives from the trailing edge, and lift normally changes sign.

### camberedSailPolar

A cambered sail: some lift even with the flow along the chord, from the sail's curve, rising until
it stalls around 20° and then behaving like a flat plate, with drag that stays low until stall.
Lift to drag peaks around 6, which is what lets a boat sail about 45° off the wind.

| Option | Default | What it is |
| --- | --- | --- |
| `zeroAngleLift` | `0.3` | Lift with the flow along the chord. |
| `liftSlope` | `3.8` | dCl/dα before stall, per radian: below 2π, since a sail's aspect ratio is about 3. |
| `maximumLift` | `1.5` | The most lift the sail can make. |
| `stallAngle` | 18° | Where the flow starts to separate, in radians. |
| `stallBlend` | 12° | Width of the blend into flat-plate behaviour past stall, in radians. |
| `zeroLiftDrag` | `0.05` | Drag at zero lift. |
| `inducedDragFactor` | `0.12` | Induced drag as a multiple of Cl², 1 / (π e AR). |

### symmetricFoilPolar

A symmetric foil, such as a keel, a rudder or a centreboard: thin-airfoil lift before stall,
blending into a flat plate's (Cl = sin 2α, Cd = 2 sin² α) past it. It works the same whichever
edge leads, lift changing sign past 90°.

| Option | Default | What it is |
| --- | --- | --- |
| `liftSlope` | 2π | dCl/dα before stall, per radian: 2π for a thin foil of infinite span, less for short, stubby ones. |
| `stallAngle` | 15° | Where the flow starts to separate, in radians. |
| `stallBlend` | 10° | Width of the blend past stall, in radians. |
| `zeroLiftDrag` | `0.008` | Drag at zero lift. |
| `inducedDragFactor` | `0.1` | Induced drag as a multiple of Cl². |

The sailboat's keel has `liftSlope: 3` (its fin is short and deep in chord) and its rudder
`liftSlope: 3.5`.

### sailPolar

The sail polar of the three-sails demo this engine came out of, a table of lift and drag for
every degree, used there for both the mainsail and the jib. It has too much drag to sail upwind
(its drag at zero angle is about 0.39), so the sailboat example uses `camberedSailPolar` instead;
it is kept for matching the old demo.

### TablePolar

Your own polar, from measurements or a model: 181 lift and 181 drag coefficients, one per degree
from 0° to 180°, linearly interpolated in between. Anything else throws a `RangeError`.

```ts
import { MathUtils } from 'three';
import { TablePolar } from '@eulerjs/marine';

const degrees = Array.from({ length: 181 }, (_unused, degree) => degree);
const flatPlate = new TablePolar(
  degrees.map((degree) => Math.sin(2 * MathUtils.degToRad(degree))),
  degrees.map((degree) => 2 * Math.sin(MathUtils.degToRad(degree)) ** 2),
);
```

Or implement `Polar` directly, with two functions of the angle.

## Wind and other fluids

`Wind` is a steady, uniform wind: `speed` (13 m/s), blowing toward `angle` (1.3 radians, from +x
toward +z), through air of `density` (1.293 kg/m³, sea level). Change any of them while it blows;
the sailboat's compass turns `angle`.

The wind that drives the sails and the wind that raised the sea are separate: `Wind` pushes on
foils, while a `SpectralWaves` sea has its own `windSpeed` and `windAngle`, which use the same
angle convention. Keep them together if you want waves that run with the wind, as the sailboat
does by turning its sea to the wind (see [Changing the sea while it
runs](./spectral-sea#changing-the-sea-while-it-runs)).

A foil asks its medium only for a `density` and a `velocityAt(point, time, target)`, the
`FluidMedium` interface, so other fluids are a few lines. A river's current, for a keel or a
paddle:

```ts
import type { FluidMedium } from '@eulerjs/marine';

const river: FluidMedium = {
  density: 1000,
  velocityAt: (_point, _time, target) => target.set(1.5, 0, 0), // 1.5 m/s toward +x
};
```

Or a wind that gusts, built on a `Wind`:

```ts
import type { Vector3 } from 'three';
import type { FluidMedium, Wind } from '@eulerjs/marine';

class GustyWind implements FluidMedium {
  constructor(private readonly steady: Wind) {}

  get density(): number {
    return this.steady.density;
  }

  velocityAt(point: Vector3, time: number, target: Vector3): Vector3 {
    const gust = 1 + 0.25 * Math.sin(0.4 * time + 0.01 * point.x);
    return this.steady.velocityAt(point, time, target).multiplyScalar(gust);
  }
}
```

## The sailboat example

`examples/sailboat` is a cruiser about 8.5 m long, built only on the public API, and it is a good
template for a boat of your own. Its body is one rigid body, floated by its voxelised hull, driven
by two sails and held on course by a keel and a rudder. Condensed from its `boat/sailboatPhysics.ts`
and `boat/sailboatLayout.ts`:

```ts
import { Vector3 } from 'three';
import { Body, ConvexCollider, MassProperties, Voxels } from 'eulerjs';
import { Buoyancy, camberedSailPolar, Foil, symmetricFoilPolar } from '@eulerjs/marine';

// the hull mesh is open at the deck, so its mass comes from its voxels, plus the lead in the keel
const voxels = Voxels.fromGeometry(hullGeometry, { cellSize: 0.25 });
const massProperties = voxels.massProperties(2700).combine(MassProperties.point(1800, new Vector3(0, -1.35, 0.1)));
const boat = world.addBody(new Body({ massProperties, position, object: boatModel, voxels, colliders: [new ConvexCollider({ points: hullPoints, friction: 0.3 })] }));

boat.addBehavior(new Buoyancy({ ocean, linearDrag: 0.25, angularDrag: 1 }));
const sailPolar = camberedSailPolar();
const mainsail = boat.addBehavior(
  new Foil({ medium: wind, area: 14, center: new Vector3(0, 3.9, 0.13), pivot: new Vector3(0, 3.88, 1.11), polar: sailPolar }),
);
const jib = boat.addBehavior(
  new Foil({ medium: wind, area: 16, center: new Vector3(0, 3.95, 2.45), pivot: new Vector3(0, 0.59, 4.58), spanAxis: new Vector3(0, 9.76, -3.25).normalize(), polar: sailPolar }),
);
const keel = boat.addBehavior(new Foil({ medium: ocean, area: 2, center: new Vector3(0, -1, 1), polar: symmetricFoilPolar({ liftSlope: 3 }) }));
const rudder = boat.addBehavior(
  new Foil({ medium: ocean, area: 0.65, center: new Vector3(0, -0.83, -3.01), pivot: new Vector3(0, -0.83, -2.86), polar: symmetricFoilPolar({ liftSlope: 3.5 }) }),
);
```

A few choices in it worth copying:

- **Mass from voxels, plus ballast.** 2.7 t of hull and rig spread through the hull's volume and
  1.8 t of lead as a point low in the keel, which keeps the centre of mass low enough to stand up
  to the sails.
- **A collider that isn't the mesh.** The hull mesh runs up the mast, so the boat collides as the
  convex hull of its vertices below the deck and cabin top (1.1 m), not as a tall invisible pyramid
  up to the masthead. It stops at rocks and shoves drifting crates aside.
- **Dropped at its waterline.** It starts at the sea's height where it is put, plus how far its
  origin sits above the waterline, so it doesn't fall in and bob for its first seconds.
- **A world at 120 steps a second**: `new World({ timestep: 1 / 120 })`.

Its headless tests sail it: it floats level at its own displacement in calm water, holds a beam
reach at 2 to 4 m/s with almost no rudder, makes ground to windward 50° off the wind, can't sail
straight into it, answers the rudder both ways, and stands up to 25 knots of wind in waves
without capsizing.

## Limitations

- A foil doesn't know whether it is in its fluid: a keel lifted clear of the water by a wave, or a
  sail dipped into it, still works as before.
- The flow is steady and the force acts at one point: no twist up the sail, no sail shadowing
  another, no wind gradient with height, no unsteady effects such as a sail flogging.
- The ocean's water doesn't move, so there are no currents unless you give a foil a `FluidMedium`
  of your own.

## See also

- [Buoyancy](./buoyancy): what holds the boat up
- [The spectral sea](./spectral-sea): the waves it sails on, and turning them with the wind
- [Overview](./): the rest of `@eulerjs/marine`
- [Examples](/examples/): the sailboat
