import { CanvasTexture, CatmullRomCurve3, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, RingGeometry, SphereGeometry, TubeGeometry, Vector3 } from 'three';
import type { BufferGeometry, Material } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { carbonMaps, liveryTexture, sidewallTexture } from '../scene/textures.js';
import type { F1Car } from './F1Car.js';
import { arm, loft, plate, rimGeometry, treadGeometry, wing } from './shapes.js';
import type { Section } from './shapes.js';
import { SPECIFICATION } from './specification.js';

// A Formula 1 car: the real car's proportions and parts, its bodywork lofted smooth through
// cross-sections, its wings of airfoil sections, in a livery of the site's sea blues. Its frame
// is the body's: x to the left, y up, z forward, the origin at the centre of mass, the ground at
// y = −centerOfMassHeight.

const GROUND = -SPECIFICATION.centerOfMassHeight;

const BASE = '#0f3f78';
const ACCENT = '#1fa39a';
// the sky is bright, and curved bodywork meets it at a glancing angle from everywhere: reflecting
// as much of it as a glossy coat does, the paint washes out pale, so it reflects only a little
const glossy = { roughness: 0.42, metalness: 0.05, specularIntensity: 0.35, clearcoat: 0.15, clearcoatRoughness: 0.3, envMapIntensity: 0.3 };
const paint = new MeshPhysicalMaterial({ color: BASE, ...glossy });
const accent = new MeshPhysicalMaterial({ color: ACCENT, ...glossy });
const livery = new MeshPhysicalMaterial({ map: liveryTexture(BASE, ACCENT, '7'), ...glossy });
const carbonWeave = carbonMaps();
for (const map of [carbonWeave.map, carbonWeave.normalMap, carbonWeave.roughnessMap]) map.repeat.set(6, 6);
const carbon = new MeshPhysicalMaterial({ ...carbonWeave, metalness: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.2 });
const rubber = new MeshStandardMaterial({ color: 0x141416, roughness: 0.92 });
/** The sidewall, its soft compound's red band and the maker's name, for both faces of each tyre. */
const sidewall = new MeshStandardMaterial({ map: sidewallTexture('#d8312f'), roughness: 0.85 });
const rim = new MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.3, metalness: 0.8, side: DoubleSide });
const helmet = new MeshPhysicalMaterial({ color: 0xf4f1e8, roughness: 0.2, clearcoat: 1 });
const visor = new MeshPhysicalMaterial({ color: 0x101418, roughness: 0.05, metalness: 0.6, clearcoat: 1 });
const inlet = new MeshStandardMaterial({ color: 0x08090b, roughness: 0.9 });
/** How hot a brake disc glows from, and at its brightest, in °C: carbon brakes run at 400–1000. */
const GLOW_FROM = 550;
const GLOW_FULL = 950;
/** How fast a disc heats, in °C a second for each kilowatt it takes, and cools toward the air's temperature, a share a second. */
const HEATING = 0.72;
const COOLING = 0.35;
const AIR = 30;

/** A mesh `across` the car (to its left), `up` off the ground and `along` it, pitched by `pitch`. */
function part(geometry: BufferGeometry, material: Material | Material[], across: number, up: number, along: number, pitch = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(across, GROUND + up, along);
  mesh.rotation.x = pitch;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * One wheel: the steering turns `steer` about the strut, the tyre and rim spin in `spin` about
 * the axle, and the brake disc inside glows as it heats.
 */
class WheelModel {
  readonly steer = new Group();
  readonly spin = new Group();
  /** The disc's temperature, in °C. */
  discTemperature = AIR;
  private readonly glow: MeshStandardMaterial;

  constructor(width: number) {
    const radius = SPECIFICATION.wheel.radius;
    const half = width / 2;
    // the tread, its shoulders rounded, and the sidewall on each face, its compound's band on it
    const tread = new Mesh(treadGeometry(radius, width, 0.06), rubber);
    const sidewallRing = new RingGeometry(radius * 0.66, radius - 0.06 + 0.004, 96, 1);
    const outer = new Mesh(sidewallRing, sidewall);
    outer.rotation.y = Math.PI / 2;
    outer.position.x = half;
    const inner = new Mesh(sidewallRing, sidewall);
    inner.rotation.y = -Math.PI / 2;
    inner.position.x = -half;
    const wheelRim = new Mesh(rimGeometry(radius * 0.66, width * 0.98), rim);
    this.glow = new MeshStandardMaterial({ color: 0x3a3a3c, emissive: new Color(0xff5a1a), emissiveIntensity: 0, roughness: 0.6, metalness: 0.4 });
    const disc = new Mesh(new CylinderGeometry(radius * 0.5, radius * 0.5, width * 0.4, 48), this.glow);
    disc.rotation.z = Math.PI / 2;
    this.spin.add(tread, outer, inner, wheelRim, disc);
    // spokes, so that the spin shows, and the hub's nut
    for (let spoke = 0; spoke < 5; spoke++) {
      const arm = new Mesh(new RoundedBoxGeometry(width * 1.02, 0.035, radius * 1.2, 2, 0.012), carbon);
      arm.rotation.x = (spoke * Math.PI) / 5;
      this.spin.add(arm);
    }
    const nut = new Mesh(new CylinderGeometry(0.05, 0.05, width * 1.08, 6), rim);
    nut.rotation.z = Math.PI / 2;
    this.spin.add(nut);
    for (const mesh of this.spin.children) mesh.castShadow = true;
    this.steer.add(this.spin);
  }

  /** Heats the disc by the power its brake takes (torque times spin, in watts), cools it toward the air, and lights it. */
  heat(brakePower: number, frameDelta: number): void {
    this.discTemperature += ((brakePower / 1000) * HEATING - (this.discTemperature - AIR) * COOLING) * frameDelta;
    const glowing = Math.min(Math.max((this.discTemperature - GLOW_FROM) / (GLOW_FULL - GLOW_FROM), 0), 1);
    this.glow.emissiveIntensity = glowing * glowing * 3;
  }
}

/** A soft dark patch under the car, where the sky's light can't reach: its shadow from above, always there. */
function contactShadow(): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.6)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const shadow = new Mesh(new PlaneGeometry(2.6, 6.2), new MeshBasicMaterial({ map: new CanvasTexture(canvas), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, GROUND + 0.02, 0.2);
  shadow.renderOrder = 1;
  return shadow;
}

/** The floor, a flat slab with rounded edges, narrowing at the front. */
const FLOOR: Section[] = [
  { z: 2.05, y: 0.06, width: 0.6, height: 0.035, squareness: 8 },
  { z: 1.4, y: 0.06, width: 1.42, height: 0.04, squareness: 8 },
  { z: -1.6, y: 0.06, width: 1.45, height: 0.04, squareness: 8 },
  { z: -1.85, y: 0.06, width: 1.1, height: 0.04, squareness: 8 },
];

/** From the nose's tip back to the cockpit's rear, where the engine cover takes over. */
const NOSE_AND_TUB: Section[] = [
  { z: 2.82, y: 0.21, width: 0.14, height: 0.07, squareness: 2.5 },
  { z: 2.45, y: 0.25, width: 0.26, height: 0.15 },
  { z: 1.9, y: 0.31, width: 0.38, height: 0.25 },
  { z: 1.25, y: 0.38, width: 0.52, height: 0.38 },
  { z: 0.75, y: 0.42, width: 0.66, height: 0.45 },
  { z: 0.2, y: 0.43, width: 0.74, height: 0.48 },
  { z: -0.2, y: 0.44, width: 0.74, height: 0.5 },
];

/** From the cockpit's rear, over the engine, down to the gearbox. */
const ENGINE_COVER: Section[] = [
  { z: -0.2, y: 0.44, width: 0.74, height: 0.5 },
  { z: -0.75, y: 0.47, width: 0.66, height: 0.56 },
  { z: -1.35, y: 0.44, width: 0.48, height: 0.46 },
  { z: -1.9, y: 0.34, width: 0.26, height: 0.26 },
  { z: -2.2, y: 0.3, width: 0.18, height: 0.18 },
];

/** The airbox, its mouth over the driver's head, its spine running back and down into the engine cover. */
const AIRBOX: Section[] = [
  { z: 0.02, y: 0.86, width: 0.24, height: 0.24, squareness: 2.6 },
  { z: -0.2, y: 0.86, width: 0.3, height: 0.3 },
  { z: -0.6, y: 0.78, width: 0.26, height: 0.24 },
  { z: -1.1, y: 0.68, width: 0.1, height: 0.12 },
  { z: -1.5, y: 0.6, width: 0.04, height: 0.06 },
];

/** The shark fin down the engine cover: (z, y) round its outline. */
const FIN: [number, number][] = [
  [-0.55, 0.86],
  [-0.9, 0.98],
  [-1.9, 0.98],
  [-2.05, 0.86],
  [-1.6, 0.62],
  [-0.9, 0.7],
];

/** A sidepod on `side` (+1 left), from its inlet back, undercut below and sweeping in. */
function sidepod(side: number): Section[] {
  return [
    { x: side * 0.56, z: 1.0, y: 0.36, width: 0.44, height: 0.3, squareness: 3.2, bottomWidth: 0.85 },
    { x: side * 0.57, z: 0.7, y: 0.34, width: 0.5, height: 0.4, bottomWidth: 0.7 },
    { x: side * 0.55, z: 0.0, y: 0.33, width: 0.48, height: 0.42, bottomWidth: 0.55 },
    { x: side * 0.48, z: -0.8, y: 0.28, width: 0.38, height: 0.32, bottomWidth: 0.5 },
    { x: side * 0.36, z: -1.45, y: 0.22, width: 0.2, height: 0.18, bottomWidth: 0.6 },
  ];
}

/** A mirror's housing on `side`, its glass at the back. */
function mirror(side: number): Section[] {
  return [
    { x: side * 0.45, z: 0.8, y: 0.72, width: 0.05, height: 0.03, squareness: 2.4 },
    { x: side * 0.45, z: 0.74, y: 0.72, width: 0.14, height: 0.07 },
    { x: side * 0.45, z: 0.68, y: 0.72, width: 0.15, height: 0.075 },
  ];
}

/** The front wing's endplate: (z, y) round its outline. */
const FRONT_ENDPLATE: [number, number][] = [
  [3.05, 0.06],
  [3.04, 0.2],
  [2.82, 0.27],
  [2.55, 0.25],
  [2.5, 0.06],
];

/** The rear wing's endplate, its top curving down at the front. */
const REAR_ENDPLATE: [number, number][] = [
  [-2.0, 0.6],
  [-1.98, 0.88],
  [-2.1, 1.02],
  [-2.62, 1.04],
  [-2.64, 0.56],
];

/** The pylon holding the rear wing up from the gearbox. */
const PYLON: [number, number][] = [
  [-2.0, 0.3],
  [-2.1, 0.8],
  [-2.3, 0.8],
  [-2.25, 0.3],
];

/** The diffuser, sweeping up behind the rear axle. */
const DIFFUSER: Section[] = [
  { z: -1.8, y: 0.07, width: 1.05, height: 0.04, squareness: 8 },
  { z: -2.15, y: 0.14, width: 1.02, height: 0.035, squareness: 8 },
  { z: -2.45, y: 0.26, width: 0.98, height: 0.03, squareness: 8 },
];

/** A strake inside the diffuser. */
const DIFFUSER_STRAKE: [number, number][] = [
  [-1.75, 0.07],
  [-2.45, 0.26],
  [-2.45, 0.12],
  [-1.95, 0.05],
];

/**
 * The car's meshes: give `root` to the car's body to move, and call `update` each frame to set
 * the wheels where the suspension holds them, steered and spinning, and the rear wing's flap.
 */
export class CarModel {
  readonly root = new Group();
  private readonly wheels: WheelModel[] = [];
  private readonly drsFlap = new Group();
  private flapAngle = 0;

  constructor() {
    const frontAxle = SPECIFICATION.wheelbase * (1 - SPECIFICATION.frontWeightShare);
    const rearAxle = -SPECIFICATION.wheelbase * SPECIFICATION.frontWeightShare;
    const body = this.root;

    body.add(contactShadow());
    // the floor, its edges rounded, and the plank under it
    body.add(part(loft(FLOOR, { around: 32, between: 4 }), carbon, 0, 0, 0));

    // the tub and the nose, one smooth shape from the nose's tip back to the cockpit
    body.add(part(loft(NOSE_AND_TUB), [paint, accent], 0, 0, 0));
    // the engine cover behind, in the livery, narrowing down to the gearbox
    body.add(part(loft(ENGINE_COVER, { mapping: 'side' }), [livery, carbon], 0, 0, 0));
    // the airbox over the driver's head, its spine running back along the engine cover, and the fin
    body.add(part(loft(AIRBOX), [accent, inlet], 0, 0, 0));
    body.add(part(plate(FIN, 0.018), paint, 0, 0, 0));
    for (const side of [1, -1]) {
      // the sidepods, undercut below, their inlets dark
      body.add(part(loft(sidepod(side)), [paint, inlet], 0, 0, 0));
      // the mirrors on their stalks
      body.add(part(loft(mirror(side), { around: 24, between: 4 }), [paint, visor], 0, 0, 0));
      body.add(arm(new Vector3(side * 0.3, GROUND + 0.62, 0.78), new Vector3(side * 0.43, GROUND + 0.71, 0.72), 0.04, 0.012, carbon));
    }

    // the front wing: a main plane, two flaps rising outboard, endplates; and the nose's pillars down to it
    body.add(part(wing(1.9, 0.42, 0.1, 0.05, 0.04), carbon, 0, 0.08, 3.02));
    for (const side of [1, -1]) {
      body.add(part(wing(0.66, 0.22, 0.1, 0.07, 0.3), accent, side * 0.6, 0.14, 2.84));
      body.add(part(wing(0.6, 0.18, 0.1, 0.07, 0.55), paint, side * 0.63, 0.2, 2.72));
      body.add(part(plate(FRONT_ENDPLATE, 0.02), carbon, side * 0.95, 0, 0));
      body.add(arm(new Vector3(side * 0.08, GROUND + 0.24, 2.72), new Vector3(side * 0.12, GROUND + 0.1, 2.78), 0.1, 0.014, carbon));
    }

    // the driver's helmet, its visor, and the halo over the cockpit on its pillar
    body.add(part(new SphereGeometry(0.135, 48, 32), helmet, 0, 0.73, 0.2));
    const visorBand = new Mesh(new SphereGeometry(0.137, 48, 8, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.4, Math.PI * 0.16), visor);
    visorBand.position.set(0, GROUND + 0.73, 0.2);
    body.add(visorBand);
    const haloCurve = new CatmullRomCurve3([new Vector3(0.3, 0.64, -0.05), new Vector3(0.27, 0.82, 0.15), new Vector3(0, 0.86, 0.45), new Vector3(-0.27, 0.82, 0.15), new Vector3(-0.3, 0.64, -0.05)]);
    const halo = new Mesh(new TubeGeometry(haloCurve, 96, 0.03, 16), carbon);
    halo.position.y = GROUND;
    halo.castShadow = true;
    body.add(halo, arm(new Vector3(0, GROUND + 0.66, 0.58), new Vector3(0, GROUND + 0.86, 0.46), 0.07, 0.03, carbon));

    // the rear wing: endplates, main plane, the DRS flap that opens above it, the pylon under it
    for (const side of [1, -1]) body.add(part(plate(REAR_ENDPLATE, 0.02), carbon, side * 0.48, 0, 0));
    body.add(part(wing(0.95, 0.34, 0.12, 0.08, 0.1), paint, 0, 0.78, -2.15));
    // hinged at its leading edge, so that it swings up and back
    const flap = new Mesh(wing(0.95, 0.2, 0.1, 0.06, 0.35), accent);
    flap.castShadow = true;
    this.drsFlap.position.set(0, GROUND + 0.88, -2.25);
    this.drsFlap.add(flap);
    body.add(this.drsFlap, part(plate(PYLON, 0.04), carbon, 0, 0, 0));
    // the diffuser, rising behind the rear axle, its strakes dividing it
    body.add(part(loft(DIFFUSER, { around: 32, between: 4 }), carbon, 0, 0, 0));
    for (const across of [-0.35, -0.12, 0.12, 0.35]) body.add(part(plate(DIFFUSER_STRAKE, 0.012), carbon, across, 0, 0));

    // the wheels, the suspension's arms out to them
    const wheelSpots = [
      { x: SPECIFICATION.frontTrack / 2, z: frontAxle, width: 0.3 },
      { x: -SPECIFICATION.frontTrack / 2, z: frontAxle, width: 0.3 },
      { x: SPECIFICATION.rearTrack / 2, z: rearAxle, width: 0.4 },
      { x: -SPECIFICATION.rearTrack / 2, z: rearAxle, width: 0.4 },
    ];
    for (const spot of wheelSpots) {
      const wheel = new WheelModel(spot.width);
      wheel.steer.position.set(spot.x, GROUND + SPECIFICATION.wheel.radius, spot.z);
      this.wheels.push(wheel);
      body.add(wheel.steer);
      // wishbones above and below, each from two points on the chassis to the upright, and the push rod
      const side = Math.sign(spot.x);
      const upright = Math.abs(spot.x) - spot.width / 2 - 0.04;
      for (const height of [0.22, 0.46]) {
        const outer = new Vector3(side * upright, GROUND + height, spot.z);
        for (const fore of [0.22, -0.22]) body.add(arm(new Vector3(side * 0.36, GROUND + height + 0.04, spot.z + fore), outer, 0.035, 0.016, carbon));
      }
      body.add(arm(new Vector3(side * upright, GROUND + 0.24, spot.z - 0.02), new Vector3(side * 0.3, GROUND + 0.58, spot.z - 0.1), 0.03, 0.02, carbon));
    }
  }

  update(car: F1Car, frameDelta: number): void {
    car.vehicle.wheels.forEach((wheel, index) => {
      const model = this.wheels[index]!;
      model.steer.position.y = wheel.mount.y - (wheel.suspensionLength - wheel.compression);
      model.steer.rotation.y = wheel.steerAngle;
      model.spin.rotation.x = wheel.spinAngle;
      model.heat(wheel.brakeTorque * Math.abs(wheel.spinSpeed), frameDelta);
    });
    // the flap swings open, as the real one does, in a tenth of a second or so
    const target = car.aerodynamics.drsOpen ? 0.75 : 0;
    this.flapAngle += (target - this.flapAngle) * Math.min(frameDelta * 15, 1);
    this.drsFlap.rotation.x = this.flapAngle;
  }
}
