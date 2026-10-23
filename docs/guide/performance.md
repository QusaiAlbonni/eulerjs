# Performance

eulerjs runs in plain JavaScript on the main thread (or a worker), so the number of awake bodies,
contacts and joints, and the accuracy you ask for, decide what a step costs. This page explains
where the time goes, what to do about it, and how to measure it.

## Where the time goes

- **Awake bodies and their contacts.** Solving contacts is most of the cost of a busy scene, and it
  grows with the number of touching pairs and with substeps.
- **Joints**, solved on every substep like contacts. Joint drives (motors, servos, orientation
  drives) cost more than plain limits.
- **Collision detection**: finding which colliders may touch (sweep and prune), then working out
  their contacts. Simple shapes are cheapest; convex hulls cost more the more edges they have.
- **Behaviours and plugins**, which run every step for every body that has them.
- **Scene queries**, which search a bounding volume tree and cost little each.

Sleeping bodies cost almost nothing, and static bodies are never integrated or solved for
themselves: they cost only through what touches them.

## Tips

### Let things sleep

Bodies that have been still for half a second fall asleep and drop out of the simulation until
something disturbs them, so a large scene that is mostly at rest costs far less than one that is
all awake. So:

- Leave `canSleep` on (the default) for everything that doesn't need to move by itself. Turn it
  off only for things that must keep reacting while still, such as a lift or a door on a motor.
- Put a scene set exactly where it should stand to sleep as it is made, with `body.sleep()`, so it
  doesn't spend its first second settling. See [Bodies](./bodies#starting-asleep).
- A body touching one that never sleeps stays awake too. Keep `canSleep: false` bodies and moving
  kinematic bodies away from large piles where you can.
- A behaviour that applies a force every step keeps its body awake. Let it skip steps where it has
  nothing to do.
- Bodies joined by joints sleep only all together, so one restless part keeps a whole ragdoll
  awake.

### Instance what looks alike

Hundreds of alike props drawn as one `InstancedMesh` with `world.addInstances` cost one draw call
instead of hundreds, and a sleeping instanced body doesn't touch the instance matrices at all, so a
still scene uploads nothing to the GPU. See [Instancing](./instancing).

### Choose simple colliders

- Spheres, capsules and boxes are the cheapest shapes.
- Keep convex hulls to about 32 corners: their cost grows with the number of edges. A rock with
  hundreds of vertices collides about as well as a hull of a simplified copy, and costs much less.
- Cylinders and cones are exact against planes (and cylinders against spheres), and collide as
  16-sided prisms against everything else.
- Static scenery belongs on static bodies: planes, heightfields and boxes for floors and walls,
  and `MeshCollider` from `@eulerjs/bvh` where the shape really needs triangles.

### Substeps and timestep

`world.substeps` is the accuracy setting, and the main dial between cost and quality. The default,
4 at 60 steps a second, suits games in the browser; 8 costs about 40% more for stiffer joints and
contacts; 2 is too few for stacks. Substeps are cheaper than a shorter timestep, since collision
detection, behaviours and plugins still run once per step. See [Solvers and stepping](./solvers).

### Solver choice

Soft step, the default, is 20 to 40% faster than XPBD on piles of boxes and spheres, and holds
stacks still. XPBD's joints and contacts give less under load. Choose by the scene's needs first;
see [Solvers and stepping](./solvers#which-to-choose).

### `maxStepsPerFrame`

When a frame takes longer than the steps it has to run, the next frame has more to catch up on,
and a slow device can spiral. `maxStepsPerFrame` (8 by default) caps the steps per frame and drops
the rest of the time, so the simulation slows down instead of freezing the page. Lower it on slow
devices if you would rather see slow motion than dropped frames.

### Queries

Scene queries search a bounding volume tree, so they stay cheap in large worlds. The first query
after a step also looks at every body, to notice any you moved by hand, at about 10 ns a body;
the queries after it don't, so thousands of them a frame cost what their searches do.

### Events

Contact events are only tracked while something listens to `contactBegin` or `contactEnd`. Remove
listeners you no longer need.

## Measured

The repository's benchmarks put eulerjs, cannon-es and Rapier (its plain WebAssembly build)
through the same scenes at 60 steps a second, with the same masses, friction 0.5, no restitution,
no damping and no rolling resistance (which only eulerjs has); each engine keeps its own solver
defaults (eulerjs soft step with 4 substeps, cannon-es 10 Gauss-Seidel iterations, Rapier 4
solver iterations). The first five are the scenes engines are commonly measured by, after Box2D's
and Jolt's benchmarks, with sleeping off; each engine is timed over every step of the scene, the
mean of them, since a scene such as the smash costs more at some moments than others. The last
seven are timed once settled, the median of seven runs of 60 steps, and the table gives the
median of three runs of the benchmark. Milliseconds of computing per simulated second, on a
Ryzen 5 4600H in Node 24, idle and on mains power, lower is better:

| Scene | eulerjs | cannon-es | Rapier | eulerjs against cannon-es | eulerjs against Rapier | cannon-es against Rapier |
| --- | ---: | ---: | ---: | --- | --- | --- |
| Pyramid of 1,015 boxes, standing | 3979 ms | 12594 ms | 1554 ms | 3.2× faster | 2.6× slower | 8.1× slower |
| Mixed pile: 400 boxes, balls, cylinders and rocks | 647 ms | 8269 ms | 145 ms | **12.8× faster** | 4.5× slower | 57× slower |
| Smash: a 4 m box through 5,000 floating boxes | 8447 ms | 16375 ms | 2318 ms | 1.9× faster | 3.6× slower | 7.1× slower |
| Query storm: 5,000 rays a step through 2,000 still shapes | 1862 ms | 29285 ms | 770 ms | **15.7× faster** | 2.4× slower | 38× slower |
| Joint grid: 1,600 balls on 3,120 ball joints, hanging | 850 ms | 1927 ms | 455 ms | 2.3× faster | 1.9× slower | 4.2× slower |
| 125 boxes falling into a pile | 107 ms | 234 ms | 63 ms | 2.2× faster | 1.7× slower | 3.7× slower |
| 125 boxes in a pile, never sleeping | 105 ms | 220 ms | 50 ms | 2.1× faster | 2.1× slower | 4.4× slower |
| 125 boxes settled | 5 ms | 206 ms | 4 ms | **41× faster** | 1.3× slower | 52× slower |
| 400 spheres spread out, never sleeping | 75 ms | 101 ms | 43 ms | 1.3× faster | 1.7× slower | 2.3× slower |
| 400 spheres, sleeping | 13 ms | 58 ms | 8 ms | 4.5× faster | 1.6× slower | 7.3× slower |
| 64 rocks (42-corner hulls), never sleeping | 69 ms | 6079 ms | 26 ms | **88× faster** | 2.7× slower | 234× slower |
| 1,860 static walls, 8 boxes sliding round them | 50 ms | 657 ms | 18 ms | **13× faster** | 2.8× slower | 37× slower |

In the sleeping scenes cannon-es is given eulerjs's sleep thresholds (0.05 m/s for 0.5 s); Rapier
doesn't let JavaScript set its own (measured: about 0.1 m/s and 0.2 rad/s for 0.5 s), so it keeps
them. Rapier stands on a 10 km box, as its JavaScript API has no infinite plane; the others on one.

The city example (towers, lamp posts, trees, crates, cones and barrels, mostly asleep) with a
crowd of ragdoll pedestrians, every one awake, against the same city rebuilt in cannon-es with
the ragdolls' joints and limits matched by its cone-twist and hinge constraints:

| Crowd | eulerjs soft step | eulerjs XPBD | cannon-es |
| --- | ---: | ---: | ---: |
| none (52 props) | 4 ms | 6 ms | 121 ms |
| 25 people (327 bodies) | 444 ms | 496 ms | 722 ms |
| 50 people (602 bodies) | 1026 ms | 1164 ms | 1375 ms |
| 100 people (1152 bodies) | 2282 ms | 2635 ms | 2771 ms |

The eulerjs walkers are driven by their joints' drives, which cost more than the forces that
pull the cannon-es ones along (cannon-es has no joint drives); their joints open up by 15 mm at
most under soft step, 6 mm under XPBD, and cannon-es's by 5 mm. The rows with people were
measured before eulerjs stopped visiting still bodies every step, which makes no measurable
difference to a crowd this awake.

Static scenery costs next to nothing until something reaches it: static bodies are kept in a
tree of their bounds, so finding what touches them costs only for the bodies that move, and the
step leaves them out unless they are moved or something rests on them. A race track walled by
1,860 static boxes takes 0.7 ms a step with nothing moving, and about 1 ms with 8 boxes sliding
among them.

And for accuracy (0, or the stated value, is perfect):

| | eulerjs | cannon-es |
| --- | ---: | ---: |
| Top of a 3-box stack kept awake, furthest it moves in 60 s | 0.7 mm | 2.7 m (falls) |
| Top of a 5-box stack kept awake, furthest it moves in 60 s | 7.2 mm | 6.4 m (falls) |
| Top of an 8-box stack kept awake, furthest it moves in 60 s | 11.8 mm | 9.5 m (falls) |
| Box sliding down a slope, acceleration error | 0.0% | −100% (stuck) |
| Ball bounced from 3 m, height error | −1.8% | +13.1% |
| A rock's moment of inertia (9.14 is right) | 9.14 | 66.7 |
| A box resting on the ground, how far it sinks | 0.07 mm | 0.00 mm |

XPBD is the slower of eulerjs's solvers: in an awake pile of boxes cannon-es is 1.2 to 1.4 times
faster than it, where soft step is 1.1 to 1.2 times faster than cannon-es. For accuracy against
speed within eulerjs, at the default 60 steps a second:

- Soft step loses 0.02% of a pendulum's energy per swing, XPBD 6%.
- 8 substeps instead of 4 cost about 40% more; they make a hanging chain stretch 2 mm instead of 8,
  and a stack that may not sleep drift 10 times less.

Timings depend on the machine and browser, so measure your own scenes too.

## Running the benchmarks

In a clone of the repository:

```sh
npm install
npm run bench       # with the default soft-step solver
npm run bench:xpbd  # the same with XPBD
```

They are not pass/fail tests: they print reports, one file at a time so that the timings don't
disturb each other. Each line starts with what it measures:

| Report | What it measures |
| --- | --- |
| `PERFORMANCE` | Step cost of standard scenes: 125 boxes falling into a pile, in a pile awake, and settled and asleep; 400 spheres spread out, awake and asleep; 64 rocks (42-corner hulls) in a heap. |
| `QUALITY` | How far the top of a stack of 3, 4, 5 or 8 boxes kept awake drifts in 60 s, at 4 and 8 substeps. |
| `QUERIES` | Ray casts, shape casts and overlap tests in a town of 900 static boxes and 200 rolling balls. |
| `TERRAIN`, `ROUND` | Balls, boxes and barrels on heightfield terrain; piles of boxes, barrels and cones. |
| `JOINTS` | Chains of joints hanging and swinging; target joints carrying bodies. |
| `EVENTS` | Contact events and sensors. |
| `SPEED`, `ACCURACY` | eulerjs against cannon-es: step costs, and stack drift, a resting box sinking into the ground, bounce height, sliding on a slope, a hull's inertia. |
| `CITY VS CANNON` | The city example with a crowd of pedestrians, under both eulerjs solvers and in cannon-es. |

To time your own scene, step it with `world.fixedStep()` in a loop and measure with
`performance.now()`, after letting it settle for as long as it would in play.

## See also

- [Solvers and stepping](./solvers): the settings that trade speed for accuracy.
- [Instancing](./instancing): one draw call for many bodies.
- [Bodies](./bodies#sleeping): sleeping in detail.
