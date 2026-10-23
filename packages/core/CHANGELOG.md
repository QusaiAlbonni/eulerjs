# @eulerjs/core

## 0.2.0

### Minor Changes

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - A face resting on another face (a box on a box, a hull on a hull) now keeps the four contact points that span the patch instead of up to eight, so stacks stand steadier (the top of an awake 8-box stack moves 0.4 mm in a minute, from 11.7 mm) and piles of hulls solve faster. Bodies resting across several triangles keep up to eight.

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - Queries now look for bodies moved by hand once a step, at the first query after it, instead of at every query, so thousands of ray casts a frame cost what their searches do. Between two queries of the same step, move a body with `body.setPose(position, quaternion)` for the second to see it; written straight to `body.position`, it is seen from the next step on.

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - Spheres, capsules, cylinders and cones now have a rolling resistance of 0.02 (`ROUND_ROLLING_RESISTANCE`) unless given their own, so round bodies knocked rolling on flat ground come to rest instead of rolling for ever. Give `rollingResistance: 0` for the old, ideal rolling.

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - Bodies now fall asleep below 0.05 m/s (`sleepSpeed`, as in Box2D v3) instead of 0.01, so a pile settles and stops costing anything sooner: 125 boxes dropped into a pile take about a third less computing from the drop to rest. Set `sleepSpeed: 0.01` on the world for the old behaviour.

### Patch Changes

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - Faster stepping, the same simulation: the contact solver's inner loops work over flat arrays, a box against a box is tested from one matrix of their axes, contact points that cannot push skip their friction, two bodies moving together keep fewer speculative contacts (never fewer than either can close on the other), hulls are placed once a step and their face and edge searches hill-climb and prune, ball joints that are nothing more are solved apart, and still scenery sits in a tree that is rebuilt when it has grown lopsided. Against plain Rapier, a 1,015-box pyramid is 2.6 times slower and a 5,001-body smash 3.6 times, from 4.1 and 6.7; against cannon-es, every benchmark is faster.

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - A cylinder or cone rolling on the rim of its end no longer speeds itself up: friction now acts where the rim touches, its lowest point, which runs round the rim as it rolls, instead of where it touched when the step began. A drum tipped onto its rim and spun falls flat and sleeps, where it used to wobble for ever, gaining energy.

- [`5a320c7`](https://github.com/QusaiAlbonni/eulerjs/commit/5a320c738920361ece86413f9512b92b69c1fe5a) - Bodies asleep on something no longer float in the air when it goes: removing a body, taking a collider off one, moving one by hand or removing a joint now wakes what rested on it, hung from it or was moved into, so a plate falls when its table is removed and a lamp falls when its cord is.

## 0.1.1

### Patch Changes

- [`75e3bb3`](https://github.com/QusaiAlbonni/eulerjs/commit/75e3bb304354d6d0027d0459b3035e281b3b1a66) - Static scenery costs next to nothing until something reaches it: static bodies are kept in a tree of their bounds, so finding what touches them costs only for the bodies that move, and the step leaves them out unless they are moved or something rests on them. A race track walled by 1,860 static boxes takes 0.7 ms a step with nothing moving.
