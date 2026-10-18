# @eulerjs/bvh

Triangle mesh colliders for [eulerjs](https://www.npmjs.com/package/@eulerjs/core): a level, a building or a rock face as a
collider, found quickly with a bounding volume tree from
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh).

```sh
npm install @eulerjs/bvh eulerjs three three-mesh-bvh
```

```ts
import { Body } from '@eulerjs/core';
import { MeshCollider } from '@eulerjs/bvh';

world.addBody(new Body({ type: 'static', colliders: [new MeshCollider({ geometry: level.geometry, friction: 0.7 })] }));
```

Both sides of every triangle are solid, so the mesh needn't be closed. Edges between nearly flat
neighbouring triangles never push on their own, so bodies roll and slide across the mesh without
catching on them. Every convex collider collides with it, and ray casts, shape casts and overlap
tests find it. It is for static and kinematic bodies: a mesh has no volume to give a mass.

Needs three 0.166 or later and three-mesh-bvh 0.9 or later. See the [guide](https://qusaialbonni.github.io/eulerjs/bvh).

MIT licensed.
