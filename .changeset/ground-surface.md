---
'@eulerjs/vehicle': minor
---

A `surface` option, `(point, hit) => GroundSurface`, says what the ground is like where each wheel touches it: its `grip`, its extra `rollingResistance`, and its `height` above the collider, for kerbs, grass and gravel on one collider, and bumps felt through the suspension. Each wheel reports the `surface` it was on.
