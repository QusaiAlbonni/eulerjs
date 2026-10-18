# Bodies

A `Body` is one rigid body: a pose, velocities, mass properties, the colliders it collides as,
and optionally a three.js object or instance that follows it. This page covers making bodies,
their types and mass, moving and pushing them, sleeping, behaviours and removing them.

## Making a body

There are two ways, and they make the same kind of `Body`.

### From a three.js object

`world.addBody(object, options)` builds a body for an `Object3D` and adds it to the world:

```ts
const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 1.6), crateMaterial);
crate.position.set(0, 3, 0);
scene.add(crate);
const crateBody = world.addBody(crate, { density: 500, collider: 'box' });
```

- The **starting pose** is the object's world position and orientation, parents included.
- The **mass properties** are integrated exactly from every mesh under the object (all of them,
  for a group), in the object's frame, at the `density` you give (kg/m³) or scaled to a total
  `mass` (kg). With neither, the density is water's, 1000 kg/m³ (`DEFAULT_DENSITY`).
- **Scale** is baked into the shape. Bodies have no scale of their own; the object keeps its
  scale and the world only ever writes its position and quaternion.
- `collider` gives it something to collide as: a shorthand (`'box'`, `'sphere'`, `'convex'`,
  `'cylinder'`, `'cone'`, `'capsule'`) fitted around the meshes, or your own collider instances.
  See [Colliders](./colliders).

::: warning A body collides only as you say
`collider` has no default: `world.addBody(mesh)` on its own makes a body that is weighed from the
mesh but collides with nothing, and falls through the floor. This is intended. The mesh you draw
is seldom the shape to collide as: a detailed model makes a slow hull, and most aren't convex.
So the engine works the mass out from the mesh, which is always right, and leaves the collision
shape to you: a box or a sphere for most things, `'convex'` for rocks and debris, several
colliders for anything shaped like an L, a `MeshCollider` from `@eulerjs/bvh` for static
scenery.
:::

The options are those of `BodyOptions` (see below) plus a few that only make sense for an object:

| Option | Meaning |
| --- | --- |
| `mass` | Total mass in kg. |
| `density` | In kg/m³, when no mass is given. Defaults to 1000. |
| `shape` | `'mesh'` (the default) integrates the closed surface exactly; `'voxels'` fills it with cells, which also works for open meshes and keeps the cells for buoyancy. |
| `cellSize` | Cell size for `shape: 'voxels'`, in metres. Defaults to a sixteenth of the longest side. |
| `collider` | A shorthand, a collider, or an array of colliders. None by default: the body collides with nothing until given one. |

`world.addBody` refuses an `InstancedMesh`: it draws many bodies, not one. Use
`world.addInstances` for those (see [Instancing](./instancing)). It also refuses a second body
for an object that already has one in the world.

### From options

`new Body(options)` builds a body without an object, or with one you bind yourself, and
`world.addBody(body)` adds it:

```ts
import { Body, MassProperties, SphereCollider } from '@eulerjs/core';

const ball = world.addBody(
  new Body({
    massProperties: MassProperties.sphere(0.3, 2),
    position: new THREE.Vector3(0, 5, 0),
    colliders: [new SphereCollider({ radius: 0.3, restitution: 0.5 })],
  }),
);
```

`BodyOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `type` | `'dynamic'` | `'dynamic'`, `'kinematic'` or `'static'`. |
| `massProperties` | from colliders | Mass, centre of mass and inertia, in the body frame. |
| `mass` | | Overrides the mass in `massProperties`, scaling the inertia to match; without them, the total mass of the colliders. |
| `density` | 1000 | Without `massProperties` or `mass`, the colliders' density in kg/m³. |
| `position` | object's, or origin | Origin of the body frame in world space. |
| `quaternion` | object's, or identity | Orientation of the body frame. |
| `velocity` | zero | Velocity of the centre of mass, m/s. |
| `angularVelocity` | zero | World-space angular velocity, rad/s. |
| `linearDamping` | 0 | See [Damping](#damping). |
| `angularDamping` | 0 | See [Damping](#damping). |
| `gravityScale` | 1 | Multiplier on the world's gravity; 0 turns it off. |
| `object` | | A three.js object that follows the body. |
| `instance` | | One instance of an `InstancedMesh` that follows the body: `{ mesh, index }`. |
| `voxels` | | The body's volume as cells, for behaviours such as buoyancy. |
| `colliders` | none | The shapes it collides as, in its own frame. |
| `canSleep` | true | Whether it may fall asleep. |

`position` and `quaternion` win over the bound object's pose when both are given.

::: tip Which to use
`world.addBody(mesh, options)` for anything you already have a mesh for; `new Body(...)` when
you want to give the mass properties yourself, or the body has no mesh (an invisible floor, a
trigger volume, terrain drawn from its own collider).
:::

## Body types

| Type | Moves? | Forces and gravity | Use for |
| --- | --- | --- | --- |
| `'dynamic'` | Yes, by the simulation | Yes | Anything that falls, tumbles and gets knocked about. |
| `'kinematic'` | Yes, at the velocity you give it | Ignored | Moving platforms, lifts, doors on rails, characters you steer yourself. |
| `'static'` | No | Ignored | Floors, walls, terrain, buildings. |

Only dynamic bodies need mass properties; static and kinematic ones have infinite mass
(`body.mass` is `Infinity`, `body.inverseMass` is 0), and `applyForce`, `applyTorque` and
`applyImpulse` do nothing to them. A body's `type` is fixed when it is made.

A kinematic body moves at whatever `velocity` and `angularVelocity` you set, and pushes dynamic
bodies out of its way as if it were infinitely heavy:

```ts
const platform = world.addBody(platformMesh, { type: 'kinematic', collider: 'box' });

// in the render loop, or better in a behaviour: back and forth along x
platform.velocity.set(Math.sign(Math.sin(world.time * 0.5)) * 1.5, 0, 0);
```

Give a kinematic body velocities rather than moving its position by hand: moved by velocity,
things resting on it are carried along by friction, and it stays awake, keeping whatever it
touches awake too.

## Mass properties

`MassProperties` holds a body's mass (kg), centre of mass (in the body frame) and inertia tensor
(about the centre of mass, in the body frame). The body frame is normally the local frame of the
mesh the body was built from, so `body.position` is where the object's origin is, which is not
necessarily the centre of mass. `body.worldCenterOfMass` is where that is.

### From meshes

`MassProperties.fromMesh(geometry, { mass })` or `{ density }` integrates the solid a closed
triangle mesh encloses, exactly. The mesh must be closed and wound counter-clockwise seen from
outside, as three.js geometry is; otherwise an `InvalidMeshError` explains what is wrong (how
many boundary edges, or that the faces point inward).

```ts
import { MassProperties } from '@eulerjs/core';

const hull = MassProperties.fromMesh(hullGeometry, { mass: 4500 });
const ballast = MassProperties.box(new THREE.Vector3(0.4, 0.3, 2), 1200, new THREE.Vector3(0, -0.8, 0));
const boat = world.addBody(new Body({ object: hullMesh, massProperties: hull.combine(ballast), colliders: hullColliders }));
```

The options' `weldTolerance` sets how close vertices must be to count as one point when checking
the mesh is closed, and `allowOpenMesh: true` skips the check, for meshes whose holes are tiny
compared with the mesh.

For a mesh that isn't closed, such as a boat hull with no deck, fill it with cells instead:
`shape: 'voxels'` in `world.addBody`, or `Voxels.fromGeometry(geometry, { cellSize })` and
`voxels.massProperties({ mass })` yourself. `world.addBody(object)` with the default
`shape: 'mesh'` also falls back on its colliders when the mesh isn't closed and the colliders are
solid, which is why `collider: 'capsule'` works on three's `CapsuleGeometry`.

### From colliders

A dynamic `Body` without `massProperties` is weighed from its solid colliders, at a `density` or
to a total `mass` shared out by volume. Sensors weigh nothing, and planes and heightfields have no
volume, so a dynamic body needs at least one other collider (or explicit mass properties), or it
throws `InvalidMassError`.

```ts
const dumbbell = new Body({
  colliders: [
    new SphereCollider({ radius: 0.15, offset: new THREE.Vector3(-0.4, 0, 0) }),
    new SphereCollider({ radius: 0.15, offset: new THREE.Vector3(0.4, 0, 0) }),
    new CapsuleCollider({ radius: 0.03, length: 0.8, rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2) }),
  ],
  mass: 12,
});
```

### By hand

| Method | Gives |
| --- | --- |
| `MassProperties.box(size, mass, center?)` | A solid box with the given edge lengths. |
| `MassProperties.sphere(radius, mass, center?)` | A solid sphere. |
| `MassProperties.capsule(radius, length, mass, center?)` | A capsule along y; `length` between the centres of its ends. |
| `MassProperties.cylinder(radius, height, mass, center?)` | A cylinder along y. |
| `MassProperties.cone(radius, height, mass, center?)` | A cone along y, tip up, placed as three's `ConeGeometry`. |
| `MassProperties.point(mass, position)` | A point mass; combine it with something that has extent. |
| `MassProperties.fromCells(centres, cellSize, specification)` | A set of equal cubes. |
| `new MassProperties(mass, centerOfMass, inertia)` | Anything, checked to be finite, positive and symmetric. |
| `properties.withMass(mass)` | The same shape with a different mass; the inertia scales with it. |
| `properties.combine(other)` | Two rigidly joined parts as one. |
| `properties.placed(offset, rotation)` | Turned and moved, as for a part placed in a body. |

On a body, `body.mass`, `body.inverseMass` and `body.massProperties` read them;
`body.setMass(mass)` rescales them and `body.setMassProperties(properties)` replaces them. Both
wake the body.

## Pose and velocity

`body.position`, `body.quaternion`, `body.velocity` and `body.angularVelocity` are three.js
vectors and quaternions you can read and change, as you would an `Object3D`'s. Changes take
effect when the world next steps.

- `velocity` is the velocity of the centre of mass; `angularVelocity` is in world space.
- `body.setPose(position, quaternion)` moves a body instantly, without interpolating the drawn
  object from the old pose: use it for teleports and respawns.
- `body.pointVelocity(worldPoint)` is the velocity of the body's material at a point.
- `body.pointToWorld(localPoint)`, `body.localToWorld(vector)`, `body.worldToLocal(vector)` and
  `body.directionToWorld(vector)` convert between the body frame and the world, as the
  `Object3D` methods of the same names do.

```ts
// throw it again, from the start, spinning
crateBody.setPose(new THREE.Vector3(0, 0.5, 0), new THREE.Quaternion());
crateBody.velocity.set(0, 9, 0);
crateBody.angularVelocity.set(1.5, 3, 0.5);
```

## Forces and impulses

| Method | Effect |
| --- | --- |
| `applyForce(force, worldPoint?)` | A force (N) for the next step, through the centre of mass, or at a point in world space, which also turns the body. |
| `applyForceAtLocalPoint(force, localPoint)` | The same, with the point in the body frame. |
| `applyTorque(torque)` | A torque (N·m) for the next step. |
| `applyImpulse(impulse, worldPoint?)` | Changes the velocity at once, as if the impulse (N·s) were delivered at the point. |

Forces and torques add up until the next step, act through it, and are then cleared. Apply
anything continuous (thrust, springs, drag, buoyancy) once per step in a behaviour or a plugin's
`applyForces` hook, not once per frame in the render loop: a frame may run two steps or none.
Impulses are for one-off events (a kick, an explosion, a bullet) and are fine from anywhere.

```ts
const hit = world.castRay(muzzle, aim, { maxDistance: 100 });
if (hit) hit.body.applyImpulse(aim.clone().multiplyScalar(5), hit.point);
```

Any of these with a non-zero amount wakes a sleeping body.

## Gravity scale

`gravityScale` multiplies the world's gravity for one body: 0 for something that floats in place
(a balloon held by its own behaviour, a body carried by a `TargetJoint`), 0.5 for a floaty
pickup, -1 to fall up. The world's own gravity is `world.gravity`, a `Vector3` given to the
constructor (`new World({ gravity })`); change it in place with `world.gravity.set(...)`, and the
next step uses the new value.

## Damping

`linearDamping` and `angularDamping` slow a body down by themselves, as air resistance would,
applied each step as `velocity *= exp(-linearDamping * timestep)` (and likewise for angular
velocity). A damping of 1 takes a body's speed down to about 37% after one second with nothing
else acting; 0, the default, leaves it alone. Both are plain properties you can change at any
time.

## Sleeping

A body that has been still for half a second falls asleep and costs almost nothing until
something wakes it. Still means slower than the world's `sleepSpeed` (0.01 m/s) and turning
slower than `sleepSpin` (0.035 rad/s, about 2° a second) for `timeToSleep` seconds (0.5); all
three are `World` options and properties.

What wakes a body:

- something awake running into it;
- a force, torque or impulse;
- a new pose or velocity set by hand, or a new collider or mass;
- `body.wakeUp()`.

Bodies joined by joints sleep and wake together, since one asleep on its own would act like a
wall to the others. A body touching one that won't sleep (a `canSleep: false` lift, a moving
kinematic platform) stays awake too, so it rides along instead of being left in mid-air.

```ts
const lift = world.addBody(liftMesh, { density: 400, collider: 'box', canSleep: false }); // never sleeps
console.log(crateBody.isSleeping);
crateBody.wakeUp();
```

### Starting asleep

A scene that is set exactly where it should stand doesn't have to settle first: put the bodies
to sleep as soon as they are added, and they wake when disturbed. `body.sleep()` stops a dynamic
body and puts it to sleep at once (it does nothing to static and kinematic bodies):

```ts
for (const chair of chairs) world.addBody(chair, { mass: 4, collider: 'box' }).sleep();
```

## Behaviours

A behaviour is per-body logic that runs once every fixed step while the body is in a world: a
spring, a thruster, buoyancy, a sail. Anything with a `fixedUpdate(body, timestep, world)` method
is one.

```ts
import type { Behavior, Body } from '@eulerjs/core';

/** Holds a body up like a hovering drone, pushing harder the lower it is. */
class Hover implements Behavior {
  constructor(private readonly height: number, private readonly stiffness: number) {}

  fixedUpdate(body: Body): void {
    const depth = this.height - body.position.y;
    if (depth > 0) body.applyForce(new THREE.Vector3(0, depth * this.stiffness - body.velocity.y * 20, 0));
  }
}

const hover = droneBody.addBehavior(new Hover(2, 400));
// later
droneBody.removeBehavior(hover);
```

`addBehavior` returns the behaviour, so you can keep it to change its settings later; its
optional `attach(body)` and `detach(body)` hooks run on adding and removing. `body.behaviors`
lists them. Behaviours run for sleeping bodies too, so a behaviour that pushes every step keeps
its body awake. See [Extending eulerjs](./extending) for the full step order.

## Removing bodies

```ts
world.removeBody(crateBody);
scene.remove(crate); // the mesh is yours to remove
```

`world.removeBody` also removes every joint tying the body to others, ends its contacts (sending
`contactEnd`) and takes it out of any sensors (sending `sensorExit`). It leaves the bound object
in the scene. `world.dispose()` removes every plugin and body at once.

`body.world` is the world a body is in, or `undefined`; a body can be in one world at a time.

## See also

- [Colliders](./colliders): the shapes bodies collide as.
- [Instancing](./instancing): one body per instance of an `InstancedMesh`.
- [Extending eulerjs](./extending): behaviours and plugins in depth.
