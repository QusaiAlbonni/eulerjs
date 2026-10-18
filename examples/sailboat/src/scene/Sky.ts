import { AmbientLight, Color, DirectionalLight, MathUtils, PMREMGenerator, Scene, Vector3 } from 'three/webgpu';
import type { RenderTarget, SpotLight, WebGPURenderer } from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

/** Everything that changes between day and night. */
interface Lighting {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  lightColor: Color;
  lightIntensity: number;
  ambientColor: Color;
  ambientIntensity: number;
  /** Direction of the sun by day, of the moon by night. */
  lightDirection: Vector3;
}

const DAY: Lighting = {
  turbidity: 0.8,
  rayleigh: 0.5,
  // the haze about the sun: little of it, and close about it, or it whitens half the sky
  mieCoefficient: 0.0015,
  mieDirectionalG: 0.9,
  lightColor: new Color(0xfff2dd),
  lightIntensity: 2,
  ambientColor: new Color(0xffffff),
  ambientIntensity: 0.4,
  lightDirection: new Vector3().setFromSphericalCoords(1, MathUtils.degToRad(90 - 30), MathUtils.degToRad(90)),
};

const NIGHT: Lighting = {
  turbidity: 10,
  rayleigh: 0.5,
  mieCoefficient: 0.1,
  mieDirectionalG: 1,
  lightColor: new Color(0x9999ff),
  lightIntensity: 0.5,
  ambientColor: new Color(0xffffff),
  ambientIntensity: 0.1,
  lightDirection: new Vector3().setFromSphericalCoords(1, MathUtils.degToRad(90 - 8), MathUtils.degToRad(150)),
};

/** Fraction of the day-night transition covered per second. */
const TRANSITION_SPEED = 1.2;
/** Inside the camera's far plane, and outside the sea, which reaches 262 km. */
const SKY_SCALE = 300_000;
const HEADLIGHT = {
  dimmed: { intensity: 150, distance: 100 },
  fullBeam: { intensity: 300, distance: 200 },
};

/**
 * The sky dome, sun or moon light and ambient light, fading between day and night. The sky is
 * also baked into the scene's environment map, so the water and boat reflect it: a sky without
 * the sun's disc, which is tens of thousands of times brighter than the sky and would glare off
 * every wave. The sea's own glint stands in for the sun's reflection.
 */
export class DayNightSky {
  private readonly sky = new SkyMesh();
  /** The sky the environment is baked from: the same, without the sun. */
  private readonly environmentSky = new SkyMesh();
  private readonly sunOrMoon = new DirectionalLight();
  private readonly ambient = new AmbientLight();
  private readonly environmentScene = new Scene();
  private readonly environmentGenerator: PMREMGenerator;
  /** Baked into again each time, so that what samples it keeps the same texture. */
  private environmentTarget: RenderTarget | undefined;
  /** 0 is full day, 1 full night. */
  private transition = 0;
  private night = false;
  private fullBeam = false;

  constructor(
    private readonly scene: Scene,
    renderer: WebGPURenderer,
    private readonly headlight: SpotLight,
  ) {
    this.sky.scale.setScalar(SKY_SCALE);
    this.environmentSky.showSunDisc.value = 0;
    this.environmentScene.add(this.environmentSky);
    this.environmentGenerator = new PMREMGenerator(renderer);
    scene.add(this.sky, this.sunOrMoon, this.ambient);
    this.applyTransition();
  }

  get isNight(): boolean {
    return this.night;
  }

  /** Toward the sun by day, the moon by night. */
  get lightDirection(): Vector3 {
    return this.sunOrMoon.position;
  }

  /** The sun's or moon's light, and how bright it is. */
  get light(): DirectionalLight {
    return this.sunOrMoon;
  }

  toggleNight(): void {
    this.night = !this.night;
  }

  /** Switches the boat's headlight between dimmed and full beam; it only shines at night. */
  toggleHeadlight(): void {
    this.fullBeam = !this.fullBeam;
    this.updateHeadlight();
  }

  update(frameDelta: number): void {
    const targetTransition = this.night ? 1 : 0;
    if (this.transition === targetTransition) return;
    const step = TRANSITION_SPEED * frameDelta;
    this.transition = this.night ? Math.min(this.transition + step, 1) : Math.max(this.transition - step, 0);
    this.applyTransition();
  }

  dispose(): void {
    this.scene.remove(this.sky, this.sunOrMoon, this.ambient);
    this.environmentTarget?.dispose();
    this.environmentGenerator.dispose();
    for (const sky of [this.sky, this.environmentSky]) {
      sky.geometry.dispose();
      sky.material.dispose();
    }
  }

  private applyTransition(): void {
    const blend = this.transition;
    for (const sky of [this.sky, this.environmentSky]) {
      sky.turbidity.value = MathUtils.lerp(DAY.turbidity, NIGHT.turbidity, blend);
      sky.rayleigh.value = MathUtils.lerp(DAY.rayleigh, NIGHT.rayleigh, blend);
      sky.mieCoefficient.value = MathUtils.lerp(DAY.mieCoefficient, NIGHT.mieCoefficient, blend);
      sky.mieDirectionalG.value = MathUtils.lerp(DAY.mieDirectionalG, NIGHT.mieDirectionalG, blend);
      sky.sunPosition.value.lerpVectors(DAY.lightDirection, NIGHT.lightDirection, blend);
    }

    this.sunOrMoon.color.lerpColors(DAY.lightColor, NIGHT.lightColor, blend);
    this.sunOrMoon.intensity = MathUtils.lerp(DAY.lightIntensity, NIGHT.lightIntensity, blend);
    this.sunOrMoon.position.lerpVectors(DAY.lightDirection, NIGHT.lightDirection, blend).normalize();
    this.ambient.color.lerpColors(DAY.ambientColor, NIGHT.ambientColor, blend);
    this.ambient.intensity = MathUtils.lerp(DAY.ambientIntensity, NIGHT.ambientIntensity, blend);

    this.bakeEnvironment();
    this.updateHeadlight();
  }

  /** Renders the sky without its sun into a prefiltered environment map for reflections. */
  private bakeEnvironment(): void {
    this.environmentTarget = this.environmentGenerator.fromScene(this.environmentScene, 0, 0.1, 100, { renderTarget: this.environmentTarget ?? null });
    this.scene.environment = this.environmentTarget.texture;
  }

  private updateHeadlight(): void {
    const beam = this.fullBeam ? HEADLIGHT.fullBeam : HEADLIGHT.dimmed;
    this.headlight.distance = beam.distance;
    this.headlight.intensity = beam.intensity * this.transition;
  }
}
