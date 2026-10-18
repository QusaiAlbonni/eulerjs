// The landing page's hero: crates afloat on a spectral sea, live. A lite sea for a small window:
// three patches of waves at 64² rather than five at 128², and the physics floating the crates on
// the longest of them alone, on the main thread.
import { ACESFilmicToneMapping, BoxGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, PMREMGenerator, Scene, Timer, Vector3, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { World } from 'eulerjs';
import { Buoyancy, Ocean, SpectralWaves } from '@eulerjs/marine';
import { seaFog, SpectralWater } from '@eulerjs/marine/webgpu';

const CRATES = [
  { position: new Vector3(-3.2, 1, 1.5), size: new Vector3(1.6, 0.8, 1.2), density: 450, color: 0x8a5a3c },
  { position: new Vector3(0, 1, 0), size: new Vector3(2, 0.9, 1.4), density: 550, color: 0x7a4e33 },
  { position: new Vector3(3.4, 1, -1.2), size: new Vector3(1.2, 0.7, 1.2), density: 400, color: 0x96643f },
  { position: new Vector3(-1.2, 1, -3.6), size: new Vector3(1.4, 0.8, 1), density: 500, color: 0x845536 },
  { position: new Vector3(1.8, 1, 3.4), size: new Vector3(1.1, 0.6, 1.5), density: 350, color: 0x9a6a44 },
  { position: new Vector3(4.6, 1, 2.6), size: new Vector3(1.3, 0.7, 0.9), density: 600, color: 0x7f5236 },
];

/** How fast the camera goes round the crates, in radians a second, when no one is turning it. */
const ORBIT_SPEED = 0.06;

/**
 * Draws the hero's sea into `container`, calling `onShown` once it has drawn its first frames and
 * `onLost` if the GPU gives up on it. Resolves to a function that stops it and frees what it made.
 */
export async function startHeroSea(container: HTMLElement, onShown: () => void, onLost: () => void): Promise<() => void> {
  const renderer = new WebGPURenderer({ antialias: true, alpha: true });
  let lost = false;
  renderer.onDeviceLost = () => {
    lost = true;
    renderer.setAnimationLoop(null);
    onLost();
  };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.4;
  await renderer.init();
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.3, 400_000);
  camera.position.set(0, 4.5, 15);

  // a sky, and its light on the sea; reflections from it without the sun's disc, which would glare
  const sunDirection = new Vector3().setFromSphericalCoords(1, Math.PI * 0.4, Math.PI * 0.85);
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
  const environmentMaps = new PMREMGenerator(renderer);
  const environment = environmentMaps.fromScene(reflectedScene).texture;
  scene.environment = environment;
  const sun = new DirectionalLight(0xfff1dd, 3);
  sun.position.copy(sunDirection);
  scene.add(sun, new HemisphereLight(0xdde6f0, 0x2b2f36, 0.6));

  const world = new World();
  const waves = new SpectralWaves({
    windSpeed: 10,
    patchSizes: [113, 25, 5.5],
    resolution: 64,
    physicsResolution: 32,
    physicsPatches: 1,
  });
  const ocean = new Ocean({ waves, density: 1000 });
  const water = new SpectralWater(waves, { environment, sunDirection, levelCount: 15 });
  scene.add(water);
  scene.fogNode = seaFog(environment, { sunDirection });

  const geometries: BoxGeometry[] = [];
  const materials: MeshStandardNodeMaterial[] = [];
  for (const { position, size, density, color } of CRATES) {
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    const material = new MeshStandardNodeMaterial({ color: new Color(color), roughness: 0.8 });
    geometries.push(geometry);
    materials.push(material);
    const crate = new Mesh(geometry, material);
    crate.position.copy(position);
    crate.rotation.y = position.x * 0.7;
    scene.add(crate);
    world.addBody(crate, { density, shape: 'voxels', cellSize: 0.25 }).addBehavior(new Buoyancy({ ocean }));
  }

  // turning it by hand with a mouse; on a touch screen a drag scrolls the page, as it should
  const controls = window.matchMedia('(pointer: fine)').matches ? new OrbitControls(camera, renderer.domElement) : undefined;
  if (controls) {
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.minPolarAngle = Math.PI * 0.3;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.autoRotate = true;
    // given the frame's time, OrbitControls takes its speed in turns a minute
    controls.autoRotateSpeed = (ORBIT_SPEED * 60) / (2 * Math.PI);
    controls.enableDamping = true;
  }
  const lookAt = new Vector3(0, 0.5, 0);
  const orbitRadius = Math.hypot(camera.position.x, camera.position.z);
  let orbitAngle = 0;

  const resize = new ResizeObserver(() => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
  resize.observe(container);

  const timer = new Timer();
  timer.connect(document);
  let framesDrawn = 0;
  const draw = (timestamp: number) => {
    timer.update(timestamp);
    const frameDelta = Math.min(timer.getDelta(), 0.1);
    world.update(frameDelta);
    if (controls) {
      controls.update(frameDelta);
    } else {
      orbitAngle += ORBIT_SPEED * frameDelta;
      camera.position.set(Math.sin(orbitAngle) * orbitRadius, camera.position.y, Math.cos(orbitAngle) * orbitRadius);
      camera.lookAt(lookAt);
    }
    water.update(renderer, world.renderTime, camera.position, camera);
    renderer.render(scene, camera);
    // a few frames in, the sea's fields and the sky's reflections are all in
    if (++framesDrawn === 3) onShown();
  };
  if (controls) controls.target.copy(lookAt);
  else camera.lookAt(lookAt);

  // drawn only while it can be seen
  const visibility = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting && !lost) {
      timer.reset();
      renderer.setAnimationLoop(draw);
    } else {
      renderer.setAnimationLoop(null);
    }
  });
  visibility.observe(container);

  return () => {
    visibility.disconnect();
    resize.disconnect();
    renderer.setAnimationLoop(null);
    timer.dispose();
    controls?.dispose();
    water.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    environment.dispose();
    environmentMaps.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
