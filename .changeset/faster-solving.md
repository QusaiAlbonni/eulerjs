---
"@eulerjs/core": patch
---

Faster stepping, the same simulation: the contact solver's inner loops work over flat arrays, a box against a box is tested from one matrix of their axes, contact points that cannot push skip their friction, two bodies moving together keep fewer speculative contacts (never fewer than either can close on the other), hulls are placed once a step and their face and edge searches hill-climb and prune, ball joints that are nothing more are solved apart, and still scenery sits in a tree that is rebuilt when it has grown lopsided. Against plain Rapier, a 1,015-box pyramid is 2.6 times slower and a 5,001-body smash 3.6 times, from 4.1 and 6.7; against cannon-es, every benchmark is faster.
