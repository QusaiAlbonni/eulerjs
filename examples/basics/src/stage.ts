import { Color, DirectionalLight, HemisphereLight, PerspectiveCamera, PMREMGenerator, Scene, Timer, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { World } from '@eulerjs/core';

/** The three.js boilerplate every example shares, so the example files only show physics. */
export interface Stage {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
}

export interface StageOptions {
  cameraPosition?: Vector3;
  lookAt?: Vector3;
  background?: number;
}

export function createStage(options: StageOptions = {}): Stage {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(options.background ?? 0x1b2129);
  scene.environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment()).texture;
  scene.environmentIntensity = 0.4;
  scene.add(new HemisphereLight(0xdde6f0, 0x2b2f36, 1.2));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(5, 10, 4);
  scene.add(sun);

  const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.copy(options.cameraPosition ?? new Vector3(6, 4, 8));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(options.lookAt ?? new Vector3(0, 1, 0));
  controls.enableDamping = true;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  return { scene, camera, renderer, controls };
}

/** The render loop: advance the world by the frame's time (which also moves the meshes), then draw. */
export function run(stage: Stage, world: World, onFrame?: (frameDelta: number) => void): void {
  const timer = new Timer();
  timer.connect(document);
  stage.renderer.setAnimationLoop((timestamp: number) => {
    timer.update(timestamp);
    const frameDelta = timer.getDelta();
    world.update(frameDelta);
    onFrame?.(frameDelta);
    stage.controls.update();
    stage.renderer.render(stage.scene, stage.camera);
  });
}

/** Writes `text` into the caption's status line, the element with id "status", if the page has one. */
export function showStatus(text: string): void {
  const status = document.getElementById('status');
  if (status) status.textContent = text;
}
