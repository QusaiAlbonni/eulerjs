import { ACESFilmicToneMapping, DirectionalLight, FogExp2, HemisphereLight, MathUtils, PCFShadowMap, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import type { Object3D } from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export interface View {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Keeps the sun's shadows round `target`, wherever it goes. */
  followWithShadows(target: Object3D): void;
  render(): void;
}

/** How far the sun's shadows reach round the car, in metres. */
const SHADOW_REACH = 40;

/** A sunny afternoon: the sky, its light on everything, and the sun's, casting soft shadows. */
export function createView(container: HTMLElement): View {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.42;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 6000);

  const sunDirection = new Vector3().setFromSphericalCoords(1, MathUtils.degToRad(52), MathUtils.degToRad(140));
  const sky = new Sky();
  sky.scale.setScalar(5000);
  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity']!.value = 4;
  skyUniforms['rayleigh']!.value = 1.2;
  skyUniforms['mieCoefficient']!.value = 0.004;
  skyUniforms['mieDirectionalG']!.value = 0.8;
  skyUniforms['sunPosition']!.value.copy(sunDirection);
  scene.add(sky);
  // the sky's light on everything, as an environment map
  const environment = new PMREMGenerator(renderer);
  const skyScene = new Scene();
  const skyCopy = sky.clone();
  skyScene.add(skyCopy);
  scene.environment = environment.fromScene(skyScene).texture;
  scene.environmentIntensity = 0.45;
  scene.fog = new FogExp2(0xb8c8d8, 0.00035);

  scene.add(new HemisphereLight(0xcfe3ff, 0x3a4a2c, 0.35));
  const sun = new DirectionalLight(0xfff1e0, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_REACH;
  sun.shadow.camera.right = SHADOW_REACH;
  sun.shadow.camera.top = SHADOW_REACH;
  sun.shadow.camera.bottom = -SHADOW_REACH;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return {
    renderer,
    scene,
    camera,
    followWithShadows(target) {
      sun.target.position.copy(target.position);
      sun.position.copy(target.position).addScaledVector(sunDirection, 200);
    },
    render() {
      renderer.render(scene, camera);
    },
  };
}
