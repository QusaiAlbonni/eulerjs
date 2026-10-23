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

- A drum rolling on the rim of its end touches at the rim's lowest point, which runs round the
  rim; both solvers now follow it (soft step moves the contact's anchor there before each pass,
  XPBD's anchor is the rim's furthest point). Without rolling resistance, soft step still gains a
  little energy within each substep (about 1 J a second for a 100 kg drum tipped 6° and spun,
  from 8 J a second), less the more substeps; XPBD loses it.

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

## Physics from a scene

A plugin, `world.use(new ScenePhysics(scene))`, that is handed a three.js scene (a loaded glTF,
say) and makes and keeps its bodies itself:

- What each object is, read from the scene first: glTF's `KHR_physics_rigid_bodies` and
  `KHR_implicit_shapes` (three.js's GLTFLoader keeps unknown extensions in
  `userData.gltfExtensions`), `userData` (Blender custom properties arrive as glTF extras), and
  naming conventions (`UCX_` collision proxies, `_static`). Where nothing says, cautious guesses:
  meshes take part, lights, cameras, lines and helpers don't; parts of an animation are
  kinematic; large, open or ground-like meshes are static; small closed ones move; when unsure,
  static. Every decision reported with its reason, and any of them overridable per object.
- Shapes: static scenery as its triangles (`MeshCollider`) or a heightfield for a grid; a moving
  object as the primitive that best fits its volume, else its hull; a concave one that moves
  (a mug, a chair) needs convex decomposition, which eulerjs doesn't have yet. Hulls of heavy
  meshes simplified first. A scene modelled in centimetres warned about.
- At runtime: listening for `childadded` and `childremoved` on every node of the scene (they
  don't bubble), noting what changed and catching up once at the start of the next step, so that
  an object removed and added back in between (as `attach` does to reparent it) keeps its body
  and velocity, a group added at once is one pass, and the order is the tree's, for determinism.
  Changes no event tells of (a mesh's geometry or scale, an InstancedMesh's `count`) through
  `world.refresh(object)`. A hidden object keeps its body; one with a body made by hand is left
  alone; a body set under another moving body stays its own unless asked to join it.

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
