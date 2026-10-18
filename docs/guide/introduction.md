# Introduction

eulerjs is a rigid-body physics engine for three.js, written in TypeScript. You create a `World`
next to your three.js scene, bind bodies to your `Object3D`s, and step the world in your render
loop. The world moves the objects for you, interpolated between its fixed steps, so what you see
is always where the bodies are.

```ts
import * as THREE from 'three';
import { World } from 'eulerjs';

const world = new World(); // gravity (0, -9.81, 0), 60 fixed steps per second

const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial());
crate.position.set(0, 5, 0);
scene.add(crate);
world.addBody(crate, { density: 500, collider: 'box' }); // shape, mass and starting pose from the mesh
```

## Why eulerjs

### Built around three.js

Most physics engines for the web are written for their own world and leave you to copy poses
back and forth. eulerjs is written for three.js:

- Bodies read their starting pose from objects, and write interpolated poses back to them,
  parents included.
- Every vector, quaternion and matrix in the API is three.js's own `Vector3`, `Quaternion` and
  `Matrix3`, so there is nothing to convert.
- `world.addBody(mesh, options)` works the mass, centre of mass and inertia out from the mesh
  itself, and can fit a collider around it (`collider: 'box'`, `'convex'` and so on).
- `world.bodyOf(object)` finds the body behind a three.js raycast hit, and
  `world.addInstances(instancedMesh, options)` makes one body per instance of an `InstancedMesh`,
  so hundreds of props cost a single draw call.

### Accuracy

eulerjs tries to get the physics right rather than plausible:

- **Exact mass properties for any closed mesh.** Mass, centre of mass and the full inertia
  tensor are integrated from the triangles, not approximated by a bounding box. Meshes that
  aren't closed are rejected with an explanation instead of silently giving numbers that depend
  on where the mesh's origin is; `shape: 'voxels'` handles them instead.
- **Correct rotational dynamics.** The gyroscopic term is integrated with the implicit midpoint
  rule, so tumbling bodies keep their energy and angular momentum: an uneven box spun about its
  middle axis flips over, as it should.
- **Tested against closed-form answers**, not snapshots: textbook inertia tensors, the exact
  discrete free-fall solution, pendulum periods, friction on slopes, bounce heights and
  stacking.

### Two solvers

The built-in `JavaScriptBackend` solves joints and contacts by **soft step** (after Box2D v3) by
default, which keeps stacks still and energy steady, or by **XPBD** if you ask for it, whose
joints and contacts give less under load. See [Solvers and stepping](./solvers).

### Plugins and behaviours

Anything that isn't core lives in a plugin (world-level, hooked into every step) or a behaviour
(attached to one body). Buoyancy, sails, ray-cast vehicles and triangle-mesh colliders are all
built this way, on the same public API you can use yourself. See [Extending eulerjs](./extending).

## What is in the core

- **Bodies**: dynamic, kinematic and static, with forces, impulses, damping, gravity scale and
  sleeping. See [Bodies](./bodies).
- **Colliders**: spheres, boxes, capsules, cylinders, cones, planes, convex hulls and heightfield
  terrain, with friction, restitution, rolling resistance, collision groups and sensors. See
  [Colliders](./colliders).
- **Joints**: hinge, slider, fixed, cone-twist, general six-degree-of-freedom and distance
  joints, and a `TargetJoint` for dragging and carrying, with limits, motors, servos,
  orientation drives, friction and breaking. See [Joints](./joints).
- **Scene queries and events**: ray casts, shape casts, overlap tests, contact and sensor events.
  See [Queries and events](./queries).

## Packages

| Package | What it provides |
| --- | --- |
| `eulerjs` | `World`, `Body`, `MassProperties`, `Voxels`, every collider and joint above, the `JavaScriptBackend`, and the `Plugin`, `Behavior` and `PhysicsBackend` interfaces. `eulerjs/extend` is the entry point for plugins that add collider shapes. |
| `@eulerjs/marine` | Water and air: `SumOfSines` and `SpectralWaves` seas, `Ocean`, `Wind`, `Buoyancy`, `Foil` with sail and foil polars, and `WaterMesh` for drawing the sea; `SpectralWater` for three's `WebGPURenderer` in `@eulerjs/marine/webgpu`. See [Marine](/marine/). |
| `@eulerjs/bvh` | `MeshCollider`: any triangle mesh as a static or kinematic collider, built on three-mesh-bvh. See [BVH](/bvh). |
| `@eulerjs/vehicle` | `RaycastVehicle`: wheels on springs under a chassis, with tyres that grip up to a limit, on any ground. See [Vehicle](/vehicle). |

`Voxels` used to live in `@eulerjs/marine`; it is part of the core now, and the marine package
still re-exports it so older imports keep working.

### Peer dependencies

| Package | Needs |
| --- | --- |
| `eulerjs` | `three` 0.166 or later |
| `@eulerjs/marine` | `eulerjs` 0.1, `three` 0.166 or later (0.186 for `@eulerjs/marine/webgpu`) |
| `@eulerjs/vehicle` | `eulerjs` 0.1, `three` 0.166 or later |
| `@eulerjs/bvh` | `eulerjs` 0.1, `three` 0.166 or later, `three-mesh-bvh` 0.9 or later |

All packages are ES modules, with TypeScript declarations included.

## Browser support

The packages are compiled to ES2022, so they run in any current browser that runs three.js
itself: Chrome, Edge, Firefox and Safari. The core engine uses no DOM or browser APIs at all, so
it also runs in Node (the test suite does) and inside web workers.

Two parts of `@eulerjs/marine` ask for more:

- `SpectralWater` draws the sea with three's `WebGPURenderer`, on WebGPU or on that renderer's own
  WebGL 2 fallback. With the classic `WebGLRenderer`, use a `SumOfSines` sea and `WaterMesh`.
- `SpectralWaves.useWorker` moves the wave evaluation onto a module worker, which your bundler
  has to build (with Vite, `import SpectralWorker from '@eulerjs/marine/spectral-worker?worker'`).

## See also

- [Getting started](./getting-started): install it and get a first body falling.
- [Examples](/examples/): one idea per example, plus three complete games.
