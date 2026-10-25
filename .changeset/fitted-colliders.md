---
"@eulerjs/core": minor
---

`fitCollider(shape, geometry, options)` fits a box, sphere, hull, cylinder, cone or capsule around a geometry, as `world.addBody(object, { collider: 'box' })` does, with the collider's other options (its friction, say) given. A `HeightfieldCollider` takes `cellDepth` for rows spaced otherwise than its columns, for terrain whose cells aren't square.
