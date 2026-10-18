import { ACESFilmicToneMapping, Color, DirectionalLight, Fog, HemisphereLight, PCFShadowMap, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import type { Object3D } from 'three';

export interface View {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Moves the sun's shadow box along with `target`, so shadows stay sharp wherever the car goes. */
  followWithShadows(target: Object3D): void;
  render(): void;
}

const SKY = 0xa9c6de;
/** Half the side of the box the sun casts shadows in, in metres. */
const SHADOW_REACH = 70;
/** Where the sun shines from, relative to what it lights. */
const SUN_OFFSET = new Vector3(60, 120, 40);

export function createView(container: HTMLElement): View {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(SKY);
  scene.fog = new Fog(SKY, 80, 320);
  scene.add(new HemisphereLight(0xdfeeff, 0x4a4238, 1.2));

  const sun = new DirectionalLight(0xfff1dc, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_REACH;
  sun.shadow.camera.right = SHADOW_REACH;
  sun.shadow.camera.top = SHADOW_REACH;
  sun.shadow.camera.bottom = -SHADOW_REACH;
  sun.shadow.camera.far = 300;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return {
    renderer,
    scene,
    camera,
    followWithShadows(target: Object3D): void {
      sun.target.position.copy(target.position);
      sun.position.copy(target.position).add(SUN_OFFSET);
    },
    render(): void {
      renderer.render(scene, camera);
    },
  };
}
