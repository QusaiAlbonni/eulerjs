# @eulerjs/scene

## 0.1.0

### Minor Changes

- [`c402dc9`](https://github.com/QusaiAlbonni/eulerjs/commit/c402dc9fad3cfff4cab3549e377875b0b0049b1d) - A new package: physics for a three.js scene, read from it. `ScenePhysics` (`world.use(new ScenePhysics())`) makes the bodies a scene's `userData.physics` asks for, three.js's own convention (`mass`, `restitution`) and a little more (`friction`, `type`, `collider`), on meshes and on groups of them, such as a glTF node of several primitives. Each starts where it is drawn, nested or not; three.js's box, sphere, cylinder, cone and capsule geometries collide as those shapes while they are still the shape three.js made them and round enough to be (within 2% of the radius), and anything else, a rounded box or an 8-sided capsule say, as its hull if it moves or as its triangles if it doesn't: wherever it is drawn. An InstancedMesh is a body for each instance. `EulerPhysics()` is a drop-in for three.js's `RapierPhysics`, `JoltPhysics` and `AmmoPhysics` addons, with their API; three.js's basic, instancing and terrain examples run on it changed only in the line that awaits it.

### Patch Changes

- Updated dependencies [[`a44f38c`](https://github.com/QusaiAlbonni/eulerjs/commit/a44f38cbde46fc9ab1cede86b0b2f41d5d3af75a), [`c402dc9`](https://github.com/QusaiAlbonni/eulerjs/commit/c402dc9fad3cfff4cab3549e377875b0b0049b1d), [`3d9727c`](https://github.com/QusaiAlbonni/eulerjs/commit/3d9727c0ad0e1ea2a1771f2c7e9570e677093f5c), [`a44f38c`](https://github.com/QusaiAlbonni/eulerjs/commit/a44f38cbde46fc9ab1cede86b0b2f41d5d3af75a)]:
  - @eulerjs/core@0.3.0
