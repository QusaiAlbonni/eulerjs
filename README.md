<p align="center"><img src="docs/public/logo.png" width="180" alt="eulerjs: Euler's e standing on the three.js logo"></p>

# eulerjs

Rigid body physics for three.js, written in TypeScript. You create a `World` next to your three.js
scene, bind bodies to your `Object3D`s and step it in your render loop.

**[Documentation](https://qusaialbonni.github.io/eulerjs/)** · **[Live examples](https://qusaialbonni.github.io/eulerjs/examples/)** · **[API reference](https://qusaialbonni.github.io/eulerjs/api/)**

- **Exact mass properties for any closed mesh**: mass, centre of mass and the full inertia tensor
  integrated from the triangles, not approximated by a bounding box. Open meshes are rejected with
  an explanation instead of silently giving origin-dependent numbers.
- **Correct rotational dynamics**: the gyroscopic term is integrated with the implicit midpoint
  rule, so tumbling bodies keep their energy and angular momentum (an uneven box spun about its
  middle axis flips over, as it should).
- **Built around three.js**: bodies read their starting pose from objects, write interpolated
  poses back to them, and use three's math types throughout.
- **Plugins** that hook into each step, and **behaviours** that act on one body, for everything
  that isn't core. `@eulerjs/marine` (waves, buoyancy, sails, keels, rudders) is the first one.

Collision covers spheres, boxes, capsules, cylinders, cones, planes, convex hulls and heightfield
terrain, with triangle meshes in the `@eulerjs/bvh` plugin. There are ray casts, shape casts and
overlap tests, contact and sensor events, and hinge, slider, fixed, cone-twist, general
six-degree-of-freedom and distance joints with limits, motors, friction, orientation drives (for
active ragdolls) and breaking, and ray-cast vehicles in the `@eulerjs/vehicle` plugin. `TODO.md`
lists what is still to come.

## Why eulerjs

**It gets the physics right.** A stack of boxes stands: kept awake for a minute, the top of an
eight-box stack moves 12 mm at most, where cannon-es's falls over. A box on a slope slides at the
acceleration the textbook gives, to the decimal; in cannon-es it doesn't slide at all. A ball
bounces back to the height its restitution says, within 2%. A rock's inertia is integrated from
its hull, not guessed from its bounding box, which cannon-es gets seven times too large.

**It's fast where it counts.** Real scenes are mostly at rest, and eulerjs puts what's at rest to
sleep and keeps it asleep, and still scenery costs next to nothing: a settled pile of boxes costs
a sixtieth of cannon-es's, a city full of props a thirtieth. Convex hulls collide eight times
faster. And with a crowd of ragdolls all awake and walking, it is still the faster of the two.

**It's three.js through and through.** Give it a mesh and it works out the body: mass, centre of
mass, inertia, colliders. It moves your meshes for you, interpolated between fixed steps, and
instanced meshes are bodies too. There are joints with motors, springs and drives for active
ragdolls, scene queries and sensor events, and plugins for an FFT sea to the horizon, sails,
cars and triangle meshes.

### Against cannon-es

The same scenes in both engines, at 60 steps a second, with the same friction, pair finding and
sleep thresholds; each engine keeps its own solver defaults (eulerjs soft step with 4 substeps,
cannon-es 10 Gauss-Seidel iterations). Milliseconds of computing per simulated second, on a Ryzen 5
4600H in Node 24: lower is better. From `npm run bench` (`packages/core/bench/cannon.test.ts`,
`examples/city/bench/cannon.test.ts`).

| Scene | eulerjs | cannon-es | |
| --- | ---: | ---: | --- |
| 125 boxes falling into a pile | 235 ms | 259 ms | eulerjs 1.1× faster |
| 125 boxes in a pile, never sleeping | 233 ms | 255 ms | eulerjs 1.1× faster |
| 125 boxes settled, same sleep thresholds | 4 ms | 246 ms | **eulerjs 59× faster** |
| 400 spheres spread out, never sleeping | 127 ms | 130 ms | about even |
| 400 spheres, same sleep thresholds | 15 ms | 66 ms | eulerjs 4.3× faster |
| 64 rocks (42-corner hulls), never sleeping | 752 ms | 6168 ms | **eulerjs 8× faster** |
| The city, at rest (52 props) | 4 ms | 121 ms | **eulerjs 30× faster** |
| The city, 25 ragdolls walking (327 bodies) | 444 ms | 722 ms | eulerjs 1.6× faster |
| The city, 100 ragdolls walking (1152 bodies) | 2282 ms | 2771 ms | eulerjs 1.2× faster |

| Accuracy (0 or the stated value is perfect) | eulerjs | cannon-es |
| --- | ---: | ---: |
| Top of a 3-box stack kept awake, furthest it moves in 60 s | 0.7 mm | 2.7 m (falls) |
| Top of an 8-box stack kept awake, furthest it moves in 60 s | 11.8 mm | 9.5 m (falls) |
| Box sliding down a slope, acceleration error | 0.0% | −100% (stuck) |
| Ball bounced from 3 m, height error | −1.8% | +13.1% |
| A rock's moment of inertia (9.14 is right) | 9.14 | 66.7 |
| A box resting on the ground, how far it sinks | 0.07 mm | 0.00 mm |

Where cannon-es wins: its boxes rest exactly on the ground where eulerjs's sink by 0.07 mm, and
in the city its ragdolls' joints open up less (5 mm against 15 at most), though they have no
drives to walk with; a field of awake spheres, the simplest contacts there are, costs the two
about the same. The rows with ragdolls were measured before eulerjs stopped visiting still bodies
on every step, which makes no measurable difference to scenes this awake. Timings depend on the
machine, so measure your own scenes too: `npm run bench`.

## Packages

| Package | What it is |
| --- | --- |
| `@eulerjs/core` | `World`, `Body`, `MassProperties`, `Voxels`, colliders, joints, the JavaScript backend, the plugin, behaviour and backend interfaces |
| `@eulerjs/marine` | `SumOfSines` and `SpectralWaves` seas, `Ocean`, `Wind`, `Buoyancy`, `Foil` and polars, `WaterMesh`; `SpectralWater` in `@eulerjs/marine/webgpu` |
| `@eulerjs/bvh` | `MeshCollider`: any triangle mesh as a static or kinematic collider, on three-mesh-bvh |
| `@eulerjs/vehicle` | `RaycastVehicle`: wheels on springs under a chassis, with tyres that grip up to a limit or slip tyres on a tyre curve, on any ground |

All need `three` 0.166 or later as a peer dependency, except `@eulerjs/marine/webgpu`, the
spectral sea's water, which needs 0.186 or later.
`@eulerjs/bvh` also needs `three-mesh-bvh` 0.9 or later. Plugins that add collider
shapes build on `@eulerjs/core/extend`.

## Using it

```ts
import * as THREE from 'three';
import { World } from '@eulerjs/core';

const world = new World(); // gravity (0, -9.81, 0), 60 fixed steps per second

const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), material);
crate.position.set(0, 5, 0);
scene.add(crate);
world.addBody(crate, { density: 500, collider: 'box' }); // mass and starting pose from the mesh, a box fitted round it

const timer = new THREE.Timer();
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  world.update(timer.getDelta()); // fixed steps, then interpolated poses into the meshes
  renderer.render(scene, camera);
});
```

- `world.addBody(object, options)` computes exact mass properties from the object's meshes (all
  of them, for a group), using `mass` or `density` (water's, 1000 kg/m³, when neither is given).
  What it collides as is up to you, and on purpose has no default: `collider: 'box'`, `'sphere'`,
  `'convex'` and so on fit a shape round the meshes. Without `collider` the body collides with
  nothing, since the mesh drawn is seldom the shape to collide as.
  Use `shape: 'voxels'` for meshes that aren't closed. `world.addBody(new Body({ ... }))` is there
  when you want to give the mass properties yourself.
- Push bodies with `applyForce(force, worldPoint?)`, `applyForceAtLocalPoint`, `applyTorque` and
  `applyImpulse`. `world.bodyOf(mesh)` finds the body behind a raycast hit.
- Add per-body logic with `body.addBehavior({ fixedUpdate(body, timestep, world) { ... } })` and
  world-level logic with `world.use(plugin)` (hooks: `beforeStep`, `applyForces`, `afterStep`).
- `world.renderTime` is the moment the meshes are drawn at, for animating anything that should
  match them.

### Many alike: instancing

```ts
const chairs = new InstancedMesh(chairGeometry, chairMaterial, 200);
for (let index = 0; index < 200; index++) chairs.setMatrixAt(index, placements[index]);
scene.add(chairs);
const bodies = world.addInstances(chairs, { mass: 4, collider: 'box' }); // one body per instance

const hit = raycaster.intersectObject(chairs)[0];
const body = hit && world.bodyOf(hit.object, hit.instanceId);
```

- `world.addInstances(mesh, options)` makes a body for every instance of an InstancedMesh,
  posed where the instance is, fitted (`collider: 'box'` and the rest, or a function making each
  instance's colliders) and weighed from the mesh's geometry, an instance's scale included. Each
  body draws itself as its instance, interpolated between steps like a bound object, so hundreds
  of props cost one draw call.
- A body that sleeps writes its instance once and then leaves it alone, so a still scene uploads
  nothing; three.js is told the mesh's bounds have changed whenever an instance moves, so it
  doesn't cull it wrongly.
- `new Body({ instance: { mesh, index } })` binds one body to one instance yourself.
  `world.addBody(instancedMesh)` refuses, since it would make one body of them all.

### Collisions and joints

```ts
import { Body, CapsuleCollider, DistanceJoint, PlaneCollider, SphereCollider, World } from '@eulerjs/core';

world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.8 }) });
world.addBody(crate, { density: 300, collider: 'box' }); // fitted to the mesh, as 'sphere', 'cylinder' and so on are
world.addBody(ball, { collider: new SphereCollider({ radius: 0.35, restitution: 0.6 }) });
world.addBody(new Body({ colliders: [new CapsuleCollider({ radius: 0.1, length: 0.3 })], mass: 4 })); // weighed from its colliders

world.addJoint(new DistanceJoint({ bodyA: lamp, anchorA: hook, anchorB: ceilingPoint, slack: true }));
```

- Colliders are classes (`SphereCollider`, `BoxCollider`, `CapsuleCollider`, `CylinderCollider`,
  `ConeCollider`, `PlaneCollider`, `ConvexCollider`, `HeightfieldCollider`, and `MeshCollider`
  from `@eulerjs/bvh`) with an offset and rotation in the body, friction, restitution, rolling
  resistance and collision groups;
  `collider: 'box' | 'sphere' | 'convex' | 'cylinder' | 'cone' | 'capsule'` is shorthand for one
  fitted around the mesh (round shapes standing along y, as three.js's geometries do). A convex
  collider's mass properties are exact for its hull. Keep hulls to about 32 corners: their cost
  grows with the number of edges.
- A dynamic `Body` without `massProperties` is weighed from its solid colliders, at a `density`
  (water's, unless given) or to a total `mass`; a body made from a mesh that isn't closed is
  weighed by its colliders too.
- Cylinders and cones have exact mass properties and ray casts, and exact contacts with planes
  (and, for cylinders, spheres), so a barrel rolls smoothly on the ground; against other shapes
  they collide as a 16-sided prism around the round shape.
- `HeightfieldCollider` is terrain from a grid of heights, solid below the surface (to
  `thickness`, 1 m under its lowest point by default), so whatever sinks into it is pushed back
  up. `MeshCollider` makes any triangle mesh a collider, solid on both sides. In both, the edges
  between nearly flat neighbouring triangles never push on their own, so bodies slide and roll
  across them without catching. Both are for static and kinematic bodies, and `toGeometry()`
  gives back their triangles, to draw exactly what things collide with.
- `world.substeps` is the accuracy setting. The default, 4 at 60 steps a second, suits games in
  the browser. 8 costs about 40% more and makes joints and contacts stiffer: a pendulum loses
  3% of its energy per swing instead of 6%, a hanging chain stretches 2 mm instead of 8, and a
  stack that may not sleep drifts 10 times less. 2 is too few for stacks.
  `test/javascript/defaultQuality.test.ts` keeps watch on the default's quality.
- Joints can let the bodies they tie pass through each other (`collideConnected: false`, or
  `'unlessOverlapping'` to decide from whether they overlap when the joint is added, as a thigh
  and a shin do at the knee), and `world.setCollisionsBetween(bodyA, bodyB, false)` stops any two
  bodies colliding, such as a ragdoll's limbs one joint apart.
- Bodies that have been still for half a second fall asleep and cost almost nothing until
  something wakes them (a hit, a force, a new pose, velocity or collider). Opt out with
  `canSleep: false`. Bodies joined by joints sleep together, and a body touching one that won't
  sleep (a `canSleep: false` lift, a moving kinematic platform) stays awake, so it rides along.
- `world.contacts` lists the contacts that pushed during the last step; `normalImpulse /
  world.timestep` is the force each one carried.
- `world.on('contactBegin' | 'contactEnd' | 'sensorEnter' | 'sensorExit' | 'jointBreak', listener)`
  calls you after each step, and returns a function that stops it. Bodies asleep together still
  count as touching. A collider with `sensor: true` notices what overlaps it without pushing it
  (a trigger volume), and adds no mass; `world.inSensor(sensor)` lists what is in it now.
- Friction is Coulomb's, decided for each patch of contact (such as a box's face on the floor),
  so boxes stay put on slopes gentler than their friction angle and tall stacks stand still.
  Spheres and capsules roll without slipping or sinking in, and with `rollingResistance` they
  slow down and come to rest, as a real ball does, instead of rolling for ever.

### Scene queries

```ts
const hit = world.castRay(muzzle, aim, { maxDistance: 100, exclude: player });
if (hit) hit.body.applyImpulse(aim.clone().multiplyScalar(5), hit.point);

const ground = world.castShape(new CapsuleCollider({ radius: 0.3, length: 1 }), feet, down, { maxDistance: 0.2 });
const caught = world.overlap(new SphereCollider({ radius: 4 }), blastCentre);
```

- `castRay` finds the nearest collider along a ray, `castRayAll` every one, nearest first, each
  with the distance, the point and the surface normal there. A ray starting inside a solid meets
  it at once.
- `castShape` slides any convex shape along a line until it first touches something, for moving
  characters and checking that things fit; `overlap` lists what a shape overlaps. Both measure
  distances exactly with GJK, round shapes included.
- All of them take collision groups (`collidesWith`), bodies to `exclude`, a `filter` function, and
  `includeSensors` (sensors are skipped otherwise), and see bodies where they are, including ones
  you moved by hand since the last step. They search a bounding volume tree of the colliders;
  noticing hand-moved bodies costs a look at every body, about 10 ns each, per query.

### Joints

```ts
import { ConeTwistJoint, FixedJoint, HingeJoint, SixDofJoint, SliderJoint, TargetJoint } from '@eulerjs/core';

world.addJoint(new HingeJoint({ bodyA: frame, bodyB: door, anchor: hingePoint, axis: up, limits: { lower: 0, upper: 1.6 } }));
world.addJoint(new HingeJoint({ bodyA: car, bodyB: wheel, anchor: hub, axis: axle, motor: { targetVelocity: 20, maxForce: 300 } }));
world.addJoint(new SliderJoint({ bodyA: shaft, bodyB: lift, anchor: base, axis: up, motor: { targetPosition: 3, stiffness: 5e4, damping: 4e3 } }));
world.addJoint(new ConeTwistJoint({ bodyA: chest, bodyB: upperArm, anchor: shoulder, axis: down, swingLimit: 1.2, twistLimits: { lower: -0.5, upper: 0.5 } }));
world.addJoint(new FixedJoint({ bodyA: wall, bodyB: shelf, anchor: bracket, breakForce: 2000 }));
world.addJoint(new HingeJoint({ bodyA: box, bodyB: lid, anchor: back, axis: side, friction: 5 })); // stays where it is opened
const grab = world.addJoint(new TargetJoint({ body: crate, anchor: handle, frequency: 4, maxForce: 800 }));
grab.setTarget(pointer); // drag it with the mouse
```

- Every joint but `DistanceJoint` is a `SixDofJoint`: a frame on each body, and for each of the
  six ways one can move against the other (along its three axes, twisting about its own axis,
  swinging about the other two) whether it is `'locked'`, `'free'` or limited to
  `{ lower, upper }`, plus an optional drive. Hinges, sliders, fixed and cone-twist joints are
  settings of it, with friendlier names; a joint to the world measures how body A moves in it.
  Frames default to where the bodies are when the joint is made, its x axis along `axis`.
- A drive is a spring-damper with a force limit: `targetVelocity` alone makes a motor,
  `targetPosition` with a `stiffness` (and some `damping`) a servo. Any stiffness is stable.
  Instead of a stiffness, give a `frequency` (Hz) and `dampingRatio`, and the engine works out the
  stiffness from what the axis moves, turning about the joint's point if it holds one.
- `orientationDrive` (on a `SixDofJoint` or `ConeTwistJoint`) turns the moving frame toward a
  target orientation in the base frame, about whichever axis gets it there: a muscle, for active
  ragdolls. `friction` (N·m) and `linearFriction` (N) make the joint's free axes resist moving, as
  stiff joints and tensed muscles do; a ball joint resists turning every way alike. Under XPBD a
  ball joint's friction acts on velocities only, so it creeps a little under a steady load.
- `TargetJoint` pulls a body toward a pose in the world as a spring with force and torque limits:
  dragging and carrying things, or leading an active ragdoll by its hips. Move it with `setTarget`.
- `breakForce` and `breakTorque` break a joint that carries more: the world removes it, marks it
  `broken` and sends `jointBreak`. Every joint reports the `force` and `torque` it carried on the
  last step.
- Both solvers simulate every joint.

`npm run bench` prints step costs for a few standard scenes and how steady stacks stay, what
queries, terrain, meshes, round shapes, joints and events cost, compares them with cannon-es (see
[Against cannon-es](#against-cannon-es)), and runs the city example with a crowd of 0 to 100
ragdoll pedestrians, alone and against the same city rebuilt in cannon-es, with the ragdolls'
joints and limits matched by cannon-es's cone-twist and hinge constraints. The eulerjs walkers are
driven by their joints' drives, which cost more than the forces that pull the cannon-es ones along
(cannon-es has no joint drives). XPBD is slower than soft step: in an awake pile of boxes,
cannon-es is 1.2 to 1.4 times faster than XPBD, where soft step is 1.1 to 1.2 times faster than
cannon-es.

### Backends

What actually simulates a world is its backend, so the solver can be replaced, by a new
algorithm or a WebAssembly engine, without changing code written against `World` and `Body`:

```ts
import { JavaScriptBackend, World } from '@eulerjs/core';

const world = new World({ backend: new JavaScriptBackend() }); // the default
```

The built-in `JavaScriptBackend` integrates with semi-implicit Euler and an exact gyroscopic
term, and solves joints and contacts by soft step (Catto, Box2D v3): velocity impulses that
carry over from step to step, with every constraint a stiff, damped spring. A backend implements
`PhysicsBackend`: it keeps its own copy of every body, and the world writes the poses and
velocities you changed and the forces gathered during a step into it, steps it, then reads the
results back. Edit a body between steps or inside a behaviour and the change reaches the backend
before it simulates. `test/conformance` is the suite every backend must pass; it checks physics
(fall, bounce, friction, pendulum period, stacking, sleeping) against closed-form answers, with
tolerances any sound method meets.

`new JavaScriptBackend({ solver: 'xpbd' })` solves them instead with XPBD (Müller et al. 2020),
moving the bodies apart rather than pushing on their velocities. Soft step keeps energy far
better (a pendulum loses 0.02% per swing to XPBD's 6%), holds stacks that may not sleep still
where XPBD's tall ones give way after a few seconds, and is 20 to 40% faster on piles of boxes
and spheres. XPBD's contacts and joints give less under load: soft step's let a light body
squeezed under a heavy one sink in a little, and ragdoll joints open by up to 1.5 cm to XPBD's
6 mm. `npm run bench:xpbd` runs the benchmarks with XPBD.

### Floating and sailing with @eulerjs/marine

```ts
import { Buoyancy, camberedSailPolar, Foil, Ocean, Wind } from '@eulerjs/marine';
import { SpectralWater } from '@eulerjs/marine/webgpu';

const ocean = new Ocean(); // a spectral sea, a strong breeze's
const water = new SpectralWater(ocean.waves); // the same surface the physics floats on, with WebGPURenderer
scene.add(water);
// each frame: water.update(renderer, world.renderTime, camera.position, camera);

const boat = world.addBody(hull, { mass: 4500, shape: 'voxels' }); // works on open hulls too
boat.addBehavior(new Buoyancy({ ocean }));
const mainsail = boat.addBehavior(
  new Foil({ medium: new Wind(), area: 14, center: new THREE.Vector3(0, 3.9, 0.1), pivot: mast, polar: camberedSailPolar() }),
);
mainsail.angle = 0.6; // trim
```

#### A spectral sea, to the horizon

`Ocean`'s sea is a `SpectralWaves` unless it is given another: a sea of hundreds of thousands of waves drawn from the JONSWAP spectrum of a
wind sea (Horvath 2015) and summed by inverse FFT (Tessendorf), in five tiled patches from
512 m down to 1.2 m across, 128 waves across each, so it is as detailed a metre from the camera
as a kilometre away. The physics evaluates the longest of them on the CPU once a step (two 64²
patches, 0.5 ms) and then looks heights up in its grids, about ten times faster than
`SumOfSines`, so from three floating bodies on it costs less. `useWorker` moves that evaluation
off the main thread: `Buoyancy` asks for the next steps' waves ahead, and the worker's are ready
for every step after its first few frames.

The sea follows a wind, from a calm one's ripples at 5 m/s to a gale's waves at 20; `heightScale`
makes its waves larger and wilder than any wind would, and `choppiness` sharpens their crests
until they break. `setSea` changes any of them while the sea runs, each wave keeping its place, so
the sea grows or calms into the new one; `significantWaveHeight` says how high it is now.

```ts
import { Ocean, SpectralWaves } from '@eulerjs/marine';
import { SpectralWater } from '@eulerjs/marine/webgpu';
import SpectralWorker from '@eulerjs/marine/spectral-worker?worker'; // with Vite; any bundler's way of making a module worker will do

const waves = new SpectralWaves({ windSpeed: 11, windAngle: 0.3 });
waves.useWorker(new SpectralWorker());
const ocean = new Ocean({ waves });
waves.setSea({ windSpeed: 22, heightScale: 2.5, choppiness: 1.3 }); // a storm: 11 m waves

const water = new SpectralWater(waves); // every wave of every patch, evaluated on the GPU
scene.add(water);
// each frame, with three/webgpu's WebGPURenderer: the time the bodies are drawn at, and where the sea should be finest
water.update(renderer, world.renderTime, camera.position, camera);
```

`SpectralWater` needs three's `WebGPURenderer`, on WebGPU or on its own WebGL 2 fallback; it
runs its FFT as render passes so that it does both, and matches the CPU's to a few
hundred-thousandths of the waves' size. Given the sky (`environment`, from `PMREMGenerator`) it
shades the sea as a Fresnel mirror of it over the water's colour, the light scattered back
through the crests, and the sun glinting off it. Foam builds on breaking crests, lingers behind
them and fades, as Acerola's sea makes it (github.com/GarrettGunnell/Water): each patch keeps its
own from frame to frame, grown where its surface bunches up past `foamBias` (sooner on its crests,
by `foamPeakLift`), at `foamGrowth`, and fading at `foamDecay`. Drawn, foam piles up on the
waves' peaks (`foamPeakBoost`) and is gone a little way down their faces (`foamLowest`). The
water scatters the sun's light back as his does: through the crests looking toward the sun, off
faces turned to the eye or to the sun, and off the bubbles in it.

The patches repeat, every 512 m at most, so two things run over them that don't: a swell of a
few long waves, 200 m to 1 km, summed where they are (`swellHeight`), and gusts, the shorter
waves scaled up and down over stretches a kilometre or two across (`gustiness`), so that from
afar the sea is rougher here and calmer there as a real one is. Both are in the physics' heights
as in the water drawn. `seaFog(environment)` gives `scene.fogNode` a haze the sky's own colour
that thickens with distance and glows toward the sun, hiding the far sea's sameness and the
horizon's edge. Bodies float relative to the water's own vertical velocity (`riseRate`), not the
surface's at a fixed place, which a steep crest outruns. With `WebGLRenderer`, give the `Ocean` a `SumOfSines` sea and draw it with `WaterMesh`. The sea
repeats exactly every `loopPeriod` (1000 s), which keeps the GPU's single-precision waves on the
physics' however long it runs.

It reaches 262 km around the centre you give it, finest there and coarser with distance, in one
of two layouts, both crack-free (`test/waterLod.test.ts`):

- `lod: 'quadtree'` (the default): CDLOD nodes, one draw call, nodes out of the camera's view
  left out when given the camera, finer or coarser by distance in three dimensions, so from high
  up too.
- `lod: 'rings'`: a geometry clipmap, the same triangles every frame and next to no time to lay
  out, but about three draw calls a level.

On an integrated GPU (Radeon Renoir, WebGL 2 fallback, 1920 × 760) they cost the same on the GPU:
the water is bound by its pixels, and culling, which takes the quadtree's triangles to a third,
barely shows. On the CPU the quadtree's single draw call more than pays for laying it out:

| From | rings, CPU / GPU | quadtree | quadtree, culled |
| --- | --- | --- | --- |
| 2 m | 1.44 / 5.6 ms | 0.83 / 5.4 ms | 0.79 / 5.3 ms |
| 30 m | 0.94 / 6.7 ms | 0.62 / 6.2 ms | 0.46 / 6.1 ms |
| 400 m | 0.86 / 7.0 ms | 0.48 / 6.5 ms | 0.40 / 6.4 ms |

(A whole frame of `examples/ocean`, the sky and the FFT's 2 ms included; the CPU's is laying
the sea out and drawing it.)

## Examples

`examples/basics` (`npm run dev:basics`) has short examples, one idea each, in plain three.js:

| Example | Shows |
| --- | --- |
| `hello` | a world, a body bound to a mesh, and the render loop |
| `tumbling` | exact inertia from meshes; an uneven box flipping when spun about its middle axis |
| `springs` | writing your own `Behavior` (a spring) and `Plugin` (air drag); click to apply impulses |
| `chain` | links pinned together with `DistanceJoint`s |
| `collisions` | a pyramid of crates and balls to throw at it |
| `floating` | buoyancy on a spectral sea with `@eulerjs/marine`, drawn with `SpectralWater` on `WebGPURenderer` |
| `joints` | a self-closing door (hinge, limits, servo), a windmill on a motor, a lift on a slider, a lamp on a cone-twist joint, a bridge of fixed joints that break |
| `queries` | click to cast rays and push what they hit, right-click for a blast found by an overlap test, a capsule that steers itself with shape casts |
| `sensors` | a trigger zone that lights up while anything is in it, and crates that flash when something starts touching them |
| `terrain` | barrels, cones and balls rolling down a heightfield, and a torus knot as a triangle mesh with `@eulerjs/bvh` |
| `solvers` | the same stack and pendulum solved by XPBD and by soft step side by side |

`examples/ocean` (`npm run dev:ocean`) is a spectral sea to the horizon with crates afloat on
it, either layout to switch between and their costs shown; `?compare=1` measures both from three
heights. `gpu-check.html` checks the GPU's waves against the CPU's, and `physics-bench.html` what
floating costs on the main thread and in a worker.

Three complete games are built only on the public API:

- `examples/sailboat` (`npm run dev`): sailing on a spectral sea among rocks that stand on the
  sea floor and crates drifting on the water, which the boat's hull shoves aside, with the sea's
  wind, wave height and choppiness to raise a storm with. On WebGPURenderer, with its own TSL
  post-processing: tone mapped before it blooms, so the sun glows instead of glaring.
- `examples/city` (`npm run dev:city`): a car driving through a city of towers, with crates,
  cones and barrels to knock about, and people walking its pavements. The car is one body on a
  `RaycastVehicle` from `@eulerjs/vehicle`, with an engine, brakes, steering and a handbrake on
  top, so it rolls, leans on its springs, slides and spins out on the handbrake. Each person is
  an active ragdoll of eleven capsules, joined by cone-twist joints at the spine, neck, shoulders
  and hips and hinges at the elbows and knees, all with limits and friction: their joints' drives
  hold the walk's pose and a `TargetJoint` carries their hips along. Knocked down, they go limp,
  fall in a heap without limbs passing through each other, and get up again.

- `examples/wedding` (`npm run dev:wedding`): a wedding in first person. A ceremony lawn with
  an arch, a stage and rows of chairs, and a marquee laid for the reception: round tables set for
  six with plates, flutes, bottles and flowers, a tiered cake, a champagne tower and a pile of
  presents, among fixed hedges, trees, a fountain, lamp posts and the marquee's poles, and helium
  balloons on strings tied to weights. The guest is a capsule body kept upright by an orientation
  drive, walking with a person's push, so they shove chairs aside and lean a table along; they
  shove what they look at, pick things up and carry them on a `TargetJoint`, and throw them.
  Everything starts asleep, as it stands exactly where it is set, and wakes when disturbed.

## Development

```sh
npm install
npm run dev           # the sailboat example on http://localhost:5173
npm run dev:city      # the city driving example
npm test              # all tests
npm run coverage      # tests with coverage thresholds (90% lines)
npm run check         # lint, typecheck, coverage and build, as CI does
npm run docs:dev      # the documentation site, the API reference and the examples, on http://localhost:5173/eulerjs/
npm run docs:examples # rebuild the examples the site serves, after changing one
npm run docs:build    # the whole site, examples and all, into docs/.vitepress/dist
npm run logo          # the logo's three.js scene, to turn round or export again
```

The documentation site is VitePress in `docs/`; the API reference is generated from the sources'
comments by TypeDoc. Pushing to `main` builds the site, the API reference and every example, and
publishes them to GitHub Pages (`.github/workflows/docs.yml`).

The tests check the physics against closed-form answers rather than snapshots: textbook inertia
tensors, the exact discrete free-fall solution, angular momentum and energy over long spins,
floating drafts and stability limits of cubes, and golden values from the three-sails demo
this engine came out of. The sailboat example has headless acceptance tests: it floats at its
own displacement, holds a reach, makes ground upwind, can't sail straight into the wind and
answers the rudder.

## License

MIT
