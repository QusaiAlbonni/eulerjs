# Queries and events

The world answers questions about its colliders (what does this ray hit, where would this capsule
stop, what is inside this sphere) and tells you what happened during each step (contacts began
and ended, things entered and left sensors, joints broke).

```ts
const hit = world.castRay(muzzle, aim, { maxDistance: 100, exclude: player });
if (hit) hit.body.applyImpulse(aim.clone().multiplyScalar(5), hit.point);

const ground = world.castShape(new CapsuleCollider({ radius: 0.3, length: 1 }), feet, down, { maxDistance: 0.2 });
const caught = world.overlap(new SphereCollider({ radius: 4 }), blastCentre);
```

## Ray casts

`world.castRay(origin, direction, options?)` finds the first collider a ray meets.
`world.castRayAll(origin, direction, options?)` finds every one, nearest first.

```ts
const hit = world.castRay(eye, lookDirection, { maxDistance: 50 });
if (hit) {
  console.log(hit.body, hit.collider.shape, hit.distance, hit.point, hit.normal);
}

const everythingInLine = world.castRayAll(eye, lookDirection, { maxDistance: 50 });
```

A hit (`QueryHit`) has:

| Field | Meaning |
| --- | --- |
| `body` | The body hit. |
| `collider` | Which of its colliders. |
| `distance` | How far along the ray, in metres: 0 if it started inside. |
| `point` | Where, on the collider's surface. |
| `normal` | The surface normal there, pointing back toward the ray. |

The direction needn't be a unit vector, but it mustn't be zero (that throws). A ray that starts
inside a solid meets it at once, at distance 0. Heightfield terrain is met from above only: a
ray coming up from beneath it passes through.

### With three.js raycasting

Use eulerjs's ray casts for gameplay (line of sight, bullets, ground checks): they hit what
bodies collide as, colliders without meshes included, and they are fast. Use three.js's
`Raycaster` for picking what is drawn, and `world.bodyOf(object)` to find the body behind it:

```ts
const intersection = raycaster.intersectObjects(scene.children).find((candidate) => world.bodyOf(candidate.object));
const picked = intersection && world.bodyOf(intersection.object, intersection.instanceId);
```

`bodyOf` walks up from the object through its parents, so it finds the body of a mesh nested
inside a bound group. For an `InstancedMesh`, pass the hit's `instanceId` too.

## Shape casts

`world.castShape(shape, position, direction, options?)` slides a convex shape from `position`
along `direction` until it first touches a collider, and returns where (a `QueryHit`, or
`undefined`). The shape needn't belong to any body. It is the usual way to move a character or
check that something fits.

```ts
import { CapsuleCollider } from '@eulerjs/core';

const characterShape = new CapsuleCollider({ radius: 0.35, length: 0.9 });
const ahead = world.castShape(characterShape, character.position, walkDirection, { maxDistance: 0.3, exclude: character });
if (ahead) walkDirection.negate(); // something in the way: turn round
```

`options.quaternion` turns the shape (unturned by default). The shape may be a sphere, capsule,
box, convex hull, cylinder or cone; a plane, heightfield or mesh can't be cast, and throws an
`EulerError`. A shape that starts out overlapping something touches it at once, at distance 0.

## Overlap tests

`world.overlap(shape, position, options?)` lists every collider that a convex shape at
`position` overlaps or touches, as `{ body, collider }` pairs (`OverlapHit`). A body with several
colliders can appear more than once.

```ts
const caught = world.overlap(new SphereCollider({ radius: 3 }), blastCentre);
const pushed = new Set<Body>();
for (const { body } of caught) {
  if (body.type !== 'dynamic' || pushed.has(body)) continue;
  pushed.add(body);
  const away = body.position.clone().sub(blastCentre).add(new THREE.Vector3(0, 1, 0)).normalize();
  body.applyImpulse(away.multiplyScalar(body.mass * 6));
}
```

It takes `quaternion` like `castShape`, and the same shapes. A shape sunk below heightfield
terrain counts as overlapping it.

## Filtering queries

Every query takes the same filter options (`QueryFilter`):

| Option | Default | Meaning |
| --- | --- | --- |
| `collidesWith` | every group | Only colliders in one of these collision groups. |
| `includeSensors` | false | Whether sensors are found too. |
| `exclude` | none | A body, or an array of bodies, to ignore: the one doing the looking, say. |
| `filter` | none | `(body, collider) => boolean`: return false to skip a collider. |

Ray and shape casts also take `maxDistance` (metres, Infinity by default).

```ts
const VISIBLE = 0b0001;
const target = world.castRay(eye, toTarget, {
  maxDistance: toTarget.length(),
  collidesWith: VISIBLE,
  exclude: [guard, heldLantern],
  filter: (body) => body.type !== 'kinematic',
});
```

## How queries see the world

Queries search a bounding volume tree of every collider, so their cost grows slowly with the size
of the world. They see bodies where they are now: bodies added since the last step, and bodies
you moved by hand, are found where you put them. Noticing hand-moved bodies costs a look at every
body per query, about 10 ns each, which only matters with many thousands of bodies and many
queries per frame.

Queries see the bodies at their latest step, not where they are drawn (which is up to one step
behind; see [Getting started](./getting-started#interpolation)).

## Sensors

A collider with `sensor: true` notices what overlaps it without pushing it, and adds no mass to
its body:

```ts
import { BoxCollider } from '@eulerjs/core';

const zone = new BoxCollider({ size: new THREE.Vector3(4, 2, 3), sensor: true });
world.addBody(zoneMesh, { type: 'static', collider: zone });

world.on('sensorEnter', ({ sensor, body }) => console.log(body, 'came into', sensor));
world.on('sensorExit', ({ sensor, body }) => console.log(body, 'left', sensor));

// what is inside it now
const inside = world.inSensor(zone).map((overlap) => overlap.body);
```

`world.inSensor(sensor)` lists every collider in a sensor as of the last step, with its body:
what `sensorEnter` brought in and `sensorExit` hasn't taken out, including bodies asleep in it.
Sensors are tracked whether or not anything listens, so `inSensor` always works.

A sensor can be on a body of any type: a static zone, a kinematic sweep that moves over resting
bodies (it still notices them), or a dynamic body's pickup radius. Scene queries skip sensors
unless you pass `includeSensors: true`.

## Contacts

`world.contacts` lists the contacts that pushed bodies apart during the last step, one for each
touching point (`Contact`):

| Field | Meaning |
| --- | --- |
| `bodyA`, `bodyB`, `colliderA`, `colliderB` | What touched. |
| `point` | Where, in world space. |
| `normal` | Unit vector from B toward A. |
| `depth` | How far the colliders overlapped when the contact was found, in metres (negative for a gap). |
| `normalImpulse` | The impulse along the normal over the whole step, in N·s. |

`normalImpulse / world.timestep` is the average force a contact carried: for impact sounds,
damage, or pressure plates.

```ts
for (const contact of world.contacts) {
  const force = contact.normalImpulse / world.timestep;
  if (force > 5000) playThud(contact.point, force);
}
```

## Events

`world.on(name, listener)` calls you after each step, and returns a function that stops it
(`world.off(name, listener)` does the same). Listeners run inside `world.update` / `step` /
`fixedStep`, once per fixed step.

| Event | Payload | Sent when |
| --- | --- | --- |
| `contactBegin` | `ContactEvent` | Two colliders begin to push on each other. |
| `contactEnd` | `ContactEvent` | They stop touching, or one of their bodies is removed. |
| `sensorEnter` | `SensorEvent` | Something begins to overlap a sensor. |
| `sensorExit` | `SensorEvent` | It stops, or is removed. |
| `jointBreak` | `JointBreakEvent` | A joint breaks; the world has already removed it. |

- `ContactEvent`: `bodyA`, `bodyB`, `colliderA`, `colliderB`, and `contacts`, the touching points
  on the step they began (empty for `contactEnd`).
- `SensorEvent`: `sensor` and `sensorBody`, and the `collider` and `body` that came in or left.
  A collider in two sensors sends an event for each.
- `JointBreakEvent`: `joint`, and the `force` (N) and `torque` (N·m) it carried on the step it
  broke.

```ts
const stopListening = world.on('contactBegin', ({ bodyA, bodyB, contacts }) => {
  for (const body of [bodyA, bodyB]) flash(body);
});
// later
stopListening();
```

Bodies asleep together still count as touching, and a body asleep in a sensor is still in it:
sleeping doesn't end contacts or send `sensorExit`.

::: tip Contact events cost only while you listen
The world tracks which pairs touch from step to step only while something listens to
`contactBegin` or `contactEnd`. Add the listener before the step you care about: a pair that was
already touching when you started listening counts as beginning on the next step.
:::

## See also

- [Colliders](./colliders): collision groups and the `sensor` option.
- [Instancing](./instancing): `bodyOf` with instanced meshes.
- [Examples](/examples/): the `queries` and `sensors` examples.
