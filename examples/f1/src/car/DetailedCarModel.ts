import { Box3, CanvasTexture, Color, Group, Matrix4, Mesh, MeshStandardMaterial, TextureLoader, Vector3 } from 'three';
import type { BufferGeometry, Material, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { contactShadow } from './CarModel.js';
import type { Wheel } from '@eulerjs/vehicle';
import type { Livery } from './livery.js';
import { SPECIFICATION } from './specification.js';

// A detailed Formula 1 car, from "F1 2021 McLaren MCL35M" by Excalibur on Sketchfab
// (https://sketchfab.com/3d-models/f1-2021-mclaren-mcl35m-967ecec37468412083c40c62b3d7234d, CC BY
// 4.0), in our own livery: repainted, every team and sponsor logo painted out. Its colours and
// number are each car's own, laid over it as it draws (see `Paint`). Its wheels are part of its meshes: they are cut out, a wheel to each corner,
// so that they steer, spin and ride the suspension. The model is scaled so that its wheelbase is
// the physics car's, and stood on the ground where the physics car stands.

const GROUND = -SPECIFICATION.centerOfMassHeight;
const frontAxleZ = SPECIFICATION.wheelbase * (1 - SPECIFICATION.frontWeightShare);
/** The model's materials that belong to the wheels, and the steering wheel's. */
const WHEEL_MATERIALS = new Set(['rim_png', 'tread_png', 'tyrewall_png']);
const STEERING_WHEEL_MATERIAL = 'st_wheel_png';
/** The painted materials: the livery (the nose, sidepods, flanks and wings), and the halo with the airbox. */
const LIVERY_MATERIAL = 'livery_png';
const HALO_MATERIAL = 'halo_png';
/** How far the steering wheel turns at full lock, in radians. */
const STEERING_WHEEL_LOCK = 1.4;

interface Part {
  geometry: BufferGeometry;
  material: Material;
}

/** The corners in the physics car's order: front left, front right, rear left, rear right (+x is left). */
function cornerOf(point: Vector3, middleZ: number): number {
  return (point.z > middleZ ? 0 : 2) + (point.x > 0 ? 0 : 1);
}

/** The triangles of `geometry` whose centres `keep` says to keep, as a geometry of their own. */
function triangles(geometry: BufferGeometry, keep: (centre: Vector3) => boolean): BufferGeometry {
  const position = geometry.getAttribute('position');
  const index = geometry.index!;
  const kept: number[] = [];
  const centre = new Vector3();
  const corner = new Vector3();
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    centre.set(0, 0, 0);
    for (let vertex = 0; vertex < 3; vertex++) centre.add(corner.fromBufferAttribute(position, index.getX(triangle + vertex)));
    centre.divideScalar(3);
    if (keep(centre)) kept.push(index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2));
  }
  const part = geometry.clone();
  part.setIndex(kept);
  return part;
}

function shaded(mesh: Mesh): Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** What the model is drawn from: each wheel as the vehicle reports it, and the steering. An `F1Car` is one; another player's car, as it comes over the network, another. */
export interface CarPose {
  readonly vehicle: { readonly wheels: readonly Pick<Wheel, 'mount' | 'suspensionLength' | 'compression' | 'steerAngle' | 'spinAngle'>[] };
  readonly input: { readonly steer: number };
}

/** One wheel: `steer` turns about the strut, `spin` about the axle. */
interface WheelModel {
  steer: Group;
  spin: Group;
}

/** The model as loaded and fitted to the physics car, once, for every car to be cloned from. */
interface Template {
  root: Group;
  /** How much lower the model's wheel centres sit than the physics wheels', its tyres being smaller. */
  wheelDrop: number;
  /** Each painted material's mask: red where the main colour goes, green the second, blue the lettering. */
  masks: Map<string, Texture>;
}

const templates = new Map<string, Promise<Template>>();

/** The detailed car's meshes, as `CarModel`'s: give `root` to the car's body, and call `update` each frame. */
export class DetailedCarModel {
  /** The model's credit, for the page it is shown on: its title, author, source and licence, and what we changed. */
  static readonly CREDIT =
    'The car after <a href="https://sketchfab.com/3d-models/f1-2021-mclaren-mcl35m-967ecec37468412083c40c62b3d7234d">“F1 2021 McLaren MCL35M”</a>' +
    ' by Excalibur, under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>: repainted, its logos removed.' +
    ' Not affiliated with or endorsed by McLaren or Formula 1.';
  readonly root: Group;
  private readonly wheels: WheelModel[] = [];
  private readonly steeringWheel: Object3D;
  private readonly wheelDrop: number;
  private readonly paint: Paint;

  /**
   * A car from the model at `url` (its masks beside it, as `<name>-livery-mask.png` and
   * `<name>-halo-mask.png`) in `livery`. The model is loaded once however many cars are made from it.
   */
  static async load(url: string, livery: Livery): Promise<DetailedCarModel> {
    let template = templates.get(url);
    if (!template) {
      template = loadTemplate(url);
      templates.set(url, template);
    }
    return new DetailedCarModel(await template, livery);
  }

  private constructor(template: Template, livery: Livery) {
    this.root = template.root.clone(true);
    this.wheelDrop = template.wheelDrop;
    for (let corner = 0; corner < 4; corner++) {
      const steer = this.root.getObjectByName(`steer ${corner}`) as Group;
      this.wheels.push({ steer, spin: steer.getObjectByName('spin') as Group });
    }
    this.steeringWheel = this.root.getObjectByName('steering wheel')!;
    // this car's own paint on its own copies of the painted materials; everything else is shared
    this.paint = new Paint(livery);
    const painted = new Map<Material, Material>();
    this.root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const mask = template.masks.get((object.material as Material).name);
      if (!mask) return;
      let material = painted.get(object.material as Material);
      if (!material) {
        material = this.paint.material(object.material as MeshStandardMaterial, mask);
        painted.set(object.material as Material, material);
      }
      object.material = material;
    });
  }

  /** Repaints the car: cheap enough to do at any time, the colours being the shader's and the number drawn alone. */
  setLivery(livery: Livery): void {
    this.paint.set(livery);
  }

  update(car: CarPose, _frameDelta: number): void {
    car.vehicle.wheels.forEach((wheel, index) => {
      const model = this.wheels[index]!;
      model.steer.position.y = wheel.mount.y - (wheel.suspensionLength - wheel.compression) - this.wheelDrop;
      model.steer.rotation.y = wheel.steerAngle;
      model.spin.rotation.x = wheel.spinAngle;
    });
    // turning left, the driver turns the wheel anticlockwise
    this.steeringWheel.rotation.z = -car.input.steer * STEERING_WHEEL_LOCK;
  }
}

async function loadTemplate(url: string): Promise<Template> {
  const name = url.replace(/\.glb$/, '');
  const textures = new TextureLoader();
  const [gltf, liveryMask, haloMask] = await Promise.all([new GLTFLoader().loadAsync(url), textures.loadAsync(`${name}-livery-mask.png`), textures.loadAsync(`${name}-halo-mask.png`)]);
  // as the model's own textures are, against its UVs
  for (const mask of [liveryMask, haloMask]) mask.flipY = false;
  gltf.scene.updateMatrixWorld(true);
  const parts: Part[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    // in the car's frame: Sketchfab's root turns the model's z up to y, and its front to +z
    parts.push({ geometry: (object.geometry as BufferGeometry).clone().applyMatrix4(object.matrixWorld), material: object.material as Material });
  });
  return { ...fitted(parts), masks: new Map([[LIVERY_MATERIAL, liveryMask], [HALO_MATERIAL, haloMask]]) };
}

/** The model's parts scaled and placed on the physics car, its wheels cut out to steer and spin. */
function fitted(parts: Part[]): { root: Group; wheelDrop: number } {
  const root = new Group();
  root.add(contactShadow());

  // the tyres' treads say where the wheels are, and how big
  const treads = parts.filter((part) => part.material.name === 'tread_png');
  const treadBox = new Box3();
  for (const tread of treads) treadBox.union(tread.geometry.computeBoundingBox() ?? tread.geometry.boundingBox!);
  const middleZ = (treadBox.min.z + treadBox.max.z) / 2;
  const cornerBoxes = [0, 1, 2, 3].map(() => new Box3());
  const point = new Vector3();
  for (const tread of treads) {
    const position = tread.geometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex++) {
      point.fromBufferAttribute(position, vertex);
      cornerBoxes[cornerOf(point, middleZ)]!.expandByPoint(point);
    }
  }
  const centres = cornerBoxes.map((box) => box.getCenter(new Vector3()));
  const modelRadius = (cornerBoxes[0]!.max.y - cornerBoxes[0]!.min.y) / 2;
  const modelWheelbase = (centres[0]!.z + centres[1]!.z) / 2 - (centres[2]!.z + centres[3]!.z) / 2;
  const modelGround = treadBox.min.y;

  // scaled to the physics car's wheelbase, its front axle on the physics car's, on the ground
  const scale = SPECIFICATION.wheelbase / modelWheelbase;
  const frontZ = (centres[0]!.z + centres[1]!.z) / 2;
  const placing = new Matrix4().makeTranslation(0, GROUND - modelGround * scale, frontAxleZ - frontZ * scale).multiply(new Matrix4().makeScale(scale, scale, scale));

  // found again by name in each car cloned from this one
  const wheels = centres.map((centre, corner) => {
    const steer = new Group();
    steer.name = `steer ${corner}`;
    steer.position.copy(centre).applyMatrix4(placing);
    const spin = new Group();
    spin.name = 'spin';
    steer.add(spin);
    root.add(steer);
    return { steer, spin };
  });
  const steeringWheel = new Group();
  steeringWheel.name = 'steering wheel';

  for (const material of new Set(parts.map((part) => part.material))) tuneMaterial(material);
  for (const part of parts) {
    if (WHEEL_MATERIALS.has(part.material.name)) {
      // cut into its four wheels, each about its own centre
      wheels.forEach((wheel, corner) => {
        const geometry = triangles(part.geometry, (centre) => cornerOf(centre, middleZ) === corner).applyMatrix4(placing);
        geometry.translate(-wheel.steer.position.x, -wheel.steer.position.y, -wheel.steer.position.z);
        wheel.spin.add(shaded(new Mesh(geometry, part.material)));
      });
    } else if (part.material.name === STEERING_WHEEL_MATERIAL) {
      const geometry = part.geometry.applyMatrix4(placing);
      const pivot = geometry.computeBoundingBox() ?? geometry.boundingBox!;
      pivot.getCenter(steeringWheel.position);
      geometry.translate(-steeringWheel.position.x, -steeringWheel.position.y, -steeringWheel.position.z);
      steeringWheel.add(shaded(new Mesh(geometry, part.material)));
      root.add(steeringWheel);
    } else root.add(shaded(new Mesh(part.geometry.applyMatrix4(placing), part.material)));
  }
  return { root, wheelDrop: SPECIFICATION.wheel.radius - modelRadius * scale };
}

/**
 * A car's paint: its colours as the painted materials' uniforms, mixed in over the model's own
 * texture where its masks say, and its number drawn alone on a clear canvas laid over the livery.
 */
class Paint {
  private readonly main = { value: new Color() };
  private readonly second = { value: new Color() };
  private readonly lettering = { value: new Color() };
  private readonly numberColor = { value: new Color() };
  private readonly numberCanvas = document.createElement('canvas');
  private readonly numberTexture = new CanvasTexture(this.numberCanvas);

  constructor(livery: Livery) {
    this.numberCanvas.width = this.numberCanvas.height = NUMBER_CANVAS_SIZE;
    this.numberTexture.flipY = false;
    this.set(livery);
  }

  set(livery: Livery): void {
    this.main.value.set(livery.main);
    this.second.value.set(livery.second);
    this.lettering.value.set(livery.lettering);
    this.numberColor.value.set(livery.numberColor);
    drawNumber(this.numberCanvas, livery.number);
    this.numberTexture.needsUpdate = true;
  }

  /** A copy of `original` painted by this paint through `mask`; the livery's material carries the number too. */
  material(original: MeshStandardMaterial, mask: Texture): MeshStandardMaterial {
    const material = original.clone();
    const numbered = original.name === LIVERY_MATERIAL;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { liveryMask: { value: mask }, liveryMain: this.main, liverySecond: this.second, liveryLettering: this.lettering, liveryNumber: { value: this.numberTexture }, liveryNumberColor: this.numberColor });
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${numbered ? '#define LIVERY_NUMBER\n' : ''}${PAINT_UNIFORMS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${PAINT_FRAGMENT}`);
    };
    // every car's painted materials share the two programs, their colours being uniforms
    material.customProgramCacheKey = () => (numbered ? 'livery with number' : 'livery');
    return material;
  }
}

const PAINT_UNIFORMS = `
uniform sampler2D liveryMask;
uniform vec3 liveryMain;
uniform vec3 liverySecond;
uniform vec3 liveryLettering;
#ifdef LIVERY_NUMBER
uniform sampler2D liveryNumber;
uniform vec3 liveryNumberColor;
#endif
`;
const PAINT_FRAGMENT = `
vec3 liveryCoverage = texture2D( liveryMask, vMapUv ).rgb;
diffuseColor.rgb = mix( diffuseColor.rgb, liveryMain, liveryCoverage.r );
diffuseColor.rgb = mix( diffuseColor.rgb, liverySecond, liveryCoverage.g );
diffuseColor.rgb = mix( diffuseColor.rgb, liveryLettering, liveryCoverage.b );
#ifdef LIVERY_NUMBER
diffuseColor.rgb = mix( diffuseColor.rgb, liveryNumberColor, texture2D( liveryNumber, vMapUv ).a );
#endif
`;

/** The livery texture's size, in texels: the number canvas lies over it texel for texel. */
const NUMBER_CANVAS_SIZE = 1024;
/**
 * Where the number goes on the livery texture: centre and height in texels, and its turn,
 * anticlockwise in degrees. The model reads the texture upside down, so each is drawn mirrored.
 */
const NUMBER_SPOTS = [
  // the nose, read from behind: from the chase view and the T-cam
  { x: 280, y: 415, height: 60, turn: -90 },
  // the engine cover's flanks, read from the side, and its tail, from either side
  { x: 58, y: 945, height: 56, turn: -14 },
  { x: 195, y: 955, height: 56, turn: 189 },
  { x: 840, y: 955, height: 56, turn: 171 },
  { x: 965, y: 945, height: 56, turn: 14 },
];

function drawNumber(canvas: HTMLCanvasElement, number: string): void {
  const context = canvas.getContext('2d')!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  // two figures narrower, to fit where one does
  const squeeze = number.length > 1 ? 0.8 : 1;
  for (const spot of NUMBER_SPOTS) {
    context.font = `italic 800 ${Math.round(spot.height * 1.35 * squeeze)}px Ubuntu, system-ui, sans-serif`;
    const size = context.measureText(number);
    context.save();
    context.translate(spot.x, spot.y);
    context.rotate((-spot.turn * Math.PI) / 180);
    context.scale(1, -1);
    // centred on its figures, not on the font's line
    context.fillText(number, 0, (size.actualBoundingBoxAscent - size.actualBoundingBoxDescent) / 2);
    context.restore();
  }
}

/** Sketchfab's tyres are metallic, which a sky's reflection shows up: rubber isn't. */
function tuneMaterial(material: Material): void {
  if (!(material instanceof MeshStandardMaterial)) return;
  if (material.name === 'tread_png' || material.name === 'tyrewall_png') {
    material.metalness = 0;
    material.roughness = 0.9;
  }
}
