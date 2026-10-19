/** The examples the gallery shows: each one built into the site at `path`, its code on GitHub at `source`. */
export interface Example {
  /** Also the screenshot's name, `public/thumbnails/<id>.jpg`. */
  id: string;
  title: string;
  description: string;
  /** The built example, under the site's base. */
  path: string;
  /** Its code: a folder or a file in the repository. */
  source: string;
  /** What it shows off, as short tags. */
  tags: string[];
  /** Whether it draws with three/webgpu's WebGPURenderer (which falls back to WebGL 2 by itself). */
  webgpu?: boolean;
  /** Keys and buttons, if it has any worth saying. */
  controls?: string;
}

export const REPOSITORY = 'https://github.com/QusaiAlbonni/eulerjs';
const tree = (path: string) => `${REPOSITORY}/tree/main/${path}`;
const file = (path: string) => `${REPOSITORY}/blob/main/${path}`;

/** Whole games, built only on the public API. */
export const GAMES: Example[] = [
  {
    id: 'sailboat',
    title: 'Sailboat',
    description: 'Sail on a spectral sea among rocks that stand on the sea floor and crates drifting on the water, which the hull shoves aside. Raise a storm with the sea’s wind, wave height and choppiness.',
    path: 'examples/sailboat/',
    source: tree('examples/sailboat'),
    tags: ['marine', 'buoyancy', 'sails', 'spectral sea', 'post-processing'],
    webgpu: true,
    controls: 'A/D rudder · Q/E mainsail · Z/X jib · V camera · N day/night',
  },
  {
    id: 'city',
    title: 'City',
    description: 'Drive a car through a city of towers, knocking crates, cones and barrels about, past people walking the pavements: active ragdolls that fall in a heap and get up again.',
    path: 'examples/city/',
    source: tree('examples/city'),
    tags: ['vehicle', 'ragdolls', 'joints', 'drives'],
    controls: 'W/S drive and brake · A/D steer · Space handbrake · R back on the wheels · V camera',
  },
  {
    id: 'f1',
    title: 'F1 at Monza',
    description: 'A time trial in a Formula 1 car round Monza, the circuit laid out from OpenStreetMap: slip tyres, downforce, DRS, a seamless gearbox, kerbs and grass to bounce over, and an engine you hear simulated, after engine-sim.',
    path: 'examples/f1/',
    source: tree('examples/f1'),
    tags: ['vehicle', 'slip tyres', 'aerodynamics', 'engine sound', 'worker'],
    controls: 'W/S throttle and brake · A/D steer · E/Q shift · Space DRS · T traction control · C camera · N sound · R back to the grid',
  },
  {
    id: 'wedding',
    title: 'Wedding',
    description: 'A wedding in first person: shove chairs, carry flutes, topple the champagne tower. Hundreds of instanced bodies that start asleep and wake when disturbed.',
    path: 'examples/wedding/',
    source: tree('examples/wedding'),
    tags: ['instancing', 'sleeping', 'TargetJoint', 'first person'],
    controls: 'WASD walk · Shift run · Space jump · click to shove or throw · E pick up · R back to the entrance',
  },
  {
    id: 'ocean',
    title: 'Spectral ocean',
    description: 'A spectral sea drawn to the horizon around the camera, crates afloat on the very waves drawn. Switch between the quadtree and ring layouts, tune the sea and its foam.',
    path: 'examples/ocean/',
    source: tree('examples/ocean'),
    tags: ['FFT waves', 'LOD', 'foam', 'worker'],
    webgpu: true,
  },
];

const basic = (id: string, title: string, description: string, tags: string[], extra: Partial<Example> = {}): Example => ({
  id: `basics-${id}`,
  title,
  description,
  path: `examples/basics/${id}.html`,
  source: file(`examples/basics/src/${id}.ts`),
  tags,
  ...extra,
});

/** Short examples, one idea each. */
export const BASICS: Example[] = [
  basic('hello', 'Hello', 'A world, a body bound to a mesh, and the render loop: the smallest program there is.', ['World', 'Body']),
  basic('tumbling', 'Tumbling', 'Exact inertia from meshes: an uneven box flipping over and over when spun about its middle axis.', ['inertia', 'mass properties']),
  basic('springs', 'Springs', 'Writing your own Behavior (a spring) and Plugin (air drag). Click to apply impulses.', ['Behavior', 'Plugin', 'impulses']),
  basic('chain', 'Chain', 'Links pinned together with distance joints.', ['DistanceJoint']),
  basic('collisions', 'Collisions', 'A pyramid of crates and balls to throw at it.', ['contacts', 'stacking']),
  basic('floating', 'Floating', 'Cork, pine and oak cubes afloat on a spectral sea: each floats at its own draft, and the pine one rolls onto an edge.', ['buoyancy', 'spectral sea'], { webgpu: true }),
  basic('joints', 'Joints', 'A self-closing door, a windmill on a motor, a lift on a slider, a lamp on a cone-twist joint and a bridge of fixed joints that break.', ['hinge', 'slider', 'motors', 'breaking']),
  basic('queries', 'Scene queries', 'Click to cast rays and push what they hit, right-click for a blast found by an overlap test, and a capsule steering itself with shape casts.', ['ray casts', 'shape casts', 'overlaps']),
  basic('sensors', 'Sensors and events', 'A trigger zone that lights up while anything is in it, and crates that flash when something starts touching them.', ['sensors', 'contact events']),
  basic('terrain', 'Terrain and meshes', 'Barrels, cones and balls rolling down a heightfield, and a torus knot as a triangle mesh collider.', ['heightfield', 'MeshCollider', 'bvh']),
  basic('solvers', 'Solvers', 'The same stack and pendulum solved by XPBD and by soft step, side by side.', ['soft step', 'XPBD']),
];

/** Pages that measure rather than show. */
export const TOOLS: Example[] = [
  {
    id: 'ocean-gpu-check',
    title: 'GPU waves against the CPU',
    description: 'The GPU’s inverse FFT of the spectral sea read back and compared, field by field, with the CPU’s.',
    path: 'examples/ocean/gpu-check.html',
    source: file('examples/ocean/src/gpuCheck.ts'),
    tags: ['verification'],
    webgpu: true,
  },
  {
    id: 'ocean-physics-bench',
    title: 'Floating: main thread or worker',
    description: 'What floating crates on the spectral sea cost the main thread, with its waves evaluated there or in a worker.',
    path: 'examples/ocean/physics-bench.html',
    source: file('examples/ocean/src/physicsBench.ts'),
    tags: ['benchmark', 'worker'],
  },
];
