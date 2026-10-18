import { ACESFilmicToneMapping, Color, DirectionalLight, Fog, HemisphereLight, PCFSoftShadowMap, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';

export interface View {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  render(): void;
}

/** A late summer afternoon: warm low sun, a pale sky and soft shadows over the whole venue. */
const SKY = 0xf3dcc2;
const SHADOW_REACH = 32;

export function createView(container: HTMLElement): View {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(SKY);
  scene.fog = new Fog(SKY, 40, 130);
  scene.add(new HemisphereLight(0xfff4e6, 0x52603a, 1.4));

  const sun = new DirectionalLight(0xffe2b8, 2.6);
  sun.position.set(-30, 40, 25);
  sun.target.position.set(0, 0, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -SHADOW_REACH;
  sun.shadow.camera.right = SHADOW_REACH;
  sun.shadow.camera.top = SHADOW_REACH;
  sun.shadow.camera.bottom = -SHADOW_REACH;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 300);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, render: () => renderer.render(scene, camera) };
}
