import { ACESFilmicToneMapping, BoxGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, PMREMGenerator, Scene, Timer, Vector3, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { World } from '@eulerjs/core';
import { Buoyancy, Ocean, SpectralWaves } from '@eulerjs/marine';
import { seaFog, SpectralWater } from '@eulerjs/marine/webgpu';

// The spectral sea is drawn with three/webgpu's WebGPURenderer (which falls back to WebGL 2 by
// itself), so this example sets up its own renderer rather than the other examples' stage.
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.4;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.3, 400_000);
camera.position.set(0, 6, 16);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;

// a sky, and its light on the sea; reflections from it without the sun's disc, which would glare
const sunDirection = new Vector3().setFromSphericalCoords(1, Math.PI * 0.38, Math.PI * 0.25);
const makeSky = () => {
  const sky = new SkyMesh();
  sky.scale.setScalar(300_000);
  sky.sunPosition.value.copy(sunDirection);
  sky.mieCoefficient.value = 0.0015;
  return sky;
};
scene.add(makeSky());
const reflectedSky = makeSky();
reflectedSky.showSunDisc.value = 0;
const reflectedScene = new Scene();
reflectedScene.add(reflectedSky);
scene.environment = new PMREMGenerator(renderer).fromScene(reflectedScene).texture;
const sun = new DirectionalLight(0xfff1dd, 3);
sun.position.copy(sunDirection);
scene.add(sun, new HemisphereLight(0xdde6f0, 0x2b2f36, 0.6));

// A moderate sea of fresh water, its waves evaluated for the physics in a worker; the water drawn
// is the same sea, every wave of it, on the GPU.
const world = new World();
const waves = new SpectralWaves({ windSpeed: 9, heightScale: 1 });
waves.useWorker(new Worker(new URL('../../../packages/marine/src/waves/spectralWorkerEntry.ts', import.meta.url), { type: 'module' }));
const ocean = new Ocean({ waves, density: 1000 });
const water = new SpectralWater(waves, { environment: scene.environment, sunDirection });
scene.add(water);
scene.fogNode = seaFog(scene.environment, { sunDirection });

// Cubes as dense as cork, as pine and as oak. A floating cube can only stay upright below about
// 0.21 or above about 0.79 times the water's density, so the pine one rolls onto an edge.
const woods = [
  { position: new Vector3(-4, 2, 0), density: 150, color: 0xebcb8b },
  { position: new Vector3(0, 2, 0), density: 500, color: 0xd08770 },
  { position: new Vector3(4, 2, 0), density: 900, color: 0x8f5b3a },
];
for (const { position, density, color } of woods) {
  const cube = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), new MeshStandardNodeMaterial({ color: new Color(color) }));
  cube.position.copy(position);
  scene.add(cube);
  // shape: 'voxels' fills the cube with small cells, which buoyancy then samples the water at.
  world.addBody(cube, { density, shape: 'voxels', cellSize: 0.25 }).addBehavior(new Buoyancy({ ocean }));
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
const timer = new Timer();
timer.connect(document);
renderer.setAnimationLoop((timestamp: number) => {
  timer.update(timestamp);
  world.update(timer.getDelta());
  controls.update();
  // the sea at the time the cubes are drawn at, finest around the camera
  water.update(renderer, world.renderTime, camera.position, camera);
  renderer.render(scene, camera);
});
