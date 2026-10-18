# TODO

What eulerjs doesn't do yet, roughly in the order games tend to need it.

## Continuous collision detection

Speculative margins catch most fast bodies, but nothing sweeps a body's path through the step,
so thin, fast objects such as bullets can pass through walls. Options: a time-of-impact sweep
for bodies flagged as fast (the shape cast added with the scene queries is a start), or
substepping the speculative margin.

## Body controls

- Locking rotation or movement on chosen axes: the usual way to keep a character upright.
- Speed limits (linear and angular).
- Per-body solver iterations, for bodies that need stiffer joints or contacts than the rest.

## A character controller

A kinematic capsule that slides along walls, steps up stairs, snaps to slopes and rides moving
platforms, built on the shape cast.

## Joints

- Static friction for ball joints under XPBD: their friction acts on velocities only, as held on
  positions too a fallen ragdoll's limbs never came to rest, so they creep a little under a
  steady load. Hinges and sliders, and every joint under soft step, hold.
- Faster convergence for orientation drives under soft step, which reach their target more slowly
  than under XPBD.

## Rolling on a rim

- A cylinder rolling on the rim of its end, like a coin, gains energy under both solvers: about
  6 J a second for a 100 kg drum without rolling resistance. With rolling resistance, XPBD's hold
  hides it and the drum falls flat; soft step's doesn't, and it rolls on for ever, keeping what
  it touches awake. The rim's contact is anchored as a point fixed in the body, though the
  touching point goes round the rim as it rolls; anchoring it as rolling (the middle of the end
  and a reach out to the rim) made it worse, so the cause is still to find.
  `sleeping.test.ts` has the case, marked as failing.

## Contacts under XPBD

- The two points of an edge against a face share a hard impact one after the other under XPBD,
  which takes the first point's share too far: a car striking a wall with its body's edge comes
  away rolling, or spinning wildly. Soft step solves such a pair as a block (Box2D's block
  solver); XPBD's position solve needs the same.

## Vehicles

- A car resting on its bump stops for good (springs far too weak for it) creeps along the ground
  at a centimetre or two a second: each wheel's stop acts in turn, and the small turns they leave
  are taken up by the tyres. Stops that act together, as one block, would hold it still.

## Debug drawing

A three.js overlay that draws colliders, contact points and normals, joint frames and limits,
and bounding boxes. Cheap to add and it fits the three.js focus.

## Solver and scale

- Islands for contacts as well as joints, so separate piles sleep and wake on their own. Today a
  body only stays awake through contacts with one that won't sleep; a pile otherwise sleeps body
  by body, which XPBD needs, since a tall stack creeps too much to be still all at once.
- Multithreading or WebAssembly, which the backend split makes possible.
- A BVH broad phase for each step's pair search in big static scenes, as the scene queries
  already have; today's sweep and prune sorts every body's bounds.
- The structure-of-arrays layout the soft-step solver uses, for XPBD too.

## Determinism and state

Snapshots, serialization and guaranteed cross-platform determinism, which rollback netcode
needs.

## Materials

- A choice of how two colliders' friction and restitution combine; today friction is always
  the geometric mean and restitution the larger.
- Anisotropic friction, such as skis or tyres.
- Separate torsional friction: a round body, such as a ragdoll's head, spinning about the
  contact normal is only slowed by rolling resistance and its joints.

## Collision details

- Internal edges of triangle meshes and heightfields: edges between nearly flat or concave
  neighbours never push on their own, but a ridge only a little sharper than flat still can,
  which a body sliding over it may feel as a bump.
- Exact (GJK/EPA) contacts for cylinders and cones against shapes other than planes, which today
  use a 16-sided hull.
- Steadier contact sets on triangle meshes and heightfields: a body lying across a cell's
  diagonal or edge gets contact points there that come and go from step to step, which a narrow
  face (a cone's hull lying on its side) feels as a slight rocking while it is kept awake. It
  falls asleep through it.
- Dynamic triangle meshes; mesh colliders are for static and kinematic bodies.

## Beyond rigid bodies

Soft bodies, cloth and fluids. Most rigid-body engines leave these out too; buoyancy is already
in `@eulerjs/marine`.

## The spectral sea

- `SpectralWater` draws on WebGPU as on the WebGL 2 fallback, checked on Chrome's SwiftShader
  adapter (`--use-webgpu-adapter=swiftshader`, which allows only the default 16 sampled textures a
  stage), but not yet on a GPU's own WebGPU: on this machine headless Vulkan loses its device
  drawing even a cube, and the desktop browser has no WebGPU adapter. On WebGPU, compute shaders
  with workgroup memory could do a whole row of the FFT in one dispatch.
- Sending the FFT's eighteen render passes takes about 1 ms of the main thread's time a frame, most
  of it three's own work for each `render` call. Fewer passes (several stages in one, or the
  unpacking folded into the last stage) would cut that.
- Every patch is evaluated at the same resolution; the smallest could do with fewer waves.
- The physics floats on the two largest patches only, 64 waves across each: waves shorter than
  about 6 m are drawn but not felt. Fine for boats; small floating things ride too smoothly.
- Deep water only: no shoaling or slower waves in the shallows.
- Foam forms from each patch's own waves bunching the surface up, not all the patches' together,
  which bunch it up more where their crests meet: a fresh breeze's sea (10 m/s) makes almost
  none. A foam texture in the world around the viewer, fed by the whole sea's Jacobian, would
  break where real seas do; it would have to move with the viewer.
- Foam is no finer than each patch's texels (20 cm on the 25 m patch at 128²).
- Buoyancy has no added mass: a body moving through water must move the water about it too,
  which slows how fast it can be pushed about. Without it, on a tall sea a light crate shot up by a
  crest leaves the water for a moment, as real crates don't.
- The gusts don't move; real gusts run downwind.
