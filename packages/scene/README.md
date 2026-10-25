# @eulerjs/scene

Physics for a three.js scene, read from it, for [eulerjs](https://www.npmjs.com/package/@eulerjs/core).

```sh
npm install @eulerjs/scene @eulerjs/bvh @eulerjs/core three three-mesh-bvh
```

`ScenePhysics` makes the bodies a scene's `userData.physics` asks for, the convention three.js's own
physics addons read:

```ts
import { World } from '@eulerjs/core';
import { ScenePhysics } from '@eulerjs/scene';

floor.userData.physics = { mass: 0 };
crate.userData.physics = { mass: 5, restitution: 0.3, friction: 0.6 };

const world = new World();
world.use(new ScenePhysics()).addScene(scene);
```

Each object with `userData.physics`, a mesh or a group of them, becomes a body where it is drawn.
three.js's box, sphere, cylinder, cone and capsule geometries collide as those shapes; anything else
as its convex hull if it moves, or as its triangles if it doesn't.

`EulerPhysics()` is a drop-in for three.js's `RapierPhysics`, `JoltPhysics` and `AmmoPhysics`, with
their API (`addScene`, `addMesh`, `removeMesh`, `setMeshPosition`, `setMeshVelocity`,
`applyImpulse`, `addHeightfield`):

```ts
import { EulerPhysics } from '@eulerjs/scene';

const physics = await EulerPhysics(); // was: await RapierPhysics()
physics.addScene(scene);
```

Needs three 0.166 or later and three-mesh-bvh 0.9 or later. See the [guide](https://qusaialbonni.github.io/eulerjs/scene).

MIT licensed.
