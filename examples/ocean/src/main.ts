import { ACESFilmicToneMapping, BoxGeometry, DirectionalLight, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, PMREMGenerator, Scene, Timer, Vector3, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { World } from '@eulerjs/core';
import { Buoyancy, Ocean, SpectralWaves } from '@eulerjs/marine';
import { QuadtreeLod, seaFog, SpectralWater } from '@eulerjs/marine/webgpu';
import type { SpectralWaterOptions, SpectralWaterUniforms } from '@eulerjs/marine/webgpu';

// A spectral sea drawn to the horizon around the camera, with the two ways of laying it out to
// compare, and crates floating on the very waves drawn (their physics evaluated in a worker).

// ?msaa=1 and ?logDepth=1 turn those on, to see what they cost: on an integrated GPU, multisampling
// doubles what the water costs, and a logarithmic depth buffer adds a sixth
const parameters = new URLSearchParams(location.search);
const logarithmicDepthBuffer = parameters.get('logDepth') === '1';
const renderer = new WebGPURenderer({ antialias: parameters.get('msaa') === '1', trackTimestamp: true, logarithmicDepthBuffer });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, logarithmicDepthBuffer ? 0.05 : 0.5, 1_000_000);
camera.position.set(-14, 6, 18);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;

// the sky, lit by a low sun, and the sea's reflections taken from it: from a sky without the sun's
// disc in it, as the disc's thousands of times the sky's brightness would glare off every wave
const sunDirection = new Vector3().setFromSphericalCoords(1, Math.PI * 0.42, Math.PI * 0.8);
const makeSky = () => {
  const result = new SkyMesh();
  result.scale.setScalar(900_000);
  result.sunPosition.value.copy(sunDirection);
  result.turbidity.value = 3;
  result.rayleigh.value = 1.6;
  result.mieCoefficient.value = 0.003;
  result.mieDirectionalG.value = 0.7;
  return result;
};
const sky = makeSky();
scene.add(sky);
const environmentSky = makeSky();
environmentSky.showSunDisc.value = 0;
const environmentScene = new Scene();
environmentScene.add(environmentSky);
scene.environment = new PMREMGenerator(renderer).fromScene(environmentScene).texture;
renderer.toneMappingExposure = 0.35;
const sun = new DirectionalLight(0xfff1dd, 3.5);
sun.position.copy(sunDirection).multiplyScalar(100);
scene.add(sun);

// ?patches=512,97,19&resolution=256 to try other cascades
const patchSizes = parameters.get('patches')?.split(',').map(Number);
const resolution = parameters.has('resolution') ? Number(parameters.get('resolution')) : undefined;
// ?swell=0 and ?gusts=0 for none, to see what they do
const numberParameter = (name: string) => (parameters.has(name) ? Number(parameters.get(name)) : undefined);
const waves = new SpectralWaves({ patchSizes, resolution, swellHeight: numberParameter('swell'), gustiness: numberParameter('gusts') });
waves.useWorker(new Worker(new URL('../../../packages/marine/src/waves/spectralWorkerEntry.ts', import.meta.url), { type: 'module' }));
const ocean = new Ocean({ waves });

const world = new World();
const crateMaterial = new MeshStandardNodeMaterial({ color: 0xb07a45, roughness: 0.8 });
for (let index = 0; index < 6; index++) {
  const crate = new Mesh(new BoxGeometry(1.6, 1, 2.2), crateMaterial);
  crate.position.set((index % 3) * 6 - 6, 1, Math.floor(index / 3) * 7 - 3.5);
  crate.rotation.y = index * 0.7;
  scene.add(crate);
  world.addBody(crate, { density: 450, shape: 'voxels', cellSize: 0.25 }).addBehavior(new Buoyancy({ ocean }));
}

// the sea's wind, and how much larger and wilder than it the waves are made
const seaSliders = ['windSpeed', 'heightScale', 'choppiness'] as const;
const showSea = () => {
  for (const name of seaSliders) document.getElementById(`${name}Value`)!.textContent = name === 'windSpeed' ? `${waves.sea.windSpeed} m/s` : String(waves.sea[name]);
  document.getElementById('heightScaleValue')!.textContent += ` (waves ${waves.significantWaveHeight.toFixed(1)} m high)`;
};
for (const name of seaSliders) {
  const slider = document.getElementById(name) as HTMLInputElement;
  slider.value = String(waves.sea[name]);
  slider.addEventListener('input', () => {
    waves.setSea({ [name]: Number(slider.value) });
    showSea();
  });
}
showSea();

// the foam: where it forms (a Jacobian), how fast it grows and fades; the water's own uniforms, so set on whichever water there is
const foamSliders = { foamBias: 'bias', foamGrowth: 'growth', foamDecay: 'decay', foamPeakLift: 'peakLift' } as const;
for (const [id, setting] of Object.entries(foamSliders)) {
  const slider = document.getElementById(id) as HTMLInputElement;
  const show = () => (document.getElementById(`${id}Value`)!.textContent = slider.value);
  slider.addEventListener('input', () => {
    water.fields.foamSettings[setting].value = Number(slider.value);
    show();
  });
  show();
}

// and where on the waves it shows: the material's own
for (const id of ['foamPeakBoost', 'foamLowest'] as const) {
  const slider = document.getElementById(id) as HTMLInputElement;
  const show = () => (document.getElementById(`${id}Value`)!.textContent = slider.value);
  slider.addEventListener('input', () => {
    (water.lod.material.userData.uniforms as SpectralWaterUniforms)[id].value = Number(slider.value);
    show();
  });
  show();
}

const lodChoice = document.getElementById('lod') as HTMLSelectElement;
const culling = document.getElementById('culling') as HTMLInputElement;
const wireframe = document.getElementById('wireframe') as HTMLInputElement;
const stats = document.getElementById('stats')!;

let water = makeWater(lodChoice.value as 'rings' | 'quadtree');
// a haze over the far sea, the sky's own colour: where the patches' repeats would show most
scene.fogNode = seaFog(scene.environment!, { sunDirection });
function makeWater(lod: 'rings' | 'quadtree'): SpectralWater {
  // ?precision=half for the transform in half precision floats: cheaper, blotchy close up
  const precision = parameters.get('precision') === 'half' ? 'half' : 'single';
  const options: SpectralWaterOptions = lod === 'quadtree' ? { lod, precision } : { lod, precision };
  const foam = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value);
  const result = new SpectralWater(waves, { ...options, environment: scene.environment!, sunDirection, foamBias: foam('foamBias'), foamGrowth: foam('foamGrowth'), foamDecay: foam('foamDecay'), foamPeakLift: foam('foamPeakLift'), foamPeakBoost: foam('foamPeakBoost'), foamLowest: foam('foamLowest') });
  result.lod.material.wireframe = wireframe.checked;
  scene.add(result);
  return result;
}
lodChoice.addEventListener('change', () => {
  scene.remove(water);
  water.dispose();
  water = makeWater(lodChoice.value as 'rings' | 'quadtree');
  resetAverages();
});
wireframe.addEventListener('change', () => (water.lod.material.wireframe = wireframe.checked));
culling.addEventListener('change', resetAverages);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-height]')) {
  button.addEventListener('click', () => {
    const height = Number(button.dataset.height);
    const toward = camera.position.clone().sub(controls.target).setY(0).normalize();
    camera.position.copy(controls.target).addScaledVector(toward, height * 2.5).setY(height);
    resetAverages();
  });
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// what each frame costs, averaged over the last half second
const averages = { frames: 0, gpu: 0, gpuFrames: 0, layout: 0, waves: 0, render: 0, frameTime: 0 };
function resetAverages(): void {
  Object.assign(averages, { frames: 0, gpu: 0, gpuFrames: 0, layout: 0, waves: 0, render: 0, frameTime: 0 });
}
let lastReport = performance.now();
// for poking at from the console
(window as unknown as { ocean: unknown }).ocean = { renderer, scene, camera, controls, sky, sun, get water() { return water; } };

const timer = new Timer();
renderer.setAnimationLoop(async (timestamp) => {
  timer.update(timestamp);
  const frameDelta = Math.min(timer.getDelta(), 0.1);
  controls.update();
  world.update(frameDelta);

  const wavesStarted = performance.now();
  water.fields.update(renderer, world.renderTime);
  const layoutStarted = performance.now();
  if (water.lod instanceof QuadtreeLod) water.lod.update(camera.position, culling.checked ? camera : undefined);
  else water.lod.update(camera.position);
  averages.layout += performance.now() - layoutStarted;
  averages.waves += layoutStarted - wavesStarted;
  const renderStarted = performance.now();
  renderer.render(scene, camera);
  averages.render += performance.now() - renderStarted;
  averages.frames++;
  averages.frameTime += frameDelta;

  const gpu = await renderer.resolveTimestampsAsync('render');
  if (typeof gpu === 'number' && gpu > 0) {
    averages.gpu += gpu;
    averages.gpuFrames++;
  }
  const now = performance.now();
  if (now - lastReport > 500 && averages.frames > 0) {
    lastReport = now;
    const info = renderer.info.render;
    const lod = water.lod;
    stats.textContent = [
      `${(averages.frames / averages.frameTime).toFixed(0)} frames a second`,
      `GPU ${averages.gpuFrames ? (averages.gpu / averages.gpuFrames).toFixed(2) : '–'} ms a frame (waves ${water.fields.passCount} passes)`,
      `CPU: laying out the sea ${(averages.layout / averages.frames).toFixed(3)} ms, sending the waves' passes ${(averages.waves / averages.frames).toFixed(3)} ms, drawing ${(averages.render / averages.frames).toFixed(3)} ms a frame`,
      `water: ${lod.drawCallCount} draw calls, ${(lod.triangleCount / 1000).toFixed(0)}k triangles, reaching ${(lod.reach / 1000).toFixed(0)} km`,
      `all: ${info.drawCalls} draw calls, ${(info.triangles / 1000).toFixed(0)}k triangles`,
      `physics waves from the worker ${waves.workerStatistics.ready}, missed ${waves.workerStatistics.missed}`,
    ].join('\n');
    (window as unknown as { oceanStats: unknown }).oceanStats = {
      lod: lodChoice.value,
      culling: culling.checked,
      height: camera.position.y,
      fps: averages.frames / averages.frameTime,
      gpu: averages.gpuFrames ? averages.gpu / averages.gpuFrames : null,
      layout: averages.layout / averages.frames,
      waves: averages.waves / averages.frames,
      render: averages.render / averages.frames,
      drawCalls: lod.drawCallCount,
      triangles: lod.triangleCount,
    };
    resetAverages();
  }
});

// ?compare=1: each way of laying the sea out, from each height, a few seconds each, the results
// left in window.comparison (and the panel) for reading off
interface Comparison {
  lod: 'rings' | 'quadtree';
  culled: boolean;
  height: number;
  gpu: number | null;
  layout: number;
  render: number;
  drawCalls: number;
  triangles: number;
}
async function compare(): Promise<void> {
  const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const results: Comparison[] = [];
  const settings: { lod: 'rings' | 'quadtree'; culled: boolean }[] = [
    { lod: 'rings', culled: false },
    { lod: 'quadtree', culled: false },
    { lod: 'quadtree', culled: true },
  ];
  for (const height of [2, 30, 400]) {
    for (const { lod, culled } of settings) {
      if (lodChoice.value !== lod) {
        lodChoice.value = lod;
        lodChoice.dispatchEvent(new Event('change'));
      }
      culling.checked = culled;
      // looking out to sea, a little down
      camera.position.set(0, height, 0);
      controls.target.set(0, 0, -Math.max(30, 4 * height));
      await wait(1500);
      resetAverages();
      await wait(2000);
      const stats = (window as unknown as { oceanStats: Comparison }).oceanStats;
      results.push({ lod, culled, height, gpu: stats.gpu, layout: stats.layout, render: stats.render, drawCalls: stats.drawCalls, triangles: stats.triangles });
    }
  }
  (window as unknown as { comparison: Comparison[] }).comparison = results;
  const report = document.createElement('div');
  report.id = 'stats';
  stats.after(report);
  report.textContent = results
    .map(({ lod, culled, height, gpu, layout, render, drawCalls, triangles }) => `${lod}${culled ? ', culled' : ''} from ${height} m: GPU ${gpu?.toFixed(2) ?? '–'} ms, CPU ${(layout + render).toFixed(3)} ms, ${drawCalls} draw calls, ${(triangles / 1000).toFixed(0)}k triangles`)
    .join('\n');
}
if (parameters.get('compare') === '1') void compare();
