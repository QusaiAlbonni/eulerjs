---
layout: home

hero:
  name: eulerjs
  text: Rigid-body physics for three.js
  tagline: Bodies built from your meshes, joints with drives and limits, an accurate solver that sleeps what's at rest, and plugins for the sea, sails, cars and triangle meshes.
  image:
    src: /thumbnails/ocean.jpg
    alt: A spectral sea to the horizon, with crates afloat on it
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: See the examples
      link: /examples/
    - theme: alt
      text: GitHub
      link: https://github.com/QusaiAlbonni/eulerjs

features:
  - icon: 🧊
    title: three.js through and through
    details: Give it a mesh and it works out the body's mass, inertia and colliders from the geometry. Bodies move their meshes, interpolated between fixed steps, and instanced meshes are bodies too.
    link: /guide/bodies
    linkText: Bodies
  - icon: ⚖️
    title: An accurate solver
    details: A soft-step solver by default, after Box2D v3, that holds stacks still and lets what's at rest sleep; XPBD when you want it. Exact inertia, rolling resistance, joint friction.
    link: /guide/solvers
    linkText: Solvers
  - icon: 🔗
    title: Joints with drives
    details: Hinges, sliders, cone-twist, distance, fixed and six-degree-of-freedom joints, with limits, motors, springs and drives that hold a ragdoll's walk, and joints that break.
    link: /guide/joints
    linkText: Joints
  - icon: 🌊
    title: A sea to the horizon
    details: An FFT ocean of hundreds of thousands of waves, drawn on the GPU to the horizon and floated on by the very same waves on the CPU, with foam, swell and gusts.
    link: /marine/
    linkText: '@eulerjs/marine'
  - icon: ⛵
    title: Buoyancy and sails
    details: Hulls voxelised and floated cell by cell, sails, keels and rudders as foils with real polars, and a sailboat built only on the public API.
    link: /marine/buoyancy
    linkText: Buoyancy
  - icon: 🚗
    title: Cars and terrain
    details: Ray-cast vehicles with springs and grip or slip tyres, heightfields, and any triangle mesh as a collider on three-mesh-bvh.
    link: /vehicle
    linkText: '@eulerjs/vehicle'
---

<div class="vp-doc home-content">

## Why eulerjs

Faster than cannon-es where real scenes spend their time, and right where cannon-es is wrong.

<div class="stats">
  <div class="stat">
    <div class="number">41×</div>
    <div class="label">faster than cannon-es on a settled pile of boxes: what's at rest sleeps, and stays asleep</div>
  </div>
  <div class="stat">
    <div class="number">88×</div>
    <div class="label">faster with convex hulls: 64 tumbling rocks of 42 corners each</div>
  </div>
  <div class="stat">
    <div class="number">2.5 mm</div>
    <div class="label">how far an eight-box stack's top moves in a minute awake; cannon-es's falls over</div>
  </div>
  <div class="stat">
    <div class="number">0.0%</div>
    <div class="label">error in a box's acceleration sliding down a slope; in cannon-es it doesn't slide at all</div>
  </div>
</div>

**It gets the physics right.** Stacks stand, boxes slide down slopes at the textbook
acceleration, balls bounce to the height their restitution says, and a rock's inertia is
integrated from its hull, not guessed from its bounding box. **It's fast where it counts:** real
scenes are mostly at rest, and a city full of props costs a thirtieth of cannon-es's; with a crowd of
ragdolls all awake and walking it is still the faster of the two. **And it's three.js through
and through:** give it a mesh and it works out the body.

### Against cannon-es

The same scenes in both engines, at 60 steps a second, with the same masses, friction and sleep
thresholds; each keeps its own solver defaults. Milliseconds of computing per simulated second on
a Ryzen 5 4600H, lower is better.

<div class="comparison">

| Scene | eulerjs | cannon-es | |
| --- | ---: | ---: | --- |
| 125 boxes settled | **5 ms** | 204 ms | eulerjs 41× faster |
| 64 rocks (42-corner hulls) | **59 ms** | 6093 ms | eulerjs 103× faster |
| Mixed pile: 400 boxes, balls, cylinders and rocks | **447 ms** | 8125 ms | eulerjs 18.2× faster |
| Pyramid of 1,015 boxes | **3156 ms** | 10864 ms | eulerjs 3.4× faster |
| 125 boxes falling into a pile | **94 ms** | 216 ms | eulerjs 2.3× faster |
| 400 spheres, never sleeping | **76 ms** | 101 ms | eulerjs 1.3× faster |
| The city at rest | **4 ms** | 120 ms | eulerjs 30× faster |
| The city, 25 ragdolls walking | **282 ms** | 629 ms | eulerjs 2.2× faster |
| The city, 100 ragdolls walking | **1261 ms** | 2670 ms | eulerjs 2.1× faster |

| Accuracy | eulerjs | cannon-es |
| --- | ---: | ---: |
| 8-box stack kept awake, top's furthest move in 60 s | **2.5 mm** | 9.5 m (falls) |
| Box sliding down a slope, acceleration error | **0.0%** | −100% (stuck) |
| Ball bounced from 3 m, height error | **−1.8%** | +21.6% |
| A rock's moment of inertia (9.14 is right) | **9.14** | 66.7 |
| A box resting on the ground, how far it sinks | 0.07 mm | **0.00 mm** |

</div>

Every number comes from `npm run bench` in the repository; the [performance guide](/guide/performance)
has all of them, and what cannon-es does better.

## A world in a few lines

```ts
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
import { World } from '@eulerjs/core';

const world = new World();

// the ground, and a crate dropped on it: mass from the meshes, and boxes fitted round them to collide as
const ground = new Mesh(new BoxGeometry(20, 1, 20), new MeshStandardMaterial());
ground.position.y = -0.5;
world.addBody(ground, { type: 'static', collider: 'box' });

const crate = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xd08770 }));
crate.position.y = 4;
world.addBody(crate, { density: 500, collider: 'box' });

renderer.setAnimationLoop(() => {
  // fixed steps for the time gone, then the meshes moved to their bodies
  world.update(timer.getDelta());
  renderer.render(scene, camera);
});
```

[Get started →](/guide/getting-started)

</div>

<style>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin: 24px 0 28px;
}
.stat {
  padding: 22px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.stat:hover {
  border-color: var(--vp-c-brand-2);
  transform: translateY(-2px);
}
.stat .number {
  font-size: 40px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  background: linear-gradient(120deg, #1f6582 10%, #2f7fd8 55%, #33b3aa 95%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.stat .label {
  margin-top: 8px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
/* full width where they fit; scrolled sideways on their own where they don't */
.vp-doc .comparison {
  overflow-x: auto;
}
.vp-doc .comparison table {
  display: table;
  width: 100%;
}
.home-content {
  max-width: 1152px;
  margin: 48px auto 0;
  padding: 0 24px;
}
@media (min-width: 640px) {
  .home-content {
    padding: 0 48px;
  }
}
@media (min-width: 960px) {
  .home-content {
    padding: 0 64px;
  }
}
</style>
