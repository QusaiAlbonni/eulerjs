# @eulerjs/vehicle

Ray-cast vehicles for [eulerjs](https://www.npmjs.com/package/eulerjs): a chassis body carried by wheels, each a ray down
from its suspension mount to whatever ground is under it, flat or not, still or moving, with a
spring and damper between them and a tyre that grips up to a limit.

```sh
npm install @eulerjs/vehicle eulerjs three
```

```ts
import { RaycastVehicle } from '@eulerjs/vehicle';

const vehicle = chassis.addBehavior(
  new RaycastVehicle({
    wheels: mounts.map((mount) => ({ mount, radius: 0.32, suspensionLength: 0.35, springStiffness: 30_000, springDamping: 2400, grip: 1 })),
  }),
);
// every step, or whenever the driver does something
vehicle.wheels[0].steerAngle = vehicle.wheels[1].steerAngle = 0.3;
for (const wheel of vehicle.wheels) wheel.driveForce = 1500;
```

Each wheel takes a `steerAngle`, a `driveForce` and a `brakeForce` (which stops the wheel, never
drives it backward), and its `grip` can be changed, as a handbrake does to the rear tyres. The
tyre's forces grow with how much it slips, up to its grip times the load on it; beyond that it
slides, which is how a car drifts, skids and spins out. Braked on a slope, it stands still. The
wheels push back on what they stand on, so a car on a crate presses it into the ground. After each
step every wheel reports whether it is on the ground, its compression, load, contact point and
normal, what it stands on, and its centre and spin, for drawing it. A wheel stands only on ground
that faces up along its strut, never a wall or a tree's trunk, nor anything its ray starts inside
(as it will with the chassis pressed against something); at the end of its travel a bump stop
holds the chassis up.

The engine, gears, steering feel and air drag are yours: [the city example](https://qusaialbonni.github.io/eulerjs/examples/city/)
builds a hatchback on it. Needs three 0.166 or later. See the [guide](https://qusaialbonni.github.io/eulerjs/vehicle).

MIT licensed.
