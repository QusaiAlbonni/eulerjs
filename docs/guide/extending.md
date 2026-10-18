# Extending eulerjs

Everything that isn't core physics is built on two small interfaces: a **behaviour** acts on one
body, a **plugin** acts on the whole world. Buoyancy, sails and ray-cast vehicles are behaviours;
anything that works across many bodies (air drag, wind fields, a game's rules) is a plugin. A
third entry point, `@eulerjs/core/extend`, teaches the built-in backend new collider shapes.

## The step, hook by hook

Every fixed step runs in this order:

1. The world passes on what you changed since the last step (poses, velocities, wake and sleep
   requests).
2. Every plugin's `beforeStep(world, timestep)`.
3. Every body's behaviours: `fixedUpdate(body, timestep, world)`.
4. Every plugin's `applyForces(world, timestep)`.
5. The world passes on what the hooks changed, and the forces gathered, and the backend
   simulates the step.
6. The results are read back into the bodies; overloaded joints break; contact, sensor and
   `jointBreak` events are sent.
7. Every plugin's `afterStep(world, timestep)`.

Forces applied in steps 2 to 4 act on this step; changes to poses and velocities made there reach
the backend before it simulates. `afterStep` sees the bodies as the step left them, with
`world.time` and `world.stepCount` already advanced.

## Behaviours

A `Behavior` is any object with a `fixedUpdate` method, plus optional `attach` and `detach`:

```ts
interface Behavior {
  attach?(body: Body): void; // called by body.addBehavior(behavior)
  fixedUpdate(body: Body, timestep: number, world: World): void; // every fixed step
  detach?(body: Body): void; // called by body.removeBehavior(behavior)
}
```

A spring from a fixed point to a point on a body, with damping, as the `springs` example has it:

```ts
import { Vector3 } from 'three';
import type { Behavior, Body } from '@eulerjs/core';

class Spring implements Behavior {
  private readonly worldAttachment = new Vector3();
  private readonly attachmentVelocity = new Vector3();
  private readonly force = new Vector3();

  constructor(
    readonly anchor: Vector3,
    /** Where the spring holds the body, in the body's own frame. */
    readonly attachment: Vector3,
    readonly stiffness: number,
    readonly damping: number,
  ) {}

  fixedUpdate(body: Body): void {
    body.pointToWorld(this.attachment, this.worldAttachment);
    body.pointVelocity(this.worldAttachment, this.attachmentVelocity);
    this.force
      .subVectors(this.anchor, this.worldAttachment)
      .multiplyScalar(this.stiffness)
      .addScaledVector(this.attachmentVelocity, -this.damping);
    body.applyForce(this.force, this.worldAttachment); // off the centre of mass, so it turns the body too
  }
}

const spring = world.addBody(block, { mass: 5 }).addBehavior(new Spring(new Vector3(0, 5, 0), new Vector3(0.5, 0.5, 0.5), 120, 4));
```

Things worth knowing:

- `addBehavior` returns the behaviour, so you can keep it and change its settings as the game runs
  (`mainsail.angle = 0.6`, for instance).
- A behaviour runs for as long as its body is in a world, asleep or not. One that applies a force
  every step keeps its body awake; one that only acts sometimes lets it sleep.
- One behaviour object may be added to several bodies: `fixedUpdate` is told which body it is
  acting on. Keep per-body state elsewhere if you do.
- Keep scratch vectors as fields or module constants, as above, rather than allocating new ones
  every step: behaviours run 60 times a second for every body that has one.

## Plugins

A `Plugin` has a `name` and any of the hooks:

```ts
interface Plugin {
  readonly name: string;
  install?(world: World): void; // called once by world.use(plugin)
  beforeStep?(world: World, timestep: number): void;
  applyForces?(world: World, timestep: number): void; // add forces here; the backend simulates right after
  afterStep?(world: World, timestep: number): void;
  dispose?(world: World): void; // called by world.removePlugin(plugin) and world.dispose()
}
```

Air drag on every body, growing with the square of its speed:

```ts
import { Vector3 } from 'three';
import type { Plugin } from '@eulerjs/core';

const dragForce = new Vector3();
const airDrag: Plugin = {
  name: 'air-drag',
  applyForces(world) {
    for (const body of world.bodies) {
      if (body.isSleeping) continue;
      const speed = body.velocity.length();
      body.applyForce(dragForce.copy(body.velocity).multiplyScalar(-0.6 * speed));
    }
  },
};
world.use(airDrag);
```

`world.use(plugin)` installs it (once; using it again does nothing) and returns it.
`world.removePlugin(plugin)` takes it out and calls its `dispose`; `world.plugins` lists them.

Which hook to use:

| Hook | Use for |
| --- | --- |
| `install` | Setting up: adding bodies, subscribing to events, keeping a reference to the world. |
| `beforeStep` | Work the behaviours depend on: updating a wind field, sampling a sea's waves for this step. |
| `applyForces` | Forces on many bodies, after every behaviour has run. |
| `afterStep` | Reading results: game rules, scoring, spawning and removing bodies, recording. |
| `dispose` | Undoing `install`: removing what it added, unsubscribing. |

A plugin can also be a class, holding its own state, with its own methods for the game to call.

## New collider shapes: `@eulerjs/core/extend`

The built-in backend knows the core's shapes. A plugin that adds a shape, as `@eulerjs/bvh`
adds triangle meshes, does it through `@eulerjs/core/extend`:

```ts
import { registerCollisionTest, registerRayTest, registerTriangleShape } from '@eulerjs/core/extend';
```

### The collider class

A new shape is a subclass of `Collider` with:

- a `shape` name of its own (a string, unique among shapes);
- `bounds(pose, target)`: its world-space bounding box at a `ColliderPose`
  (`position`, `quaternion` and `rotation`, a `Matrix3` of its axes);
- `boundingRadius`: the radius of a sphere around its offset that contains it;
- `massProperties(specification)`: its `MassProperties` for a `{ mass }` or `{ density }`, or
  `undefined` if it has no volume (then it can only be on static and kinematic bodies).

Its constructor takes `ColliderOptions` and passes them to `super`, so it gets offsets, materials,
collision groups and sensors like every other collider.

### Shapes made of triangles

The easiest kind of shape to add is one made of triangles, such as a mesh or a special kind of
terrain. Describe which triangles lie where, and the engine derives the rest: collisions with every
convex shape (spheres, capsules, boxes, hulls, cylinders, cones), ray casts, shape casts, overlap
tests and sensors.

```ts
import { Box3, Vector3 } from 'three';
import { Collider } from '@eulerjs/core';
import type { ColliderOptions, ColliderPose } from '@eulerjs/core';
import { ALL_EDGES, registerTriangleShape } from '@eulerjs/core/extend';
import type { TriangleVisitor } from '@eulerjs/core/extend';

/** A single two-sided triangle, as a static collider: a ramp, a sail-shaped wall. */
class TriangleCollider extends Collider {
  readonly shape = 'triangle';
  readonly corners: readonly [Vector3, Vector3, Vector3];

  constructor(options: ColliderOptions & { corners: readonly [Vector3, Vector3, Vector3] }) {
    super(options);
    this.corners = options.corners;
  }

  get boundingRadius(): number {
    return Math.max(...this.corners.map((corner) => corner.length()));
  }

  bounds(pose: ColliderPose, target: Box3): Box3 {
    target.makeEmpty();
    for (const corner of this.corners) target.expandByPoint(scratch.copy(corner).applyMatrix3(pose.rotation).add(pose.position));
    return target;
  }

  massProperties(): undefined {
    return undefined;
  }
}

const scratch = new Vector3();
const worldCorners = [new Vector3(), new Vector3(), new Vector3()] as const;

registerTriangleShape<TriangleCollider>('triangle', {
  oneSided: false, // both sides solid; true for terrain, solid behind the front only
  forEachTriangle(collider: TriangleCollider, pose: ColliderPose, _region: Box3, visit: TriangleVisitor) {
    const [first, second, third] = worldCorners;
    first.copy(collider.corners[0]).applyMatrix3(pose.rotation).add(pose.position);
    second.copy(collider.corners[1]).applyMatrix3(pose.rotation).add(pose.position);
    third.copy(collider.corners[2]).applyMatrix3(pose.rotation).add(pose.position);
    visit(first, second, third, ALL_EDGES);
  },
});
```

`forEachTriangle(collider, pose, region, visit)` calls `visit` with the corners of every triangle
that may reach into `region` (a world-space box), in world space and wound anticlockwise seen from
the front, plus a bit mask of the triangle's **active edges**: bit k set when the edge from corner
k to the next may push on its own. Visiting triangles outside the region is allowed, merely
slower; a real shape uses the region to visit only what is near, as `MeshCollider` does through
its bounding volume tree.

Active edges are what stop bodies catching on the seams of a flat floor: an edge between two
nearly flat neighbours should be inactive, since their faces already cover it. `isActiveEdge(normal,
start, end, neighbourCorner)` decides it for an edge, given the triangle's normal and the far corner
of the neighbour across it (`undefined` on a border); `ALL_EDGES` marks all three active.

### Your own ray test

`registerRayTest(shape, test)` gives a shape a ray cast of its own, used instead of the general
one: `(collider, pose, origin, direction, maxDistance) => SweepHit | undefined`, where a
`SweepHit` is `{ distance, point, normal }`, the normal pointing back toward the ray. `@eulerjs/bvh`
uses it to cast rays through its tree; `rayTriangle(origin, direction, first, second, third,
oneSided)` is the engine's own ray-triangle test, for building one.

### Shapes with their own collision tests

For a shape that isn't made of triangles, `registerCollisionTest(shapeA, shapeB, test)` teaches the
engine how two shapes collide. Register each pair once; the reverse order is handled for you.

```ts
registerCollisionTest<SphereCollider, MyShape>('sphere', 'my-shape', (sphere, spherePose, mine, minePose, contacts, margin) => {
  // push a ContactPoint for every point where they touch or are less than `margin` apart:
  // { pointA, pointB, normal (unit, from B toward A), depth ((pointB - pointA) · normal, negative for a gap) }
});
```

A shape known only by its collision tests collides with the shapes you wrote tests for, and with
nothing else. Give it a ray test too for ray casts; shape casts and overlap tests, which need a
convex or triangle shape, don't see it. `collide(colliderA, poseA, colliderB, poseB, contacts,
margin?)` runs whatever test is registered for a pair, and `triangleTestFor(collider, pose)` gives
the test of a convex collider against a single triangle, for shapes that are partly made of them.

::: warning The JavaScript backend only
`@eulerjs/core/extend` extends the built-in `JavaScriptBackend`. Another backend has its own way of
adding shapes, if it has one.
:::

## Backends

The deepest extension point is a whole new backend: an object implementing `PhysicsBackend`,
passed as `new World({ backend })`. The world, bodies, joints, queries and events stay the same;
the backend keeps its own copy of every body and steps it. See
[Solvers and stepping](./solvers#backends).

## See also

- [Bodies](./bodies#behaviours): behaviours on bodies.
- [Examples](/examples/): the `springs` example's behaviour and plugin.
- [Marine](/marine/), [Vehicle](/vehicle) and [BVH](/bvh): the plugins built on all of this.
