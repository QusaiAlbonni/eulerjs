---
"@eulerjs/core": minor
---

Bodies now fall asleep below 0.05 m/s (`sleepSpeed`, as in Box2D v3) instead of 0.01, so a pile settles and stops costing anything sooner: 125 boxes dropped into a pile take about a third less computing from the drop to rest. Set `sleepSpeed: 0.01` on the world for the old behaviour.
