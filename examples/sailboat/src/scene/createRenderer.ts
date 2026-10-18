import { ACESFilmicToneMapping, PerspectiveCamera, RenderPipeline, Scene, WebGPURenderer } from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export interface RenderSetup {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  render(): void;
  dispose(): void;
}

/** What glows: only what is still this bright once tone mapped, the sun and its glint off the sea. */
const BLOOM = { strength: 0.2, radius: 0.2, threshold: 0.98 };

/**
 * Renderer, scene, camera and the post-processing chain, sized to the window. WebGPURenderer, on
 * WebGPU or its own WebGL 2 fallback, for the spectral sea.
 *
 * The scene is tone mapped before it blooms, not after: the sky's sun is tens of thousands of times
 * brighter than the sky, and bloomed as it is, it spreads into a glare over half the screen.
 */
export async function createRenderer(container: HTMLElement): Promise<RenderSetup> {
  const renderer = new WebGPURenderer({ powerPreference: 'high-performance' });
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.4;
  container.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new Scene();
  // far enough for the sea to reach the horizon
  const camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.3, 400_000);
  camera.position.set(0, 5, -30);

  const renderPipeline = new RenderPipeline(renderer);
  renderPipeline.outputColorTransform = false;
  const toneMapped = renderOutput(pass(scene, camera));
  const glow = bloom(toneMapped, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  renderPipeline.outputNode = fxaa(toneMapped.add(glow));

  const fitToWindow = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  fitToWindow();
  window.addEventListener('resize', fitToWindow);

  return {
    renderer,
    scene,
    camera,
    render: () => renderPipeline.render(),
    dispose: () => {
      window.removeEventListener('resize', fitToWindow);
      renderPipeline.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
