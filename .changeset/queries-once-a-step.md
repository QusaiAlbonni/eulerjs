---
"@eulerjs/core": minor
---

Queries now look for bodies moved by hand once a step, at the first query after it, instead of at every query, so thousands of ray casts a frame cost what their searches do. Between two queries of the same step, move a body with `body.setPose(position, quaternion)` for the second to see it; written straight to `body.position`, it is seen from the next step on.
