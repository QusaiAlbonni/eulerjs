import { Color, Timer } from 'three/webgpu';
import Stats from 'three/addons/libs/stats.module.js';
import { World } from 'eulerjs';
import { Ocean, SpectralWaves, Wind } from '@eulerjs/marine';
import { seaFog, SpectralWater } from '@eulerjs/marine/webgpu';
import { createSailboat } from './boat/createSailboat.js';
import { CameraRig } from './scene/CameraRig.js';
import { createRenderer } from './scene/createRenderer.js';
import { createObstacles } from './scene/obstacles.js';
import { DayNightSky } from './scene/Sky.js';
import { NightWeather } from './scene/Weather.js';
import { createGui } from './ui/createGui.js';
import { HelpOverlay } from './ui/HelpOverlay.js';
import { WindCompass } from './ui/WindCompass.js';
import type { SpectralWaterUniforms } from '@eulerjs/marine/webgpu';
import { SeaFollowsWind } from './scene/SeaFollowsWind.js';

const ASSETS_PATH = `${import.meta.env.BASE_URL}assets/`;
/** How much brighter the sun's glint off the sea is than its light on the boat. */
const SUN_GLINT = 60;

async function start(): Promise<void> {
  const view = await createRenderer(document.body);
  const world = new World({ timestep: 1 / 120 });
  const wind = new Wind();
  // a sea raised by the wind, its waves evaluated for the physics off the main thread
  const waves = new SpectralWaves({ windAngle: wind.angle });
  waves.useWorker(new Worker(new URL('../../../packages/marine/src/waves/spectralWorkerEntry.ts', import.meta.url), { type: 'module' }));
  const ocean = new Ocean({ waves });

  const [sailboat, weather] = await Promise.all([createSailboat({ world, scene: view.scene, ocean, wind, assetsPath: ASSETS_PATH }), NightWeather.load(view.scene, ASSETS_PATH)]);
  createObstacles(world, view.scene, ocean);

  const sky = new DayNightSky(view.scene, view.renderer, sailboat.headlight);
  const sunColor = new Color();
  const water = new SpectralWater(waves, { environment: view.scene.environment!, sunDirection: sky.lightDirection, sunColor });
  view.scene.add(water);
  const waterUniforms = water.lod.material.userData.uniforms as SpectralWaterUniforms;
  // a haze over the far sea by day; the storm brings its own fog by night
  const dayFog = seaFog(view.scene.environment!, { sunDirection: sky.lightDirection });
  view.scene.fogNode = dayFog;
  const followWind = new SeaFollowsWind(waves, wind);
  const cameraRig = new CameraRig({ camera: view.camera, target: sailboat.object, ocean, domElement: view.renderer.domElement });
  new WindCompass(wind, document.body);
  createGui({ sailboat, ocean, wind });
  const help = new HelpOverlay(document.body);
  const stats = new Stats();
  document.body.appendChild(stats.dom);

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    switch (event.code) {
      case 'KeyN':
        sky.toggleNight();
        weather.toggle();
        view.scene.fogNode = weather.isStormy ? null : dayFog;
        break;
      case 'KeyL':
        sky.toggleHeadlight();
        break;
      case 'KeyV':
        cameraRig.toggleMode();
        break;
      case 'KeyG':
        cameraRig.resetBehindTarget();
        break;
      case 'KeyH':
        help.toggle();
        break;
    }
  });

  document.getElementById('status')?.remove();
  const timer = new Timer();
  timer.connect(document);
  view.renderer.setAnimationLoop((timestamp: number) => {
    timer.update(timestamp);
    const frameDelta = timer.getDelta();
    world.update(frameDelta);
    sailboat.update(frameDelta);
    sky.update(frameDelta);
    weather.update(frameDelta);
    followWind.update(frameDelta);
    cameraRig.update(frameDelta, world.renderTime);
    // the sun's (or the moon's) glint off the sea, as bright as its light
    waterUniforms.sunDirection.value.copy(sky.lightDirection);
    waterUniforms.sunColor.value.copy(sky.light.color).multiplyScalar(SUN_GLINT * sky.light.intensity);
    waterUniforms.sunLight.value.copy(sky.light.color).multiplyScalar(1.25 * sky.light.intensity);
    water.update(view.renderer, world.renderTime, view.camera.position, view.camera);
    view.render();
    stats.update();
  });
}

start().catch((error: unknown) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = `Could not start the example: ${error instanceof Error ? error.message : String(error)}`;
});
