---
"@eulerjs/core": minor
---

Under soft step, bodies that touch or are joined sleep and wake as islands: a pile falls asleep only once every body of it is still, all at once, and waking any of it wakes all of it, so a pile is never half asleep, its sleeping half an immovable wall to the rest (a box sliding across a still slab used to put the slab to sleep under it, and wake it, every half second). Static bodies hold things up without joining islands, so piles on the same floor sleep on their own. XPBD still sleeps touching bodies one by one, since its tall stacks creep too much to be still all at once. Finding contacts now makes almost no objects a step (contact points, manifolds and pairs are reused, and each collider's pose is worked out once a step), halving the garbage a busy scene makes.
