# Colliders

A collider is a shape a body collides as. A body can have any number of them, each placed in the
body's frame, and each with its own material (friction, restitution, rolling resistance) and
collision filter. A body without colliders is simulated but touches nothing, and that is what
`world.addBody(mesh)` makes unless you give it a `collider`: the mass is worked out from the mesh,
the collision shape is your choice (see [Bodies](./bodies#from-a-three-js-object)).

## Adding colliders

### Shorthands, fitted to a mesh

When a body is made from a three.js object, `collider` can name a shape to fit around the
object's meshes:

```ts
world.addBody(crate, { density: 300, collider: 'box' });
world.addBody(rock, { density: 2500, collider: 'convex' });
world.addBody(barrel, { density: 400, collider: 'cylinder' });
```

| Shorthand | Fitted as |
| --- | --- |
| `'box'` | The meshes' bounding box. |
| `'sphere'` | Their bounding sphere. |
| `'convex'` | Their convex hull. |
| `'cylinder'` | A cylinder standing along y, as tall as the bounds and as wide as the wider of x and z. |
| `'cone'` | A cone standing along y, tip up, fitted the same way. |
| `'capsule'` | A capsule standing along y, fitted the same way. |

The round shapes stand along y because three.js's `CylinderGeometry`, `ConeGeometry` and
`CapsuleGeometry` do. The fit is in the object's frame, so a turned object gets a turned
collider. Shorthands need meshes to fit to: on an object without any they throw
`InvalidMeshError`.

### Collider instances

Anything else is a collider instance, passed as `collider` (one or an array) to
`world.addBody(object, ...)`, or as `colliders` to `new Body(...)`:

```ts
import { Body, BoxCollider, PlaneCollider, SphereCollider } from '@eulerjs/core';

world.addBody(floor, { type: 'static', collider: new PlaneCollider({ friction: 0.8 }) });
world.addBody(ball, { collider: new SphereCollider({ radius: 0.35, restitution: 0.6 }) });
world.addBody(new Body({ type: 'static', colliders: [new BoxCollider({ size: new THREE.Vector3(10, 0.2, 10) })] }));
```

### Several colliders on one body

There is no separate compound shape: a body with several colliders is one. Place each with
`offset` and `rotation` in the body's frame.

```ts
const legCorners = [
  new THREE.Vector3(-0.75, 0.36, -0.4),
  new THREE.Vector3(0.75, 0.36, -0.4),
  new THREE.Vector3(-0.75, 0.36, 0.4),
  new THREE.Vector3(0.75, 0.36, 0.4),
];
const table = world.addBody(
  new Body({
    object: tableMesh,
    density: 600,
    colliders: [
      new BoxCollider({ size: new THREE.Vector3(1.6, 0.05, 0.9), offset: new THREE.Vector3(0, 0.75, 0) }),
      ...legCorners.map((corner) => new BoxCollider({ size: new THREE.Vector3(0.05, 0.72, 0.05), offset: corner })),
    ],
  }),
);
```

`body.addCollider(collider)` and `body.removeCollider(collider)` change them later, and wake the
body; `body.colliders` lists them.

## Options every collider takes

`ColliderOptions`, shared by every collider class:

| Option | Default | Meaning |
| --- | --- | --- |
| `offset` | origin | Where the collider sits in its body's frame. |
| `rotation` | identity | How it is turned in its body's frame. |
| `friction` | 0.5 | Coulomb friction coefficient. Two colliders use the geometric mean of theirs. |
| `restitution` | 0 | Bounciness, 0 (none) to 1 (perfectly elastic). Two colliders use the larger. |
| `rollingResistance` | 0.02 on round shapes, otherwise 0 | Resistance to rolling, as a share of the load. Two colliders use the larger. |
| `collisionGroups` | 1 | Bit mask of the groups this collider is in. |
| `collidesWith` | every group | Bit mask of the groups it collides with. |
| `sensor` | false | Detects overlaps without pushing. See [Sensors](#sensors). |

Materials and filters are plain properties and can be changed at any time; the backend reads
them every step.

## The shapes

### `SphereCollider`

```ts
new SphereCollider({ radius: 0.3 });
```

### `BoxCollider`

```ts
new BoxCollider({ size: new THREE.Vector3(1, 0.5, 2) }); // full edge lengths, not half
```

`halfExtents` holds half the size.

### `CapsuleCollider`

A cylinder with rounded ends along its y axis: the usual shape for limbs and characters.

```ts
new CapsuleCollider({ radius: 0.3, length: 1 }); // `length` is between the centres of the ends
```

Its total height is `length + 2 * radius`; a `length` of 0 makes a sphere.

### `CylinderCollider`

A solid cylinder along its y axis, centred on its origin like `CylinderGeometry`: a barrel, a log,
a wheel.

```ts
new CylinderCollider({ radius: 0.4, height: 1 });
```

Its mass properties and ray casts are exact, and so are its contacts with planes and spheres, so
a barrel rolls smoothly on the ground. Against other shapes it collides as a 16-sided prism
around the round shape.

### `ConeCollider`

A solid cone along its y axis, tip up, centred halfway up like `ConeGeometry`: a traffic cone.

```ts
new ConeCollider({ radius: 0.35, height: 0.8 });
```

Its mass properties, ray casts and contacts with planes are exact; against other shapes it
collides as a 16-sided pyramid. Its centre of mass is a quarter of the height below its centre,
as a solid cone's is.

### `ConvexCollider`

The convex hull of a set of points: a rock, a bevelled crate, the rough shape of a model.
Coplanar triangles are merged into one face, so a box-shaped hull has six square faces, which is
what gives whole contact patches.

```ts
import { ConvexCollider } from '@eulerjs/core';

const wedge = new ConvexCollider({
  points: [
    new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0, -0.5),
    new THREE.Vector3(-0.5, 0, 0.5), new THREE.Vector3(0.5, 0, 0.5),
    new THREE.Vector3(-0.5, 0.6, -0.5), new THREE.Vector3(0.5, 0.6, -0.5),
  ],
});
const rock = ConvexCollider.fromGeometry(new THREE.IcosahedronGeometry(0.5, 1)); // the hull of a geometry's vertices
```

Its mass properties are exact for the hull. The points must span a volume (not a line or a
plane), or it throws `InvalidMeshError`. `vertices`, `faces` and `edges` describe the hull, and
`toGeometry()` gives it back as triangles, to draw it.

::: tip Keep hulls small
A hull's collision cost grows with its number of edges. Keep hulls to about 32 corners: for a
detailed model, `collider: 'convex'` on a simplified copy of the mesh, or a few boxes and
spheres, collide as well and cost far less.
:::

### `PlaneCollider`

An infinite flat ground: everything on the side its normal points away from is solid. Its normal
is the collider's +y axis; turn it with `rotation`.

```ts
const slope = new PlaneCollider({ rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3), friction: 0.3 });
world.addBody(new Body({ type: 'static', colliders: [slope] }));
```

Planes are for static and kinematic bodies only: they have no volume to weigh.

### `HeightfieldCollider`

Terrain from a grid of heights, centred on the collider's origin, each cell split into two
triangles:

```ts
import { Body, HeightfieldCollider } from '@eulerjs/core';

const cells = 64;
const heights = Array.from({ length: cells + 1 }, (_unused, row) =>
  Array.from({ length: cells + 1 }, (_unusedToo, column) => 3 * Math.sin(row / 7) * Math.cos(column / 9)),
);
const terrain = new HeightfieldCollider({ heights, cellSize: 1, friction: 0.8 });
world.addBody(new Body({ type: 'static', colliders: [terrain] }));
scene.add(new THREE.Mesh(terrain.toGeometry(), groundMaterial)); // draw exactly what things roll on
```

- `heights[row][column]` are heights along the collider's y axis, rows running along z and
  columns along x. Every row needs the same number of columns, and at least two of each.
- `cellSize` is the distance between neighbouring points, along both x and z.
- `thickness` (1 m by default) is how deep below its lowest point the terrain counts as solid,
  so whatever sinks into it, however far, is still pushed back out of the top.
- `surfaceHeight(localX, localZ)` is the ground's height at a point of the collider's frame, or
  `undefined` off the grid: handy for placing things on the ground.
- `width`, `depth`, `heightAt(row, column)` and `pointAt(row, column, target)` describe the grid.
- `toGeometry()` returns the surface as an indexed geometry with normals, triangle for triangle
  what it collides as.

The edges between nearly flat neighbouring triangles never push on their own, so bodies slide
and roll across them without catching. Heightfields are for static and kinematic bodies only.

### `MeshCollider` (in `@eulerjs/bvh`)

Any triangle mesh as a collider, solid on both sides, for levels, buildings and sculptures:

```ts
import { MeshCollider } from '@eulerjs/bvh';

world.addBody(new Body({ type: 'static', position: sculpture.position, colliders: [new MeshCollider({ geometry: knotGeometry })] }));
```

See [BVH](/bvh).

## Materials

### Friction

Friction is Coulomb's, decided for each patch of contact (a box's face on the floor, say) rather
than for each point, so boxes stay put on slopes gentler than their friction angle and tall
stacks stand still. Two touching colliders use the geometric mean of their coefficients, so a
collider with friction 0 is slippery against everything. The default is 0.5.

### Restitution

How much of the speed into a hit comes back out of it: 0 lands dead, 1 bounces back to where it
fell from. Two colliders use the larger, so a bouncy ball bounces on any floor.

### Rolling resistance

Spheres, capsules, cylinders and cones roll without slipping, and without it they would roll for
ever on a flat floor. `rollingResistance` holds a rolling body back with a torque of at most this
times the contact force times its radius, as a real ball's deformation does, so it slows down
and comes to rest; it also stops a body spinning on the spot. About 0.002 for steel on steel,
0.01 for a ball on a hard floor, 0.05 or more for something soft. Two colliders use the larger.

Those four shapes have `ROUND_ROLLING_RESISTANCE`, 0.02, unless given their own, so a barrel or
a traffic cone knocked over comes to rest instead of rolling away for good: one knocked rolling
at 1.5 m/s stops in about 12 s. Every other shape has 0. For an ideal ball that never slows,
give it 0.

```ts
new SphereCollider({ radius: 0.11, restitution: 0.7, rollingResistance: 0.01 }); // a football on grass would want more
```

## Collision filtering

### Groups

Every collider is in some groups (`collisionGroups`, a bit mask, group 1 by default) and collides
with some groups (`collidesWith`, every group by default). Two colliders collide only if each is
in a group the other collides with.

```ts
const SCENERY = 0b001;
const PLAYER = 0b010;
const DEBRIS = 0b100;

// debris hits the scenery and other debris, but passes through the player
new BoxCollider({ size: fragmentSize, collisionGroups: DEBRIS, collidesWith: SCENERY | DEBRIS });
new CapsuleCollider({ radius: 0.3, length: 1, collisionGroups: PLAYER, collidesWith: SCENERY | PLAYER });
```

`collider.canCollideWith(other)` tells you whether two colliders' filters let them collide.
Scene queries take a `collidesWith` mask too (see [Queries and events](./queries)).

### Between particular bodies

`world.setCollisionsBetween(bodyA, bodyB, false)` stops two bodies in the world colliding, and
`true` lets them again: parts of a ragdoll one joint apart, say, which touch when it folds up.
For bodies tied by a joint, the joint's `collideConnected` option does the same (see
[Joints](./joints#collisions-between-joined-bodies)).

## Sensors

A collider with `sensor: true` notices what overlaps it without pushing it: a trigger volume, a
finish line, a pickup. It adds no mass, and scene queries skip it unless asked to include sensors.

```ts
const zone = new BoxCollider({ size: new THREE.Vector3(4, 2, 3), sensor: true });
world.addBody(zoneMesh, { type: 'static', collider: zone });
world.on('sensorEnter', ({ sensor, body }) => {
  if (sensor === zone) console.log('entered', body);
});
```

See [Queries and events](./queries#sensors) for `sensorEnter`, `sensorExit` and `world.inSensor`.

## Drawing what collides

`ConvexCollider`, `HeightfieldCollider` and `@eulerjs/bvh`'s `MeshCollider` have `toGeometry()`,
which returns their triangles in the collider's frame, to draw exactly what things collide with.
The other shapes match three.js's own geometries: `BoxGeometry(size.x, size.y, size.z)`,
`SphereGeometry(radius)`, `CylinderGeometry(radius, radius, height)`, `ConeGeometry(radius, height)`
and `CapsuleGeometry(radius, length)`.

## See also

- [Bodies](./bodies): how colliders give bodies their mass.
- [Queries and events](./queries): casting rays and shapes at colliders, sensors and contact events.
- [Extending eulerjs](./extending): teaching the engine new collider shapes.
