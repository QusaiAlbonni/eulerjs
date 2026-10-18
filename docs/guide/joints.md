# Joints

A joint ties two bodies together, or one body to the world, and limits how they may move against
each other. eulerjs has two kinds underneath:

- `DistanceJoint` keeps two points a distance apart: rods, ropes and springs.
- `SixDofJoint` is the general joint. `HingeJoint`, `SliderJoint`, `FixedJoint`,
  `ConeTwistJoint` and `TargetJoint` are settings of it with friendlier names and options.

Both solvers simulate every joint.

```ts
import { ConeTwistJoint, FixedJoint, HingeJoint, SliderJoint, TargetJoint } from '@eulerjs/core';

world.addJoint(new HingeJoint({ bodyA: frame, bodyB: door, anchor: hingePoint, axis: up, limits: { lower: 0, upper: 1.6 } }));
world.addJoint(new HingeJoint({ bodyA: car, bodyB: wheel, anchor: hub, axis: axle, motor: { targetVelocity: 20, maxForce: 300 } }));
world.addJoint(new SliderJoint({ bodyA: shaft, bodyB: lift, anchor: base, axis: up, motor: { targetPosition: 3, stiffness: 5e4, damping: 4e3 } }));
world.addJoint(new ConeTwistJoint({ bodyA: chest, bodyB: upperArm, anchor: shoulder, axis: down, swingLimit: 1.2, twistLimits: { lower: -0.5, upper: 0.5 } }));
world.addJoint(new FixedJoint({ bodyA: wall, bodyB: shelf, anchor: bracket, breakForce: 2000 }));
```

## Adding and removing joints

`world.addJoint(joint)` adds a joint between bodies already in the world (add the bodies first,
or it throws) and returns it. `world.removeJoint(joint)` takes it out, and `world.removeBody`
removes every joint on the body it removes. `world.joints` lists them.

## What every joint takes

| Option | Default | Meaning |
| --- | --- | --- |
| `bodyA` | required | The first body. |
| `bodyB` | the world | The other body; leave it out to tie body A to the world. |
| `collideConnected` | `true` | Whether the two bodies still collide with each other. |
| `breakForce` | Infinity | Breaks once it carries more force than this, in N. |
| `breakTorque` | Infinity | Breaks once it carries more torque than this, in N·m. |

Every joint also reports what it carried on the last step: `joint.force` (N) and `joint.torque`
(N·m) are the load it put on body B, or on body A for a joint to the world, in world space.

## Where a joint is: anchors, axes and frames

Hinges, sliders, fixed, cone-twist and six-dof joints take a world-space `anchor` (the point the
joint is at, body A's origin by default) and `axis` (world x by default), **as the bodies are
now**. The joint works out from them a frame fixed in each body, its x axis along `axis`. So:

- Pose the bodies where they should be joined, then make the joint.
- `axis` is a hinge's axis, a slider's direction and a cone-twist joint's twist axis.
- Limits and targets are measured from the pose the bodies are in when the joint is made: a
  hinge made with the door shut measures its angle from shut.

For full control, give `frameA` and `frameB` instead, each `{ position, quaternion }` in its own
body's frame (or, for `frameB` without body B, in the world). Give both or neither.

## Hinge

Turns about one axis only: a door, a wheel on its axle, an elbow or knee.

```ts
const hinge = world.addJoint(
  new HingeJoint({
    bodyA: doorBody, // tied to the world, since there is no bodyB
    anchor: new THREE.Vector3(-8, 1.15, 0),
    axis: new THREE.Vector3(0, 1, 0),
    limits: { lower: -1.75, upper: 0 }, // opens one way, to 100 degrees
    motor: { targetPosition: 0, stiffness: 150, damping: 60 }, // and swings shut by itself
  }),
);
console.log(hinge.angle); // radians from where it was made
```

`limits` (radians, either way from where it was made; free if left out) and `motor` (a
[drive](#motors-and-drives)) are properties too, so you can change them while it runs.

## Slider

Slides along one axis without turning: a drawer, a piston, a lift.

```ts
const lift = world.addJoint(
  new SliderJoint({ bodyA: carBody, anchor: carMesh.position, axis: new THREE.Vector3(0, 1, 0), limits: { lower: 0, upper: 4 }, motor: { targetVelocity: 1, maxForce: 4000 } }),
);
// every few seconds, turn it round
lift.motor = { ...lift.motor, targetVelocity: -(lift.motor?.targetVelocity ?? 1) };
console.log(lift.position); // metres from where it was made
```

`limits` are in metres either way along the axis.

## Fixed

Holds two bodies together as one, or a body in place in the world, until it breaks:

```ts
world.addJoint(new FixedJoint({ bodyA: plank, bodyB: nextPlank, anchor: seam, breakForce: 6000, collideConnected: false }));
```

If two bodies never come apart, one body with both sets of colliders is cheaper and perfectly
stiff. A fixed joint is for things that should break, or be separated later.

## Cone-twist

A ball joint whose axis may only tilt within a cone and twist within limits: a shoulder, a hip,
a lamp on a chain. It is the joint for ragdolls.

```ts
world.addJoint(
  new ConeTwistJoint({
    bodyA: chest,
    bodyB: upperArm,
    anchor: shoulder,
    axis: new THREE.Vector3(0, -1, 0), // the arm hangs down from the shoulder
    swingLimit: { aboutY: 1.4, aboutZ: 0.6 }, // an oval cone; a single number makes a round one
    twistLimits: { lower: -0.5, upper: 0.5 },
    friction: 2,
  }),
);
```

`swingLimit` is how far the axis may tilt from where it was, in radians: one angle for a round
cone, or one about each of the joint's y and z axes for an oval one. Left out, it tilts freely;
leave out `twistLimits` too and it is a plain ball joint. It also takes an
[`orientationDrive`](#orientation-drives).

## Six degrees of freedom

`SixDofJoint` is the general case. For each of the six ways frame B can move against frame A
(along its x, y and z axes, twisting about x, swinging about y and z) you say whether it is
`'locked'`, `'free'`, or limited to `{ lower, upper }` (metres or radians), and optionally give it a
drive.

```ts
import { SixDofJoint } from '@eulerjs/core';

// a hook on a crane's trolley: driven along the rail (x), swinging a little either way, never twisting
world.addJoint(
  new SixDofJoint({
    bodyA: gantry,
    bodyB: hook,
    anchor: trolleyPoint,
    axis: new THREE.Vector3(1, 0, 0),
    linear: [{ lower: -5, upper: 5 }, 'locked', 'locked'],
    angular: ['locked', { lower: -0.4, upper: 0.4 }, { lower: -0.4, upper: 0.4 }],
    linearDrives: [{ targetVelocity: 0.5, maxForce: 800 }, undefined, undefined],
  }),
);
```

- `linear`: along frame A's x, y and z. Defaults to all locked.
- `angular`: twist about the moving frame's x, swing about y and z. Defaults to all locked.
- `linearDrives`, `angularDrives`: one drive (or `undefined`) per axis.
- `orientationDrive`: see below.
- `friction` and `linearFriction`: see [Joint friction](#joint-friction).

`joint.measure()` says where the moving frame is against the base one now: `linear` (a `Vector3`
in metres), `twist` and `swing` (radians). For a joint to the world, the world's frame is the
base and body A's moves, so either way what is measured is how the second body moves.

## Motors and drives

A drive pushes an axis toward a target as a spring and damper with a force limit:

```
force = stiffness × (targetPosition − position) + damping × (targetVelocity − velocity), at most maxForce
```

| `JointDrive` field | Default | Meaning |
| --- | --- | --- |
| `targetPosition` | | Where to hold the axis: metres or radians. |
| `targetVelocity` | 0 | m/s or rad/s. |
| `stiffness` | 0 | N/m or N·m/rad. |
| `damping` | infinite without a stiffness, 0 with one | N·s/m or N·m·s/rad. |
| `frequency`, `dampingRatio` | | Instead of stiffness and damping: see below. |
| `maxForce` | Infinity | N, or N·m on an angular axis. |

Two settings cover most uses:

- **A motor** holds a speed: `targetVelocity` alone, with a `maxForce`. Its damping is infinite by
  default, so it holds the speed as hard as the force limit allows.

  ```ts
  motor: { targetVelocity: 2, maxForce: 400 } // a windmill turning at 2 rad/s, with at most 400 N·m
  ```

- **A servo** holds a position: `targetPosition` with a `stiffness`, and some `damping` so it
  doesn't ring.

  ```ts
  motor: { targetPosition: 0, stiffness: 150, damping: 60 } // a door that closes itself
  ```

Drives are solved implicitly, so any stiffness is stable: a very stiff servo is simply a stiff
one, not an explosion.

### Frequency and damping ratio

Picking a stiffness means knowing how heavy the thing it moves is. Give a `frequency` (in Hz) and
a `dampingRatio` instead, and the engine works out the stiffness and damping from the mass along
the axis (turning about the joint's point, if it holds one), so the axis springs to its target
at that rate whatever it carries. A damping ratio of 1, the default, just doesn't overshoot; less
rings, more is sluggish.

```ts
motor: { targetPosition: 0.5, frequency: 3, dampingRatio: 1, maxForce: 200 }
```

### Orientation drives

An `orientationDrive` (on a `SixDofJoint` or a `ConeTwistJoint`) turns the moving frame toward a
target orientation, relative to the base frame, about whichever axis gets it there: the servo for
ball joints, a muscle for active ragdolls. It takes `target` (a `Quaternion`), `stiffness` and
`damping` or `frequency` and `dampingRatio`, and `maxTorque`.

```ts
const hip = world.addJoint(
  new ConeTwistJoint({ bodyA: pelvis, bodyB: thigh, anchor: hipPoint, axis: down, swingLimit: 1.2, orientationDrive: { target: new THREE.Quaternion(), frequency: 6, maxTorque: 300 } }),
);
// each step of the walk cycle: lift the leg forward
hip.orientationDrive!.target.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.6);
```

Under soft step, orientation drives reach their target more slowly than under XPBD.

## Joint friction

`friction` (N·m) makes every angular axis the joint doesn't lock resist turning with up to that
much torque, as a stiff hinge or tensed muscles do; on a joint that locks no angular axis, such as
a ball joint, it resists turning every way alike. `linearFriction` (N) does the same along the
free linear axes. Friction is what lets a lid stay where it is opened, and a ragdoll's limbs come
to rest instead of swinging for ever.

```ts
world.addJoint(new HingeJoint({ bodyA: box, bodyB: lid, anchor: back, axis: side, friction: 5 })); // stays where it is opened
```

::: warning Ball joints under XPBD
Under the XPBD solver, a ball joint's friction acts on velocities only, so it creeps a little
under a steady load. Hinges and sliders, and every joint under soft step, hold still.
:::

## Target joints

`TargetJoint` pulls one body toward a pose in the world, as a spring with force and torque
limits: for dragging something with the mouse, carrying it, or leading an active ragdoll by its
hips. Move the target with `setTarget` as often as you like.

```ts
const grab = world.addJoint(new TargetJoint({ body: crate, anchor: handle, frequency: 4, maxForce: 800 }));

// each frame, while the mouse is down
grab.setTarget(pointerInWorld);

// let go
world.removeJoint(grab);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `body` | required | The body to pull. |
| `anchor` | its origin | The point pulled, in the body's frame. |
| `position` | where the anchor is | Where to pull it to, in world space. |
| `quaternion` | how it is turned | The orientation to turn it to. |
| `frequency` | 5 | How fast it springs to the target, in Hz, whatever its mass. 0 lets go. |
| `turnFrequency` | `frequency` | How fast it turns to the target orientation, if not as fast. |
| `dampingRatio` | 1 | 1 just doesn't overshoot. |
| `maxForce`, `maxTorque` | Infinity | Limits on the pull (per axis) and the turn. |
| `turns` | true | Whether it turns the body as well as pulling it. |
| `breakForce`, `breakTorque` | Infinity | As for every joint. |

`setTarget(position, quaternion?, velocity?)` moves the target; give the target's own velocity
too when it moves steadily (a hand carrying something while walking), and the body keeps up
instead of lagging behind. `joint.target` is the current target and `joint.frequency` can be
changed.

A target joint holding a body up against gravity sags by g / (2π · frequency)²: about 1 cm at
5 Hz. Set the body's `gravityScale` to 0 while it is held to have it hold the pose exactly.

## Distance joints

`DistanceJoint` keeps a point on body A a distance from a point on body B, or from a fixed point
in the world:

```ts
import { DistanceJoint } from '@eulerjs/core';

// a pendulum: a bob 3 m from a pivot in the world
world.addJoint(new DistanceJoint({ bodyA: bob, anchorB: pivot }));

// a lamp on a rope: holds it up, but goes slack when pushed closer
world.addJoint(new DistanceJoint({ bodyA: lamp, anchorA: hook, anchorB: ceilingPoint, slack: true }));

// a link in a chain
world.addJoint(new DistanceJoint({ bodyA: link, bodyB: nextLink, anchorA: new THREE.Vector3(0, -0.2, 0), anchorB: new THREE.Vector3(0, 0.2, 0) }));
```

| Option | Default | Meaning |
| --- | --- | --- |
| `anchorA` | its origin | Where it holds body A, in A's frame. |
| `anchorB` | its origin | Where it holds body B, in B's frame; without body B, the fixed point in world space. |
| `length` | the distance now | The distance to keep. |
| `compliance` | 0 | Softness in m/N: 0 is a rigid rod; larger stretches like a spring of stiffness 1 / compliance. |
| `slack` | false | Like a rope: resists stretching only. |
| `damping` | 0 | How fast motion along it dies out, per second. |

`joint.tension` is the tension it carried on the last step, in N (0 while a rope is slack), and
`joint.currentAnchors()` gives both anchors in world space and the distance between them. All its
settings can be changed between steps.

## Collisions between joined bodies

Joined bodies collide with each other unless the joint says otherwise. Turn it off for parts that
overlap where they are joined, such as a ragdoll's thigh and shin, or planks welded edge to edge:

```ts
new HingeJoint({ bodyA: thigh, bodyB: shin, anchor: knee, axis: side, collideConnected: false });
new ConeTwistJoint({ bodyA: chest, bodyB: upperArm, anchor: shoulder, axis: down, collideConnected: 'unlessOverlapping' });
```

`'unlessOverlapping'` decides when the joint is added: the bodies collide unless their colliders
overlap then, as joined limbs do and a shoulder that clears the chest doesn't. Read the outcome
from `joint.collideConnected` (and what you asked for from `joint.collideConnectedSetting`); it is
fixed once the joint is in a world. For bodies that aren't joined directly,
`world.setCollisionsBetween(bodyA, bodyB, false)` does the same.

## Breaking

A joint with a `breakForce` or `breakTorque` breaks when it carries more on a step: the world
removes it, sets `joint.broken`, and sends a `jointBreak` event with the joint and the force and
torque it carried.

```ts
world.on('jointBreak', ({ joint, force }) => {
  console.log(`a joint broke carrying ${force.toFixed(0)} N`);
});
```

## Joints and sleeping

Bodies joined by joints sleep together, once every one of them has been still long enough, and
wake together: one asleep on its own would act like a wall to the others.

## See also

- [Examples](/examples/): the `joints` example (a self-closing door, a windmill, a lift, a lamp, a
  bridge that breaks) and the city's active ragdolls.
- [Solvers and stepping](./solvers): substeps, and how stiff joints are under each solver.
- [Queries and events](./queries): `jointBreak` with the other world events.
