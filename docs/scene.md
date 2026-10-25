# Physics from a scene

`@eulerjs/scene` makes the bodies for a three.js scene from what its objects say about
themselves, in `userData.physics`, the convention three.js's own physics addons read. It comes in
two layers:

- **`ScenePhysics`**, a plugin: `world.use(new ScenePhysics())`, then `addScene(scene)`.
- **`EulerPhysics()`**, a drop-in for three.js's `RapierPhysics`, `JoltPhysics` and `AmmoPhysics`:
  an example written for them runs on eulerjs by changing the line that awaits them.

```sh
npm install @eulerjs/scene @eulerjs/bvh @eulerjs/core three three-mesh-bvh
```

It uses `@eulerjs/bvh` to collide still scenery as its triangles, so it needs three-mesh-bvh 0.9 or
later too, as a peer dependency.

## Marking up a scene

three.js's addons read `userData.physics` on each mesh:

```ts
floor.userData.physics = { mass: 0 }; // still
crate.userData.physics = { mass: 5, restitution: 0.3 }; // moves, and bounces a little
```

`ScenePhysics` reads the same, and a little more that three.js's addons leave alone:

| Field | Default | What it is |
| --- | --- | --- |
| `mass` | none | In kg. 0 or none: the object doesn't move. |
| `restitution` | `0` | How bouncy, usually from 0 to 1. |
| `friction` | `0.5` | Coulomb friction. |
| `type` | from `mass` | `'kinematic'` for an object you move by hand, say; or `'static'` or `'dynamic'` whatever the mass. |
| `collider` | chosen for it | `'box'`, `'sphere'`, `'convex'`, `'cylinder'`, `'cone'` or `'capsule'`, fitted around its meshes; or `'mesh'` for its triangles, which only a still or kinematic object can be. |
| `body` | | Written for you: the body made, or for an InstancedMesh one for each instance. |

A glTF node's extras arrive in `userData`, so a Blender custom property named `physics` comes
through as this, ready for `addScene`.

## ScenePhysics

```ts
import { World } from '@eulerjs/core';
import { ScenePhysics } from '@eulerjs/scene';

const world = new World();
const physics = world.use(new ScenePhysics());
physics.addScene(scene); // every object whose userData.physics is set

renderer.setAnimationLoop(() => {
  world.update(timer.getDelta());
  renderer.render(scene, camera);
});
```

- **One body for each object with `userData.physics`**, whatever it holds: a mesh, or a group of
  them, such as a glTF node of several primitives (three.js's addons only look at meshes, and so
  miss those). A group's body takes in the meshes under it that don't have physics of their own;
  one that does is a body apart.
- **It starts where it is drawn**, nested in moved, turned and scaled groups or not, and moves its
  object as it goes, interpolated between steps as any body in eulerjs is.
- **An InstancedMesh is a body for each instance**, each at the scale it is drawn at.
- **An object that already has a body is left alone**, so you can make the odd one by hand.
- `addObject(object, physics)` adds one object (`physics` merged into its `userData.physics`),
  and `removeObject(object)` takes its body, or its instances' bodies, out of the world.

### What it collides as

three.js's own geometries are the shapes they are: `BoxGeometry` a box, `RoundedBoxGeometry` its
hull (exactly the shape drawn, where a box would stick out past its rounded edges),
`SphereGeometry` and `IcosahedronGeometry` a sphere, `CylinderGeometry` a cylinder (or a cone, with
no top), `ConeGeometry` a cone and `CapsuleGeometry` a capsule, sized as drawn. Only while the
geometry is still the shape its parameters say, though: one translated, turned or cut since (a
half sphere, a slice of a cylinder), or a round one scaled out of round, isn't trusted, and is
taken as anything else would be.

Nor is a round one too coarse to be round. Its flat faces lie inside the round shape through its
corners, which would stick out past every face, and the object would rest in the air: an
8-sided capsule (three.js's default) by 4 cm, an icosahedron of detail 0 (its default) by 10 cm.
So a round shape stands for a geometry only where the geometry is everywhere within 2% of its
radius of it, as three.js's default sphere, cylinder and cone are; a coarser one collides as its
hull, exactly as drawn, and rolls as the polyhedron it is drawn as. Give it more sides to roll
smoothly, or `collider: 'sphere'` (or the like) to have the round shape anyway.

Anything else collides as its **convex hull** if it moves and as its very **triangles** (a
[`MeshCollider`](/bvh)) if it doesn't, so still scenery, a room or a level, has its hollows. A
moving concave object, such as a chair, collides as its hull, filled in; split it into convex
parts of its own to do better.

A moving body's mass properties are exact from its meshes when they are closed, and come from its
collider when they aren't.

## EulerPhysics

```ts
import { EulerPhysics } from '@eulerjs/scene';

const physics = await EulerPhysics(); // was: await RapierPhysics()
physics.addScene(scene);
physics.addMesh(mesh, 1, 0.5); // mass, restitution
```

It has the API three.js's addons share:

| Method | What it does |
| --- | --- |
| `addScene(scene)` | Adds the objects whose `userData.physics` is set. |
| `addMesh(mesh, mass = 0, restitution = 0)` | Adds one mesh. |
| `removeMesh(mesh)` | Takes it out again. |
| `setMeshPosition(mesh, position, index = 0)` | Moves a mesh, or instance `index` of an InstancedMesh, and stops it. |
| `setMeshVelocity(mesh, velocity, index = 0)` | Sets its velocity. |
| `applyImpulse(mesh, impulse, index = 0)` | Pushes it. |
| `addHeightfield(mesh, width, depth, heights, scale)` | Adds terrain: see below. |

and a little more: `world`, the eulerjs world, for anything else; `scene`, its `ScenePhysics`;
and `dispose()`, which stops it and frees the world.

Like three.js's addons it steps by itself, 60 times a second, but at a fixed timestep, so a scene
plays out the same way every time. A scene that takes longer than that to step slows down, as it
does on the addons, rather than stepping more and more to catch up. To step it yourself in your
render loop instead, with the motion interpolated between steps, use `ScenePhysics` and
`world.update`.

Three of three.js's own examples run on it, with nothing changed but that line: see
[the examples](/examples/#three-js-s-own-examples). Code that reaches past the shared API into the
engine, through `physics.RAPIER` or Rapier's world, needs porting by hand.

### Heightfields

`addHeightfield(mesh, width, depth, heights, scale)` puts terrain under the mesh's origin:
`width` by `depth` cells along x and z, from `(width + 1) × (depth + 1)` heights. They run along x
first, then row after row along z, as the vertices of a `PlaneGeometry` turned flat with
`rotateX(-Math.PI / 2)` do, so the terrain is where that mesh draws it. `scale.x` and `scale.z` are
its whole width and depth, and `scale.y` scales the heights. The cells needn't be square.

Rapier itself reads such heights the other way about, z first. three.js's terrain example doesn't
show the difference, since its terrain is square and the same every way round, but a terrain that
isn't would collide transposed from how it is drawn.
