# @eulerjs/marine

Waves, buoyancy and foils (sails, keels, rudders) for [eulerjs](https://www.npmjs.com/package/@eulerjs/core), plus water that
draws the same waves the physics floats on, to the horizon. Documentation:
https://qusaialbonni.github.io/eulerjs/marine/

```sh
npm install @eulerjs/marine @eulerjs/core three
```

```ts
import { Buoyancy, Ocean } from '@eulerjs/marine';
import { SpectralWater } from '@eulerjs/marine/webgpu';

const ocean = new Ocean(); // a spectral sea
const water = new SpectralWater(ocean.waves); // with three/webgpu's WebGPURenderer
scene.add(water);
world.addBody(raft, { density: 500, shape: 'voxels' }).addBehavior(new Buoyancy({ ocean }));
// each frame: water.update(renderer, world.renderTime, camera.position, camera);
```

With `WebGLRenderer`, give the ocean a `SumOfSines` sea and draw it with `WaterMesh`:
`new WaterMesh(new Ocean({ waves: new SumOfSines() }), { world })`.

Needs three 0.166 or later, and 0.186 or later for `@eulerjs/marine/webgpu`, the spectral sea's
water. See the [marine guide](https://qusaialbonni.github.io/eulerjs/marine/) and the [sailboat example](https://qusaialbonni.github.io/eulerjs/examples/sailboat/).

MIT licensed.
