# Instancing

A scene of many props that look alike (chairs, crates, bricks, cans) is best drawn with a
three.js `InstancedMesh`: one geometry, one material, one draw call for all of them. eulerjs can
give every instance its own body, drawn as that instance.

```ts
import * as THREE from 'three';
import { World } from '@eulerjs/core';

const chairs = new THREE.InstancedMesh(chairGeometry, chairMaterial, 200);
for (let index = 0; index < 200; index++) chairs.setMatrixAt(index, placements[index]);
scene.add(chairs);

const bodies = world.addInstances(chairs, { mass: 4, collider: 'box' }); // one body per instance
```

## `world.addInstances`

`world.addInstances(mesh, options)` makes a body for every instance of an `InstancedMesh` (all
`mesh.count` of them), adds them to the world and returns them in the instances' order, so
`bodies[index]` moves instance `index`. Each body:

- starts where its instance is: the instance's matrix carried into the world by the mesh's own
  world matrix, so an instanced mesh inside a moved group works;
- collides as `options.collider` says;
- is weighed from the mesh's geometry, with the instance's scale, at `options.density` (water's
  by default) or to `options.mass`, which is **each** body's mass, not the total.

The options are those of `world.addBody(object, ...)` without the ones that differ per instance
or need a single object (`position`, `quaternion`, `velocity`, `angularVelocity`, `shape`,
`cellSize`). `collider` is a shorthand fitted around the geometry (with the instance's scale), or
a function making the colliders for the instance at `index`:

```ts
import { SphereCollider } from '@eulerjs/core';

const balls = world.addInstances(ballMesh, {
  density: 300,
  collider: (index) => new SphereCollider({ radius: radii[index], restitution: 0.5 }),
});
```

It is a function rather than one collider to share because every body needs colliders of its
own. Set velocities and other per-body settings on the bodies it returns:

```ts
bodies.forEach((body, index) => body.velocity.set(0, 2 + index * 0.01, 0));
```

### Scaled instances

Instances may be scaled, and each body takes its instance's scale into its shape and mass: an
instance drawn twice the size gets a collider twice as big and eight times the mass. The body
itself has no scale; it writes the instance's scale back unchanged every time it draws it.
Instances drawn at the same scale are weighed once between them, so a thousand unscaled
instances cost one mass integration, not a thousand.

## Binding one instance yourself

`new Body({ instance: { mesh, index } })` binds one body to one instance, with any options you
like, as `object` binds one to an `Object3D`:

```ts
import { Body, BoxCollider } from '@eulerjs/core';

const crateBody = world.addBody(
  new Body({ instance: { mesh: crates, index: 7 }, colliders: [new BoxCollider({ size: crateSize })], mass: 12 }),
);
```

The body's starting pose (and the scale it keeps) are read from the instance's matrix.
`body.instance` is `{ mesh, index }` for an instanced body, and `undefined` otherwise. A world
refuses two bodies for the same instance, and `world.addBody(instancedMesh)` refuses outright,
since it would make one body of them all.

## How instance matrices are written

Every `syncObjects` (and so every `world.update`), each instanced body writes its pose,
interpolated between the last two steps exactly as a bound object's is, into its instance:

- in the mesh's own frame, so the mesh may sit inside a moved, turned or scaled parent;
- with the instance's own scale;
- setting `mesh.instanceMatrix.needsUpdate`, so three.js uploads the matrices;
- clearing `mesh.boundingSphere` and `mesh.boundingBox`, so three.js works the mesh's bounds out
  afresh and doesn't cull it wrongly once instances have moved away from where they started.

For dynamic bodies `addInstances` also sets the instance matrix's usage to `DynamicDrawUsage`,
since it will change often.

## Sleeping instances

A body that sleeps writes its instance once and then leaves it alone, so a still scene uploads
nothing at all: the matrices are only marked for upload while something is moving. When a
sleeping body wakes, it starts writing again.

That makes instancing a good fit for large scenes set exactly where they should stand. Put them to
sleep as they are made and they cost nearly nothing until something disturbs them:

```ts
for (const body of world.addInstances(chairs, { mass: 4, collider: 'box' })) body.sleep();
```

## Finding the body of an instance

A three.js raycast against an `InstancedMesh` gives an `instanceId`; pass it to `world.bodyOf`:

```ts
const hit = raycaster.intersectObject(chairs)[0];
const chairBody = hit && world.bodyOf(hit.object, hit.instanceId);
chairBody?.applyImpulse(raycaster.ray.direction.clone().multiplyScalar(20), hit.point);
```

eulerjs's own `world.castRay` returns the body directly, instanced or not.

## Removing instanced bodies

`world.removeBody(body)` stops a body moving its instance, but leaves the instance drawn where it
was last written. To hide it, write a zero-scale matrix into it, or lower `mesh.count` if it is the
last one.

## See also

- [Bodies](./bodies): the options instanced bodies take.
- [Performance](./performance): why instancing and sleeping matter.
- [Examples](/examples/): the wedding example's chairs, plates and glasses.
