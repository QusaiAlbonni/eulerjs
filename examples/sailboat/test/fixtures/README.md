`hull-geometry.json` is the `hull` mesh of `public/assets/boat.glb` (positions and index only, in
the boat's frame), saved with three's `BufferGeometry.toJSON()` so the headless boat tests can
load it without a browser. Regenerate it if the boat model changes.
