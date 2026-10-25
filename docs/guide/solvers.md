# Solvers and stepping

This page is about how a world is simulated: the backend that does it, the two solvers the
built-in backend offers, and the settings that trade speed for accuracy.

## Backends

What actually simulates a world is its backend. The world, its bodies and its joints are the same
whatever the backend; the backend keeps its own copy of every body, and each step the world:

1. writes into it the poses and velocities you changed, wake and sleep requests, and the forces
   gathered during the step;
2. asks it to step;
3. reads every body's motion and sleep state back.

So the solver can be replaced (by a new algorithm, or a WebAssembly engine) without changing code
written against `World` and `Body`. A world's backend is chosen when it is made:

```ts
import { JavaScriptBackend, World } from '@eulerjs/core';

const world = new World({ backend: new JavaScriptBackend() }); // the default
console.log(world.backend.name); // 'javascript'
```

The built-in `JavaScriptBackend`, in plain JavaScript, integrates bodies with semi-implicit Euler
and an exact gyroscopic term (the implicit midpoint rule), finds which colliders may touch by
sweep and prune, works out their contacts with exact or GJK-based tests, and solves joints and
contacts with one of two solvers. Scene queries search a bounding volume tree of the colliders.

Any other backend implements the `PhysicsBackend` interface. The repository's
`packages/core/test/conformance` suite is what every backend must pass: it checks physics (fall,
bounce, friction, pendulum period, stacking, sleeping) against closed-form answers, with
tolerances any sound method meets.

## Soft step and XPBD

```ts
const softStep = new World({ backend: new JavaScriptBackend() }); // solver: 'soft-step', the default
const positionBased = new World({ backend: new JavaScriptBackend({ solver: 'xpbd' }) });
```

### Soft step (the default)

Soft step (Erin Catto's, from Box2D v3) works on velocities throughout. On each substep, bodies
take the forces; then the impulses each constraint ended the last substep with (warm starting);
then a pass of impulses that pulls every joint and contact back as a stiff, damped spring;
positions move; and a last pass takes out the speed the pull added. Each constraint's impulse
carries over from step to step, which is what lets stacks rest perfectly still.

Contacts are springs of up to 30 Hz (twice that against bodies that don't move), heavily damped so
that a body pushed out of another comes to rest without bouncing; joints are as stiff as the
substeps allow, so they stretch less with more substeps.

### XPBD

XPBD (extended position-based dynamics, Müller et al. 2020) moves the bodies apart rather than
pushing on their velocities, then works the velocities out from how far they moved. Its joints and
contacts give less under load.

::: warning XPBD is behind
Soft step is where eulerjs's work goes, and XPBD lags it. Its contacts are objects made afresh
every step rather than rows of flat arrays, so it is the slower solver, slower than cannon-es on
an awake pile of boxes; bodies that only touch sleep one by one rather than as a pile; and its
stacks creep. It is kept for what it does better, the stiff joints and contacts below, but choose
it only for that.
:::

### Which to choose

| | Soft step | XPBD |
| --- | --- | --- |
| Energy | Kept far better: a pendulum loses 0.02% per swing | A pendulum loses 6% per swing |
| Stacks that may not sleep | Stand still | Tall ones give way after a few seconds |
| Speed on piles of boxes and spheres | 20 to 40% faster | |
| Under load | A light body squeezed under a heavy one sinks in a little; ragdoll joints open by up to 1.5 cm | Contacts and joints give less; ragdoll joints open by up to 6 mm |
| Ball-joint friction | Holds | Acts on velocities only, so creeps under a steady load |
| Orientation drives | Reach their target more slowly | Reach it faster |

Soft step is the default because most scenes are full of things resting on other things
(stacks, piles, furniture), where steadiness and speed matter most, and because it keeps the
energy of swinging and spinning things. Choose XPBD for scenes dominated by heavily loaded joints
and contacts that must not give, such as ragdolls that must stay tight, a heavy body standing on
a light one, or a machine of stiff linkages.

The `solvers` example in `examples/basics` runs the same stack and pendulum under both side by
side.

## Timestep

`timestep` is the length of one fixed step: 1/60 s by default, set when the world is made.

```ts
const world = new World({ timestep: 1 / 120 });
```

Shorter steps make everything more accurate and cost proportionally more. Most of what a smaller
timestep would buy comes more cheaply from substeps (below), so change it only when something
needs to run more often as a whole: behaviours such as buoyancy, sails and vehicles run once per
step, not per substep.

See [Getting started](./getting-started#the-render-loop) for how `world.update` fits whole steps
into frames, interpolates between them, and caps catching up with `maxStepsPerFrame` (8 by
default; a property you can change).

## Substeps

`substeps` is the accuracy setting. Each step that has joints or contacts to solve is split into
that many substeps; a world with nothing to solve integrates each step in one go.

```ts
const world = new World({ substeps: 8 });
world.substeps = 4; // it can change between steps too
```

- **4**, the default at 60 steps a second, suits games in the browser.
- **8** costs about 40% more and makes joints and contacts stiffer: a pendulum loses 3% of its
  energy per swing instead of 6%, a hanging chain stretches 2 mm instead of 8, and a stack that may
  not sleep drifts 10 times less. Each doubling halves the small energy loss a position-based
  solver has; the pendulum figures are XPBD's, since soft step keeps a pendulum's energy almost
  entirely already.
- **2** is too few for stacks.

The repository's `test/javascript/defaultQuality.test.ts` keeps watch on the default's quality.
Substeps must be a whole number of at least 1.

::: tip Substeps or timestep?
Substeps re-solve the joints and contacts several times within one step, but find contacts and run
behaviours and plugins once. That makes them a much cheaper way to stiffen a scene than a shorter
timestep.
:::

## Determinism

The engine uses no random numbers and no clocks: what happens on a step depends only on the
world's state and settings, bodies and joints are solved in the order they were added, and every
step is exactly `timestep` long. So a world built the same way and stepped the same number of
times, with the same inputs on the same steps, follows the same path on the same JavaScript
engine.

Some things to keep in mind if you rely on that:

- Drive input from inside the step (behaviours, plugins) or with `world.fixedStep()`, not from the
  render loop: how many steps a frame runs depends on the frame rate.
- `maxStepsPerFrame` drops time on slow frames, so two machines running `world.update` with real
  frame times end up at different simulated times. Compare by `world.stepCount`, not wall-clock
  time.
- Floating-point maths functions such as `Math.sin` and `Math.exp` aren't required to give
  identical last bits in every JavaScript engine, so different browsers can drift apart over a
  long run. Lockstep networking across browsers needs more than the engine alone gives.

## See also

- [Performance](./performance): what the settings cost, and the benchmarks.
- [Joints](./joints): drives, friction and how they behave under each solver.
- [Extending eulerjs](./extending): the step order, for behaviours and plugins.
