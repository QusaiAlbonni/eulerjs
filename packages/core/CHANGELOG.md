# @eulerjs/core

## 0.1.1

### Patch Changes

- [`75e3bb3`](https://github.com/QusaiAlbonni/eulerjs/commit/75e3bb304354d6d0027d0459b3035e281b3b1a66) - Static scenery costs next to nothing until something reaches it: static bodies are kept in a tree of their bounds, so finding what touches them costs only for the bodies that move, and the step leaves them out unless they are moved or something rests on them. A race track walled by 1,860 static boxes takes 0.7 ms a step with nothing moving.
