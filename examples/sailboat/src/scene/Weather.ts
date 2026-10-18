import { BufferAttribute, BufferGeometry, FogExp2, MeshStandardMaterial, PointLight, Points, PointsMaterial } from 'three';
import type { Mesh, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const CLOUD_COUNT = 250;
const CLOUD_SPREAD = 1000;
const CLOUD_HEIGHT = 250;
const CLOUD_TURN_SPEED = 0.03;

const RAINDROP_COUNT = 15000;
const RAIN_SPREAD = 500;
const RAIN_TOP = 200;
/** Raindrops fall at 84 to 90 m/s, i.e. the old 1.4 to 1.5 m per frame at 60 fps. */
const RAIN_SPEED = { slowest: 84, spread: 6 };
const RAIN_TURN_SPEED = 0.12;

/** Lightning strikes about this many times a second. */
const LIGHTNING_RATE = 6;
const LIGHTNING_POWER = { weakest: 50, spread: 500 };
/** A strike stays lit for a single frame once its power passes this. */
const LIGHTNING_FADE_POWER = 100;

/** Storm clouds, rain, lightning and fog, shown at night. */
export class NightWeather {
  private readonly rain: Points;
  private readonly raindropSpeeds = new Float32Array(RAINDROP_COUNT);
  private readonly lightning = new PointLight(0x062d89, 0, 500, 0);
  private readonly fog = new FogExp2(0x1c1c2a, 0.002);
  private stormy = false;

  private constructor(
    private readonly scene: Scene,
    private readonly clouds: readonly Object3D[],
  ) {
    this.lightning.position.set(200, 300, 100);
    this.rain = createRain(this.raindropSpeeds);
  }

  /** Loads the cloud model and builds the storm, which starts hidden. */
  static async load(scene: Scene, assetsPath: string): Promise<NightWeather> {
    const cloudModel = (await new GLTFLoader().loadAsync(`${assetsPath}clouds.glb`)).scene;
    cloudModel.scale.setScalar(0.1);
    const cloudMaterial = new MeshStandardMaterial({ color: 0x9e9e9e, metalness: 0.5, roughness: 0.5, emissive: 0x4b86a0, emissiveIntensity: 0 });
    cloudModel.traverse((node) => {
      if ((node as Mesh).isMesh) (node as Mesh).material = cloudMaterial;
    });
    const clouds = Array.from({ length: CLOUD_COUNT }, () => {
      const cloud = cloudModel.clone();
      cloud.position.set(randomBetween(-CLOUD_SPREAD, CLOUD_SPREAD), CLOUD_HEIGHT, randomBetween(-CLOUD_SPREAD, CLOUD_SPREAD));
      return cloud;
    });
    return new NightWeather(scene, clouds);
  }

  get isStormy(): boolean {
    return this.stormy;
  }

  toggle(): void {
    this.stormy = !this.stormy;
    if (this.stormy) {
      this.scene.add(this.lightning, this.rain, ...this.clouds);
      this.scene.fog = this.fog;
    } else {
      this.scene.remove(this.lightning, this.rain, ...this.clouds);
      this.scene.fog = null;
    }
  }

  update(frameDelta: number): void {
    if (!this.stormy) return;
    for (const cloud of this.clouds) cloud.rotation.y -= CLOUD_TURN_SPEED * frameDelta;
    this.updateLightning(frameDelta);
    this.updateRain(frameDelta);
  }

  private updateLightning(frameDelta: number): void {
    const strikeChance = 1 - Math.exp(-LIGHTNING_RATE * frameDelta);
    if (Math.random() >= strikeChance && this.lightning.power <= LIGHTNING_FADE_POWER) return;
    if (this.lightning.power < LIGHTNING_FADE_POWER) {
      this.lightning.position.set(randomBetween(-RAIN_SPREAD, RAIN_SPREAD), Math.random() * RAIN_TOP, randomBetween(-RAIN_SPREAD, RAIN_SPREAD));
      this.lightning.power = LIGHTNING_POWER.weakest + Math.random() * LIGHTNING_POWER.spread;
    } else {
      this.lightning.power = 0;
    }
  }

  private updateRain(frameDelta: number): void {
    const positions = this.rain.geometry.getAttribute('position') as BufferAttribute;
    for (let drop = 0; drop < RAINDROP_COUNT; drop++) {
      let height = positions.getY(drop) - this.raindropSpeeds[drop]! * frameDelta;
      if (height < 0) height = RAIN_TOP;
      positions.setY(drop, height);
    }
    positions.needsUpdate = true;
    this.rain.rotation.y += RAIN_TURN_SPEED * frameDelta;
  }
}

function createRain(raindropSpeeds: Float32Array): Points {
  const positions = new Float32Array(RAINDROP_COUNT * 3);
  for (let drop = 0; drop < RAINDROP_COUNT; drop++) {
    positions[drop * 3] = randomBetween(-RAIN_SPREAD, RAIN_SPREAD);
    positions[drop * 3 + 1] = Math.random() * RAIN_TOP;
    positions[drop * 3 + 2] = randomBetween(-RAIN_SPREAD, RAIN_SPREAD);
    raindropSpeeds[drop] = RAIN_SPEED.slowest + Math.random() * RAIN_SPEED.spread;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return new Points(geometry, new PointsMaterial({ color: 0xaaaaaa, size: 0.1, transparent: true }));
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}
