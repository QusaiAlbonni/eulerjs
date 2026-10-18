# eulerjs

Rigid body physics for three.js: bodies made straight from your meshes with exact mass
properties, joints, and collisions between spheres, boxes, planes and convex hulls.

```sh
npm install @eulerjs/core three
```

```ts
import { PlaneCollider, World } from '@eulerjs/core';

const world = new World();
world.addBody(floor, { type: 'static', collider: new PlaneCollider() });
world.addBody(crate, { density: 500, collider: 'box' }); // mass and starting pose from the mesh, a box round it

renderer.setAnimationLoop(() => {
  world.update(clock.getDelta()); // fixed steps, then the meshes follow their bodies
  renderer.render(scene, camera);
});
```

The mass comes from the mesh; what a body collides as is always your choice. `collider` has no
default, on purpose: without it the body collides with nothing, since the mesh drawn is seldom
the shape to collide as.

Needs three 0.166 or later. See the [documentation](https://qusaialbonni.github.io/eulerjs/) for the full guide, the API
reference and live examples, and `@eulerjs/marine` for water, buoyancy and sails.

MIT licensed.
