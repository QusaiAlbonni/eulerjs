# Ray-cast vehicles

`@eulerjs/vehicle` drives a body on wheels the way most games do: each wheel is a **ray** cast
down from where its suspension is mounted on the chassis, a **spring and damper** between the
mount and whatever ground the ray meets, and a **tyre** that grips up to a limit and slides
beyond it. The chassis is one ordinary body; the wheels are not bodies at all. For a racing car,
[slip tyres](#slip-tyres) give each wheel a spin of its own and a tyre curve.

```sh
npm install @eulerjs/vehicle @eulerjs/core three
```

It needs three 0.166 or later.

```ts
import { Vector3 } from 'three';
import { Body, BoxCollider, MassProperties } from '@eulerjs/core';
import { RaycastVehicle } from '@eulerjs/vehicle';

const chassisSize = new Vector3(1.75, 0.7, 4.1);
const chassis = world.addBody(
  new Body({
    massProperties: MassProperties.box(chassisSize, 1200),
    position: new Vector3(0, 0.72, 0), // its ride height: see below
    colliders: [new BoxCollider({ size: chassisSize, friction: 0.4 })],
    canSleep: false,
  }),
);

const mounts = [new Vector3(0.78, -0.15, 1.3), new Vector3(-0.78, -0.15, 1.3), new Vector3(0.78, -0.15, -1.25), new Vector3(-0.78, -0.15, -1.25)];
const vehicle = chassis.addBehavior(
  new RaycastVehicle({
    wheels: mounts.map((mount) => ({ mount, radius: 0.32, suspensionLength: 0.35, springStiffness: 30_000, springDamping: 2400 })),
  }),
);

// whenever the driver does something: steer the front wheels, drive them, brake all four
vehicle.wheels[0].steerAngle = vehicle.wheels[1].steerAngle = 0.3;
vehicle.wheels[0].driveForce = vehicle.wheels[1].driveForce = 1500;
for (const wheel of vehicle.wheels) wheel.brakeForce = 0;
```

`RaycastVehicle` is a [behaviour](/guide/bodies): it acts every fixed step, pushing on the
chassis (and on the ground) where each tyre touches. The chassis still collides as its own
colliders, so it scrapes walls and lands on its roof; the wheels touch the world only through
their rays.

::: tip Keep the car awake
Give the chassis `canSleep: false`. A parked car falls asleep like any still body, and its wheels
with it, waiting for something to push it before it notices the driver.
:::

## The vehicle

| Option | Default | What it is |
| --- | --- | --- |
| `wheels` | required | One `WheelOptions` for each wheel. |
| `up` | +y | The chassis' up axis, in its own frame: the wheels hang down it. |
| `forward` | +z | The chassis' forward axis, in its own frame. |
| `sidewaysResponse` | `0.5` | The share of a wheel's sideways slip its tyre takes out each step, grip allowing. All of it at once would overshoot, the other wheels pulling the same way. |
| `tyres` | `'grip'` | `'grip'`: each tyre grips up to a limit and slides beyond it, its wheel turning with the ground. `'slip'`: each wheel spins of its own, and its tyre pulls with how much it slips. See [Slip tyres](#slip-tyres). |
| `surface` | none | `(point, hit) => GroundSurface`: what the ground is like where a wheel touches it. See [What the ground is like](#what-the-ground-is-like). |

`vehicle.wheels` are the `Wheel`s, in the order given, and `vehicle.forwardSpeed(body)` the body's
speed along its forward axis, in m/s: negative going backward.

## Wheels

| Wheel option | Default | What it is |
| --- | --- | --- |
| `mount` | required | Where the suspension is fixed to the chassis, in the body's frame. The wheel hangs below it, down the body's up axis. |
| `radius` | required | In metres. |
| `suspensionLength` | required | How far below the mount the wheel's centre hangs with its spring unloaded, in metres: how far it can travel. |
| `springStiffness` | required | In N/m. |
| `springDamping` | required | In N·s/m. |
| `grip` | `1` | The most force the tyre takes along the ground, as a share of the load on it: about 1 on dry asphalt. |
| `rollingResistance` | `0.015` | The force against the tyre's rolling, as a share of the load on it. |

With `tyres: 'slip'`, each wheel also takes:

| Wheel option | Default | What it is |
| --- | --- | --- |
| `inertia` | `1` | The wheel's moment of inertia about its axle, tyre, rim and brake disc together, in kg·m². |
| `peakSlipAngle` | `0.1` | The slip angle the tyre corners hardest at, in radians: about 6°. |
| `peakSlipRatio` | `0.1` | The slip ratio, (spin × radius − speed) / speed, the tyre pulls or brakes hardest at. |
| `slidingGrip` | `0.75` | The grip left when the tyre slides well past its peak, as a share of it: above 0, below 1. |
| `loadSensitivity` | `0.1` | How much less the tyre grips for each newton as it is loaded: k in grip × (load / nominalLoad)^−k. Twice the load gives 7% less grip a newton at 0.1. |
| `nominalLoad` | its share of the weight | The load, in newtons, the tyre grips by `grip` at. |

### Choosing the springs

The spring carries the car's weight: with the weight shared evenly by four wheels, each spring
is compressed by `mass × gravity / 4 / springStiffness`. The city's hatchback, 1200 kg on four
30 000 N/m springs, sits about 10 cm down on them, a little under a third of their 35 cm of
travel, which leaves room for bumps both ways. Its damping, 2400 N·s/m, is about 0.4 of critical,
so the body settles after a bump or two.

The chassis' **ride height**, where to put it so it starts at rest on its springs, follows from
that:

```ts
function rideHeight(mountHeight: number, suspensionLength: number, wheelRadius: number, compression: number): number {
  return -mountHeight + suspensionLength - compression + wheelRadius;
}
```

with `mountHeight` the mounts' y in the chassis' frame. Too weak a spring isn't a disaster: past
the end of its travel each wheel has a **bump stop**, which holds the chassis up as a contact
would, resting it a few millimetres past the stop. Without one, a car cornering hard would sink
onto its outside wheels and lean further and further until it went over.

Put most of the mass low. The city's car has 400 of its 1200 kg as a point 30 cm under the chassis'
centre (the engine, gearbox and floor pan), with `MassProperties.box(...).combine(MassProperties.point(...))`,
which keeps the centre of mass under the middle of the wheels so the car doesn't roll over in a
hard turn.

### Driving

What the driver sets, on each wheel, as often as you like:

- **`steerAngle`**: how far the wheel is turned about its strut, in radians. Positive turns it to
  the body's left. The car then turns on the circle its steering gives.
- **`driveForce`**: the force the engine drives the tyre forward with, in newtons; negative drives
  it backward.
- **`brakeForce`**: the most force the brake slows the wheel with, in newtons. It stops the wheel
  but never drives it backward: a car braked on a slope stands still rather than creeping down it.
- **`grip`**: change it to make the tyre slide more or less, as a handbrake does to the rear tyres.
- **`driveTorque`**, **`brakeTorque`**: with slip tyres, the engine's torque on the wheel and the
  most the brake slows it with, in N·m. `driveForce` and `brakeForce` add to them, times the
  radius.

`springStiffness`, `springDamping` and `rollingResistance` can be changed too; `mount`, `radius`
and `suspensionLength` are fixed.

The engine, the gears, the steering's feel and air drag are yours: `RaycastVehicle` turns forces
on wheels into motion, and what decides those forces is the game's.

### What each wheel reports

After every step, each wheel says what it was doing:

| Property | What it is |
| --- | --- |
| `onGround` | Whether the tyre was on the ground. |
| `compression` | How far its spring was compressed, in metres; 0 off the ground. |
| `load` | How hard the ground pushed on the tyre, in newtons. |
| `sliding` | Whether the tyre was asked for more grip than it has, and slid; with slip tyres, whether it was past its peak. |
| `contactPoint`, `contactNormal` | Where it touched the ground, and the ground's normal there, in world space. |
| `ground` | The body it stood on. |
| `surface` | What the `surface` callback said the ground was like there. |
| `spinSpeed` | With slip tyres: how fast the wheel spins, in rad/s, positive rolling forward. |
| `slipRatio` | With slip tyres: (spin × radius − speed) / speed: positive spinning up, −1 locked. |
| `slipAngle` | With slip tyres: the angle between where the tyre points and where it goes, in radians, positive sliding to its left. |
| `center` | Where the wheel's centre is, in world space. |
| `spinAngle` | How far the wheel has turned about its axle, in radians. |

`center` and `spinAngle` are for drawing it; `sliding` and `load` for tyre smoke, skid marks and
sounds. A wheel braked into a slide stops spinning: it is locked.

## How it finds the ground

Each step, each wheel casts a ray from its mount down the chassis' up axis, as far as its
suspension's length plus its radius, and takes the nearest thing it meets that is ground to stand
on:

- not the chassis itself;
- not anything the ray **starts inside**, as it will when the chassis is pressed into a wall or a
  tree;
- not anything facing **more than 70° from up** along the strut: a wall, a tree's trunk or the
  underside of something is no ground.

Anything else is ground: a `PlaneCollider`, a `HeightfieldCollider`, a `MeshCollider` from
[`@eulerjs/bvh`](/bvh), a crate, a moving platform. The ray is an ordinary scene query
(`world.castRayAll`) that leaves out only the chassis, so it sees what any ray does: every
collider but sensors.

What the wheels push on, they push back on. A car standing on a crate presses it into the floor
with the car's weight; a car on a moving platform is carried along by its tyres' grip; a car
driving off a loose plank drags it.

### What the ground is like

A `surface` callback is asked, for each wheel on the ground each step, what the ground is like
where its ray hit, and returns a `GroundSurface`:

| Field | Default | What it is |
| --- | --- | --- |
| `grip` | `1` | What it scales the tyre's grip by: less on grass or gravel. |
| `rollingResistance` | `0` | Added to the tyre's rolling resistance, as a share of its load: deep gravel drags a car down. |
| `height` | `0` | How far the ground there stands above the surface the ray hit, in metres, below it if negative. |

`height` gives a flat collider bumps, ripples and kerbs too small or too many to be colliders of
their own: the wheel stands that much higher, its spring compressed as on any ground, and the
tyre's forces push where it now touches. A kerb under one side leans the car away from it; grass
that swells by a few centimetres keeps the suspension working; a gravel trap with a negative
height lets the car sink in. Return the same object for the same kind of ground, its `height`
set each time it is asked, and `wheel.surface` tells which ground each wheel is on without
allocating; the height is read as soon as it is returned.

```ts
const asphalt: GroundSurface = { height: 0 };
const vehicle = body.addBehavior(new RaycastVehicle({
  wheels,
  surface: (point) => {
    asphalt.height = 0.004 * Math.sin(point.x / 3) * Math.sin(point.z / 5);
    return asphalt;
  },
}));
```

## How the tyres work

The **spring** pushes along the ground's normal with its stiffness times its compression, plus
its damping times how fast the chassis comes down on the ground at the contact. The damper
resists the chassis' motion toward the ground rather than the strut's, so a wheel coming upon a
kerb or a crate from one step to the next, without the strut having moved, still cushions it.

The **tyre** then works in its own directions on the ground, turned by its steering:

- **Along** its rolling direction it pushes with the drive force, less the brake and the rolling
  resistance. Those two can bring the wheel to a stop by the end of the step, gravity and the
  engine pulling it on, but no further.
- **Sideways** it pushes to take out `sidewaysResponse` of the wheel's slip each step, and holds
  against gravity's sideways pull on a slope.
- Both together are limited to its **grip times its load**: asked for more, it gives that much, in
  the same direction, and slides. That is how a car drifts, skids and spins out, and why a lightly
  loaded inside wheel in a hard turn lets go first.

It pushes **where the tyre touches the ground**, not at the wheel's centre or the mount. Pushed
anywhere else, its pull against the slip would no longer damp the body's roll, and a car swerving
one way and back would roll over.

### Slip tyres

With `tyres: 'slip'` each wheel is a spinning body of its own, turned by `driveTorque`, slowed by
`brakeTorque`, and held to the ground going by through its tyre. The tyre pulls with how much it
**slips**: along it, the slip ratio, how much faster or slower the tyre's tread goes than the
ground under it; across it, the slip angle. The pull follows a tyre curve (Pacejka's magic
formula, its shape set by `slidingGrip`): it grows with the slip, peaks at `peakSlipRatio` and
`peakSlipAngle`, and falls to `slidingGrip` of the peak past them. So a wheel given too much
torque spins up and lets the back step out, a wheel braked too hard locks and stops steering, and
a car pushed past its limit in a corner slides with less grip than it had, as a real one does.

- **Along and across share one grip.** The two slips, each as a share of its peak, add up as the
  sides of a right angle, and the tyre's pull goes along that: braking hard into a corner leaves
  less grip to turn with.
- **More load, less grip a newton.** The peak pull is
  `grip × load × (load / nominalLoad)^−loadSensitivity`: a car's downforce, or the outside wheels
  in a corner, give less than their load's worth of grip.
- **The spin is stepped four times a step**, against the tyre's pull, which holds it so stiffly
  that each of those steps leans on that stiffness (implicitly) to stay steady.
- **Slow, the grip tyre takes over.** Going from 4 m/s over the ground down to 2 m/s, slip tyres
  hand over to the grip tyres' friction: a slip measured against nearly no speed would swing
  wildly, and the grip tyres hold a braked car still on a slope.

`grip`, `sidewaysResponse`, `rollingResistance` and the `surface` callback work as they do for
grip tyres.

## The city's car

`examples/city` drives a small hatchback through a city of towers. Its numbers are those of a
real car of that size: 1200 kg, a 1.75 by 0.7 by 4.1 m chassis, 0.32 m wheels on 0.35 m of travel,
front-wheel drive and steering. On top of `RaycastVehicle` it adds the driving itself, as a
behaviour of its own that holds the `RaycastVehicle` and steps it after setting the wheels:

```ts
import type { Behavior, Body, World } from '@eulerjs/core';
import { RaycastVehicle } from '@eulerjs/vehicle';

class Car implements Behavior {
  throttle = 0; // -1 to 1
  brake = 0; // 0 to 1
  steering = 0; // -1 (right) to 1 (left)
  handbrake = false;
  private readonly raycast = new RaycastVehicle({ wheels: wheelOptions }); // the four wheels, as above

  fixedUpdate(body: Body, timestep: number, world: World): void {
    const speed = this.raycast.forwardSpeed(body);
    // steering lock halved at 15 m/s, so the car stays drivable when fast
    const steerAngle = (this.steering * 0.6) / (1 + Math.abs(speed) / 15);
    // the engine's full push at low speed, its 60 kW over the speed beyond
    const engineForce = Math.min(6000, 60_000 / Math.max(Math.abs(speed), 1)) * this.throttle;
    this.raycast.wheels.forEach((wheel, index) => {
      const front = index < 2;
      const rearLocked = this.handbrake && !front;
      wheel.steerAngle = front ? steerAngle : 0;
      wheel.driveForce = front ? engineForce / 2 : 0;
      wheel.brakeForce = ((rearLocked ? 1 : this.brake) * 11_000) / 4;
      wheel.grip = rearLocked ? 0.25 : 1;
    });
    this.raycast.fixedUpdate(body, timestep, world);
  }
}
```

The handbrake brakes the rear wheels fully and drops their grip to a quarter, so the back steps
out and the car spins round. The example also has reverse at half the engine's force, air drag
on the chassis (a drag area of 0.65 m²), and R to set the car back on its wheels. It draws each
wheel on a strut placed at `mount.y - suspensionLength + compression` under its mount, turned by
`steerAngle`, with the tyre spinning by `spinAngle`.

## The F1 car

`examples/f1` races a Formula 1 car round Monza on slip tyres. Its numbers are in
[`specification.ts`](https://github.com/QusaiAlbonni/eulerjs/blob/main/examples/f1/src/car/specification.ts):
800 kg, slicks of grip 1.7 at the front and 1.87 at the wider rear, peaking at 7° and a slip
ratio of 0.1, with a load sensitivity of 0.15, so its downforce, twice its weight at 300 km/h,
gives it less than twice the grip. Its springs are stiff (140 000 to 160 000 N/m over 8 cm of
travel), as the aerodynamics want the car held level. Around `RaycastVehicle` it adds, each
step before the wheels':

- **the powertrain**, an engine's torque curve through eight gears to the rear wheels'
  `driveTorque`, and the engine's own inertia added to theirs, its square through the gear;
- **traction control and ABS**, easing the drive or a brake while a tyre is past its peak, read
  from `slipRatio` and `slipAngle`;
- **the aerodynamics**, downforce and drag as forces on the two axles, and DRS;
- **the track's surface**: one flat collider, with a `surface` callback that gives the kerbs
  their height and less grip, and the grass and the gravel less grip, more drag and an uneven
  height of their own.

## Cost

`npm run bench` drives 100 cars of four wheels round a heightfield. On one desktop machine it
took about 4.5 ms a step, wheels, chassis contacts and all.

## Limitations

- A car resting on its bump stops for good, with springs far too weak for it, creeps along the
  ground at a centimetre or two a second: each wheel's stop acts in turn. Stops acting together
  would hold it still (`TODO.md`).
- Grip tyres are a friction limit, not a tyre curve: grip doesn't fall off past the peak, and
  there is no load sensitivity. Their wheels have no inertia of their own; their spin is worked out
  from the speed they roll at. Slip tyres have both, but neither has camber, and a slip tyre's
  pull comes at once, with no tyre's stretch to build up through (relaxation length).
- Each wheel touches the ground at one point, straight under its mount: it drops into a gap a
  real tyre would bridge, and feels a kerb when its ray reaches it rather than when the front of
  the tyre would.

## See also

- [Bodies](/guide/bodies): behaviours, mass properties and sleeping
- [Colliders](/guide/colliders): the ground the wheels find
- [Triangle meshes](/bvh): roads and levels as `MeshCollider`s
- [Examples](/examples/): the city, and the F1 car
