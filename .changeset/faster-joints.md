---
"@eulerjs/core": patch
---

Faster stepping: joints with limits, drives or friction are solved over flat arrays rather than three.js vectors, and their lengths found by `Math.sqrt` rather than `Math.hypot` (a scene of every kind of joint steps 42% faster, holding its axes and limits as closely as before), ball joints that are nothing more 22% faster, the contact solver reads each manifold's two bodies once for all its points (a 1,015-box pyramid 13% faster), and the hull test passes over faces that cannot be the one that separates most.
