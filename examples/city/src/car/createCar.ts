import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SpotLight } from 'three';
import type { Object3D, Quaternion, Scene, Vector3 } from 'three';
import type { Body, World } from '@eulerjs/core';
import { CarControls } from './CarControls.js';
import { CAR_LAYOUT } from './carLayout.js';
import { createCarPhysics } from './createCarPhysics.js';
import type { Vehicle } from './Vehicle.js';

export interface Car {
  readonly body: Body;
  readonly vehicle: Vehicle;
  /** The drawn car, bound to the body; the camera follows it. */
  readonly object: Object3D;
  /** Reads the keys into the vehicle and turns the wheels to match it. */
  update(frameDelta: number): void;
  dispose(): void;
}

export interface CarOptions {
  world: World;
  scene: Scene;
  position?: Vector3 | undefined;
  quaternion?: Quaternion | undefined;
}

const paint = new MeshStandardMaterial({ color: 0xc8352b, roughness: 0.35, metalness: 0.3 });
const glass = new MeshStandardMaterial({ color: 0x1d2730, roughness: 0.1, metalness: 0.6 });
const tyre = new MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 });
const hubcap = new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.4, metalness: 0.8 });
const headlamp = new MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 1.5 });
const taillamp = new MeshStandardMaterial({ color: 0x7a0a0a, emissive: 0xff2010, emissiveIntensity: 0.8 });

export function createCar(options: CarOptions): Car {
  const layout = CAR_LAYOUT;
  const object = new Group();
  const physics = createCarPhysics({ world: options.world, object, position: options.position, quaternion: options.quaternion });

  object.add(shadedMesh(new BoxGeometry(layout.chassisSize.x, layout.chassisSize.y, layout.chassisSize.z), paint));
  const cabin = shadedMesh(new BoxGeometry(layout.cabin.size.x, layout.cabin.size.y, layout.cabin.size.z), glass);
  cabin.position.copy(layout.cabin.center);
  object.add(cabin);
  addLamps(object);

  const wheelGeometry = new CylinderGeometry(layout.wheelRadius, layout.wheelRadius, 0.22, 24).rotateZ(Math.PI / 2);
  const hubGeometry = new CylinderGeometry(layout.wheelRadius * 0.55, layout.wheelRadius * 0.55, 0.23, 12).rotateZ(Math.PI / 2);
  const wheels = layout.wheels.map((wheel) => {
    // the strut turns for steering; the wheel spins on it
    const strut = new Group();
    const spinning = shadedMesh(wheelGeometry, tyre);
    spinning.add(new Mesh(hubGeometry, hubcap));
    strut.add(spinning);
    object.add(strut);
    return { mount: wheel.mount, strut, spinning };
  });

  options.scene.add(object);
  physics.body.syncObject();
  const controls = new CarControls(physics.body, physics.vehicle, window);

  return {
    body: physics.body,
    vehicle: physics.vehicle,
    object,
    update(frameDelta: number): void {
      controls.update(frameDelta);
      physics.vehicle.wheels.forEach((state, index) => {
        const { mount, strut, spinning } = wheels[index]!;
        strut.position.set(mount.x, mount.y - layout.suspensionLength + state.compression, mount.z);
        strut.rotation.y = state.steerAngle;
        spinning.rotation.x = state.spinAngle;
      });
    },
    dispose(): void {
      controls.dispose();
      options.world.removeBody(physics.body);
      options.scene.remove(object);
    },
  };
}

function shadedMesh(geometry: BoxGeometry | CylinderGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Headlamps and tail lamps on the chassis corners, and a beam ahead for the dark streets between the towers. */
function addLamps(object: Object3D): void {
  const { chassisSize } = CAR_LAYOUT;
  const lampGeometry = new BoxGeometry(0.35, 0.14, 0.05);
  for (const side of [-1, 1]) {
    const front = new Mesh(lampGeometry, headlamp);
    front.position.set(side * 0.58, 0.12, chassisSize.z / 2 + 0.01);
    const rear = new Mesh(lampGeometry, taillamp);
    rear.position.set(side * 0.62, 0.15, -chassisSize.z / 2 - 0.01);
    object.add(front, rear);
  }
  const beam = new SpotLight(0xfff2d0, 30, 45, Math.PI / 5, 0.5, 1.5);
  beam.position.set(0, 0.2, chassisSize.z / 2);
  beam.target.position.set(0, -1, chassisSize.z / 2 + 12);
  object.add(beam, beam.target);
}
