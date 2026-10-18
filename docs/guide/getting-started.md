# Getting started

This page installs eulerjs, drops a crate onto a floor, and explains what the render loop does
for you and why.

## Installing

```sh
npm install @eulerjs/core three
```

`three` is a peer dependency: eulerjs works with the copy your app already uses, version 0.166 or
later. The plugins are separate packages:

```sh
npm install @eulerjs/marine          # waves, buoyancy, sails
npm install @eulerjs/vehicle         # ray-cast vehicles
npm install @eulerjs/bvh three-mesh-bvh  # triangle-mesh colliders
```

## Hello world

A floor, a crate that falls onto it, and a render loop. Everything physics-related is in the
second half; the first half is ordinary three.js.

```ts
import * as THREE from 'three';
import { PlaneCollider, World } from '@eulerjs/core';

// The usual three.js setup.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(4, 3, 6);
camera.lookAt(0, 1, 0);

// A world: gravity (0, -9.81, 0) and 60 fixed steps per second unless you say otherwise.
const world = new World();

// The floor: a static body colliding as an infinite plane facing up.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x556070 }),
);
scene.add(floor);
world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.8 }) });

// The crate: a dynamic body whose mass, inertia and starting pose come from the mesh, and whose
// collider is a box fitted around it.
const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd08770 }));
crate.position.set(0, 4, 0);
crate.rotation.set(0.4, 0.2, 0.3);
scene.add(crate);
const crateBody = world.addBody(crate, { density: 500, collider: 'box' });

// The render loop: advance the world by the frame's time, which also moves the meshes, then draw.
const timer = new THREE.Timer();
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  world.update(timer.getDelta());
  renderer.render(scene, camera);
});
```

That is all a body needs: `world.addBody(object, options)` builds one from the object and binds
it, and `world.update` keeps the object where the body is. Mind the `collider` option: it is how
the body collides, and without it the body collides with nothing. That is intended, since the
mesh you draw is seldom the shape to collide as. `crateBody` is the `Body`; read its
`position`, `velocity` and so on, or push it with `applyImpulse` (see [Bodies](./bodies)).

::: tip Timer
`THREE.Timer` is three.js's frame timer. Calling `timer.connect(document)` makes it ignore the
time a hidden tab spends in the background. Older three.js releases keep it in
`three/addons/misc/Timer.js`.
:::

## The render loop

### Why fixed steps

Your frames don't arrive at a steady rate: 60 a second on one screen, 144 on another, and
fewer whenever the browser is busy. If physics stepped once per frame with the frame's length,
everything would behave differently on different machines: springs would be stiffer, stacks less
steady, and a long frame could make something tunnel through a wall.

So the world always steps by the same `timestep` (1/60 s by default), as many times as fit into
the time that has passed, and carries the remainder over to the next frame. The simulation is
then the same whatever the frame rate.

### Interpolation

Stepping in whole steps leaves the bodies up to one step behind real time. Drawn there, motion
would stutter: some frames would see two steps, some none. So after stepping, the world draws
each object part way between the body's last two poses: `alpha` of the way, where alpha is how
far the leftover time reaches into the next step, from 0 to 1. Motion looks smooth at any frame
rate, at the cost of showing the bodies at most one step (17 ms) in the past.

### What `update` does

`world.update(frameDelta)` is `step` followed by `syncObjects`:

```ts
const alpha = world.step(frameDelta); // as many fixed steps as fit; returns the interpolation alpha
// ...read or change bodies here, as they are after the latest step...
world.syncObjects(alpha); // every bound object to its body's pose, interpolated by alpha
```

Split them when you want to act between stepping and drawing. `world.interpolationAlpha` is the
same alpha, at any time.

`world.fixedStep()` runs exactly one step, without looking at the clock. It is what tests and
headless simulations use, and what `step` calls in a loop.

### `maxStepsPerFrame`

When a frame takes very long (a tab coming back from the background, a breakpoint, a slow
device), catching up in full could take longer than the frame it is catching up for, and the
page would never recover. `step` runs at most `maxStepsPerFrame` steps (8 by default) and drops
the rest of the time, so the simulation runs slower for a moment instead.

```ts
const world = new World({ timestep: 1 / 60, maxStepsPerFrame: 4 });
```

### Time

- `world.time` is the simulated time: completed steps times the timestep.
- `world.stepCount` is the number of completed steps.
- `world.renderTime` is the moment the objects are drawn at after `syncObjects`: `alpha` of the way
  through the last step. Animate anything that has to match the bodies by it, rather than by
  `world.time` or the wall clock: the sea under floating boats, a camera following a body, a
  particle trail.

```ts
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  world.update(timer.getDelta());
  water.update(renderer, world.renderTime, camera.position, camera); // the sea as the boats see it
  renderer.render(scene, camera);
});
```

::: warning Forces belong in the step
A force from `applyForce` acts on the next fixed step only. A frame can run two steps or none,
so a force applied once per frame in the render loop acts unevenly. Apply continuous forces in a
behaviour's `fixedUpdate` or a plugin's `applyForces` hook, which run once per step. See
[Bodies](./bodies#forces-and-impulses) and [Extending eulerjs](./extending).
:::

## Units

eulerjs works in SI units throughout:

| Quantity | Unit |
| --- | --- |
| Length | metres |
| Mass | kilograms |
| Time | seconds |
| Angles | radians |
| Density | kg/m³ (water, the default, is 1000) |
| Force, torque, impulse | N, N·m, N·s |
| Velocity, angular velocity | m/s, rad/s |

Make one three.js unit a metre. Gravity (9.81 m/s²), the default densities, the sleep thresholds
(0.01 m/s) and the contact margins all assume it, so a scene modelled in centimetres behaves like
something a hundred times bigger and slower.

## Where to go next

- [Bodies](./bodies): body types, mass, forces, sleeping.
- [Colliders](./colliders): the shapes bodies collide as, and their materials.
- [Joints](./joints): hinges, sliders, ragdoll joints, motors and drives.
- [Queries and events](./queries): ray casts, sensors, contact events.
- [Examples](/examples/): the basics examples run with `npm run dev:basics` in the repository.
