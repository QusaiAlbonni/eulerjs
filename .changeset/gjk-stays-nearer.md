---
"@eulerjs/core": patch
---

A ray or shape cast that ended within microns of a cone's side, or along any edge GJK finds the nearest point on, could miss what it was aimed straight through: four rays in 600 at a cone did. GJK no longer takes a step that brings it no nearer, as rounding in a simplex gone flat can, and keeps the nearest points it had.
