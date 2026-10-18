# Triangle meshes

`@eulerjs/bvh` adds `MeshCollider`: any triangle mesh as a collider, such as a level, a building,
a rock face or a sculpture, found quickly with a bounding volume tree from
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh).

```sh
npm install @eulerjs/bvh eulerjs three three-mesh-bvh
```

It needs three 0.166 or later and three-mesh-bvh 0.9 or later, which is a peer dependency: you
install it yourself, and it is shared with anything else of yours that uses it.

```ts
import { Body } from 'eulerjs';
import { MeshCollider } from '@eulerjs/bvh';

world.addBody(new Body({ type: 'static', colliders: [new MeshCollider({ geometry: level.geometry, friction: 0.7 })] }));
```

## What it is

- **Both sides of every triangle are solid**, so the mesh needn't be closed: a terrain of a
  single sheet, a bowl, a room seen from inside all work, however their triangles are wound.
- **Edges between nearly flat neighbouring triangles never push on their own.** A ball rolling
  across a mesh would otherwise catch on the seams between its triangles, nudged by an edge its
  neighbours' faces already cover. Edges between triangles less than 5° apart are left to the
  faces; edges on the mesh's border, and folds sharper than that, still push. Vertices are welded
  by position first, so a mesh that repeats its vertices along normal or texture seams is
  treated as the surface it is.
- **Every convex collider collides with it**: spheres, capsules, boxes, convex hulls, cylinders
  and cones. Two meshes don't collide with each other, nor a mesh with a plane or a heightfield,
  which is no loss for static ground.
- **Scene queries find it**: ray casts, shape casts and overlap tests. A ray meets it where
  three.js's own `Raycaster` would, with the normal turned back toward the ray.
- **Static and kinematic bodies only.** A mesh has no volume to give a mass, so it can't weigh a
  dynamic body. A kinematic body carrying one moves its triangles with it: a moving platform, a
  lift, a swinging bridge.

## Options

`MeshCollider` takes every option a collider does (see [Colliders](/guide/colliders)), plus its
triangles:

| Option | Default | What it is |
| --- | --- | --- |
| `geometry` | required | The triangles, in the collider's frame, indexed or not. Copied, so later changes to it don't reach the collider. |
| `offset`, `rotation` | none | Where the collider sits in its body's frame. |
| `friction` | `0.5` | Coulomb friction; two colliders use the geometric mean of theirs. |
| `restitution` | `0` | Bounciness; two colliders use the larger. |
| `rollingResistance` | `0` | What rolling things on it are held back by. |
| `collisionGroups`, `collidesWith` | group 1, every group | Collision filtering. |

A geometry without a `position` attribute throws a `RangeError`.

::: warning The geometry is in the collider's frame
`MeshCollider` reads the geometry's positions as they are: the `Mesh`'s position, rotation and
scale are not in them. Put the body where the mesh is (`position` and `quaternion`, as in the
example below), and bake any **scale** into a copy of the geometry first:

```ts
const scaled = rockMesh.geometry.clone().scale(rockMesh.scale.x, rockMesh.scale.y, rockMesh.scale.z);
world.addBody(new Body({ type: 'static', position: rockMesh.position, quaternion: rockMesh.quaternion, colliders: [new MeshCollider({ geometry: scaled })] }));
```

For a mesh deep in a hierarchy, `geometry.clone().applyMatrix4(mesh.matrixWorld)` puts its
triangles in the world, for a body at the origin.
:::

`collider.toGeometry()` gives back a copy of its triangles, in its frame, to draw exactly what
things collide with. `triangleCount` is how many there are, `bvh` is the three-mesh-bvh tree, and
`activeEdges` says, for each triangle, which of its edges may push on their own.

## The terrain example

`examples/basics/src/terrain.ts` rolls barrels, traffic cones and balls down a heightfield, and
drops every fourth onto a torus knot that stands on the hills as a triangle mesh:

```ts
import { Mesh, MeshStandardMaterial, TorusKnotGeometry } from 'three';
import { Body } from 'eulerjs';
import { MeshCollider } from '@eulerjs/bvh';

const knot = new TorusKnotGeometry(3, 0.8, 128, 16);
const sculpture = new Mesh(knot, new MeshStandardMaterial({ color: 0xb48ead, metalness: 0.3, roughness: 0.4 }));
sculpture.position.set(-12, terrain.surfaceHeight(-12, 8)! + 5, 8);
scene.add(sculpture);
// the knot's own geometry, at the mesh's position: things land on it and fall through its loops
world.addBody(new Body({ type: 'static', position: sculpture.position, colliders: [new MeshCollider({ geometry: knot, friction: 0.5 })] }));
```

The knot has 4096 triangles, twisted round on themselves, and is anything but closed or convex:
exactly what a mesh collider is for.

## MeshCollider or HeightfieldCollider?

For terrain from a grid of heights, the core's `HeightfieldCollider` is usually better:

| | `HeightfieldCollider` (core) | `MeshCollider` (`@eulerjs/bvh`) |
| --- | --- | --- |
| Shape | a grid of heights: one height for each place | any triangles: overhangs, caves, loops, buildings |
| Solid | below its surface, to a thickness (1 m under its lowest point by default) | both sides of every triangle: a surface with no inside |
| Needs | nothing more | three-mesh-bvh |

Both keep flat seams from catching, both are for static and kinematic bodies, and both have
`toGeometry()`. A heightfield is solid under its surface, so whatever sinks into it, or arrives
too fast for a step, is pushed back up. A mesh is a surface only: something that gets right
through it within a step (there is no continuous collision detection yet; see `TODO.md`) is on
the other side of it, and stays there. Give thin walls some thickness, or keep fast things off
them.

## Performance

The tree is built once, when the collider is made, and every step only the triangles near each
body are visited, so a large mesh costs little more than a small one to collide with. Building it
is the expensive part: make mesh colliders while loading, not in the middle of play.

`npm run bench` builds a 128 by 128 mesh of rolling ground (32 768 triangles) and rolls 200 balls
on it. On one desktop machine, building the collider took about 220 ms, and a step with all 200
balls rolling about 4.5 ms.

::: tip Keep collision meshes simple
Collide with a simplified version of what you draw: a few hundred or thousand triangles for a
building rather than its every window frame. The tree finds the triangles near a body quickly,
but each of them is still tested against it, every step.
:::

## Limitations

- **No dynamic meshes.** For a dynamic body of a complicated shape, collide it as a
  `ConvexCollider` (its hull) or as several colliders together (see [Colliders](/guide/colliders)).
  Dynamic triangle meshes are in `TODO.md`.
- A ridge only a little sharper than flat can still push on its own, which a body sliding over it
  may feel as a slight bump.
- A body lying across a triangle's edge or diagonal gets contact points that come and go from step
  to step; a narrow face, such as a cone's hull lying on its side, can feel it as a slight
  rocking, though it still falls asleep.

## See also

- [Colliders](/guide/colliders): the core shapes, `HeightfieldCollider` among them, and collider options
- [Bodies](/guide/bodies): static and kinematic bodies
- [Ray-cast vehicles](/vehicle): cars drive on mesh colliders as on anything else
- [Examples](/examples/): the terrain
