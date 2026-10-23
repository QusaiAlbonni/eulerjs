---
"@eulerjs/core": minor
---

Spheres, capsules, cylinders and cones now have a rolling resistance of 0.02 (`ROUND_ROLLING_RESISTANCE`) unless given their own, so round bodies knocked rolling on flat ground come to rest instead of rolling for ever. Give `rollingResistance: 0` for the old, ideal rolling.
