import { MathUtils, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SPECIFICATION } from '../car/specification.js';

/**
 * The views to cycle through: behind the car, the T-cam over the airbox, and the driver's eyes;
 * and, on its own key, inspecting the car: walking round it with the mouse.
 */
export type CameraMode = 'chase' | 'tcam' | 'cockpit' | 'inspect';
const MODES: readonly CameraMode[] = ['chase', 'tcam', 'cockpit'];

/** Each view's field of view at a standstill, in degrees, and the few more it widens to flat out: a touch, not a stretch. */
const FIELD_OF_VIEW: Record<CameraMode, { still: number; flatOut: number }> = {
  chase: { still: 58, flatOut: 63 },
  tcam: { still: 64, flatOut: 68 },
  cockpit: { still: 68, flatOut: 71 },
  inspect: { still: 40, flatOut: 40 },
};
/** The speed the field of view has widened fully at, in m/s: about 330 km/h. */
const FLAT_OUT = 92;
/**
 * How the views answer the car's acceleration, as a driver's head does: a spring, its natural
 * frequency in hertz and its damping ratio, lightly damped so that a shift's kick sets it nodding.
 * Braking pushes the other way, at its share, and both are held to a few g.
 */
const PUSH = { frequency: 3.2, damping: 0.4, braking: 0.4, most: 2.5 };
/** How far the chase view drops back, in metres, and the onboard views tip back, in radians and metres, for each g of push. */
const CHASE_PUSH = 0.22;
const HEAD_TILT = 0.014;
const HEAD_PUSH = 0.025;

const GROUND = -SPECIFICATION.centerOfMassHeight;
/** Where the fixed views sit, in the car's frame, and a point they look toward. */
export const MOUNTS: Record<'tcam' | 'cockpit', { eye: Vector3; lookAt: Vector3 }> = {
  tcam: { eye: new Vector3(0, GROUND + 1.18, -0.25), lookAt: new Vector3(0, GROUND + 0.9, 8) },
  cockpit: { eye: new Vector3(0, GROUND + 0.8, 0.4), lookAt: new Vector3(0, GROUND + 0.6, 10) },
};

/** Where inspecting starts from, in the car's frame: ahead of it and off to its left, a little above. */
const INSPECTION_START = new Vector3(3.4, 1.3, 4.4);
/** How near and far the view may come to the car's centre when inspecting it, in metres. */
const INSPECTION_RANGE = { nearest: 1.6, furthest: 16 };

const ahead = new Vector3();
const carMoved = new Vector3();
const backward = new Vector3();
const wanted = new Vector3();
const forward = new Vector3();
const eye = new Vector3();
const focus = new Vector3();

/**
 * The camera's work. The chase view hangs behind and above the car, swinging round after it
 * with a little lag, so that the car turns in the frame through a corner and the camera catches
 * up; it keeps up with the car's speed, though, rather than dropping back. The fixed views ride
 * with the car. Each widens its field of view a few degrees with speed.
 */
export class Cameras {
  mode: CameraMode = 'chase';
  private readonly camera: PerspectiveCamera;
  private readonly car: Object3D;
  /** Where the chase view is, and looks, from the car. */
  private readonly chaseOffset = new Vector3();
  private readonly chaseLookOffset = new Vector3();
  private settled = false;
  private fieldOfView = FIELD_OF_VIEW.chase.still;
  /** The push the view feels, in g, and how fast it changes, following the car's acceleration through the spring. */
  private push = 0;
  private pushRate = 0;
  private lastSpeed: number | undefined;
  /** Inspecting: the mouse's orbit round the car, the view to go back to, and where the car was last frame, to follow it. */
  private readonly orbit: OrbitControls;
  private drivingMode: CameraMode = 'chase';
  private readonly lastCarPosition = new Vector3();

  /** `canvas`: what the mouse drags on to look round the car when inspecting it; without one, the inspecting view stays where it starts. */
  constructor(camera: PerspectiveCamera, car: Object3D, canvas?: HTMLElement) {
    this.camera = camera;
    this.car = car;
    this.orbit = new OrbitControls(camera, canvas ?? null);
    this.orbit.enabled = false;
    this.orbit.enableDamping = true;
    // round the car, not off along the track: no panning, and never below the ground
    this.orbit.enablePan = false;
    this.orbit.minDistance = INSPECTION_RANGE.nearest;
    this.orbit.maxDistance = INSPECTION_RANGE.furthest;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
  }

  /** The next of the driving views; from inspecting, back to the one before it. */
  next(): void {
    if (this.mode === 'inspect') {
      this.inspect();
      return;
    }
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    this.settled = false;
  }

  /** Starts inspecting the car, the view orbiting it as the mouse drags and zooming with the wheel; or, inspecting, stops. */
  inspect(): void {
    if (this.mode === 'inspect') {
      this.mode = this.drivingMode;
      this.orbit.enabled = false;
      this.settled = false;
      return;
    }
    this.drivingMode = this.mode;
    this.mode = 'inspect';
    this.orbit.enabled = true;
    // from ahead and to the side, level however the car pitches and rolls
    forward.set(0, 0, 1).applyQuaternion(this.car.quaternion).setY(0).normalize();
    const heading = Math.atan2(forward.x, forward.z);
    this.camera.position.copy(INSPECTION_START).applyAxisAngle(new Vector3(0, 1, 0), heading).add(this.car.position);
    this.camera.up.set(0, 1, 0);
    this.orbit.target.copy(this.car.position);
    this.lastCarPosition.copy(this.car.position);
    this.orbit.update();
  }

  update(frameDelta: number, speed: number): void {
    const car = this.car;
    this.feelAcceleration(frameDelta, speed);
    // forward along the car, level, and the push's share of a drop back along it
    backward.set(0, 0, -1).applyQuaternion(car.quaternion).setY(0).normalize();
    if (this.mode === 'inspect') {
      // the view goes along with the car, so that it can be driven and looked at together
      carMoved.subVectors(car.position, this.lastCarPosition);
      this.lastCarPosition.copy(car.position);
      this.camera.position.add(carMoved);
      this.orbit.target.add(carMoved);
      this.orbit.update(frameDelta);
    } else if (this.mode === 'chase') {
      // behind the car along where it points, level however it pitches and rolls
      forward.set(0, 0, 1).applyQuaternion(car.quaternion).setY(0).normalize();
      wanted.copy(forward).multiplyScalar(-6.2).setY(1.55);
      ahead.copy(forward).multiplyScalar(7).setY(0.55);
      if (!this.settled) {
        this.chaseOffset.copy(wanted);
        this.chaseLookOffset.copy(ahead);
        this.settled = true;
      }
      // swinging round toward where it should be, the look ahead leading the way
      this.chaseOffset.lerp(wanted, 1 - Math.exp(-frameDelta * 5));
      this.chaseLookOffset.lerp(ahead, 1 - Math.exp(-frameDelta * 9));
      this.camera.position.copy(car.position).add(this.chaseOffset).addScaledVector(backward, CHASE_PUSH * this.push);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(focus.copy(car.position).add(this.chaseLookOffset));
    } else {
      const mount = MOUNTS[this.mode];
      // the head pressed back and tipped up as the car pulls, thrown forward as it brakes
      eye.copy(mount.eye);
      eye.z -= HEAD_PUSH * this.push;
      focus.copy(mount.lookAt);
      focus.y += HEAD_TILT * this.push * (mount.lookAt.z - mount.eye.z);
      eye.applyQuaternion(car.quaternion).add(car.position);
      focus.applyQuaternion(car.quaternion).add(car.position);
      this.camera.position.copy(eye);
      // pitching and rolling with the car, as a camera bolted to it does
      this.camera.up.set(0, 1, 0).applyQuaternion(car.quaternion);
      this.camera.lookAt(focus);
    }
    const limits = FIELD_OF_VIEW[this.mode];
    const target = MathUtils.lerp(limits.still, limits.flatOut, MathUtils.smoothstep(Math.abs(speed), 0, FLAT_OUT));
    this.fieldOfView += (target - this.fieldOfView) * (1 - Math.exp(-frameDelta * 3));
    if (Math.abs(this.camera.fov - this.fieldOfView) > 0.01) {
      this.camera.fov = this.fieldOfView;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The push the views feel: the car's acceleration along itself, in g, through a lightly damped spring. */
  private feelAcceleration(frameDelta: number, speed: number): void {
    if (frameDelta <= 0) return;
    const acceleration = this.lastSpeed === undefined ? 0 : (speed - this.lastSpeed) / frameDelta / 9.81;
    this.lastSpeed = speed;
    const felt = Math.min(Math.max(acceleration < 0 ? acceleration * PUSH.braking : acceleration, -PUSH.most), PUSH.most);
    const angular = 2 * Math.PI * PUSH.frequency;
    // stepped in small pieces, so that a slow frame doesn't throw it
    const pieces = Math.ceil(frameDelta / 0.004);
    const piece = frameDelta / pieces;
    for (let step = 0; step < pieces; step++) {
      this.pushRate += (angular * angular * (felt - this.push) - 2 * PUSH.damping * angular * this.pushRate) * piece;
      this.push += this.pushRate * piece;
    }
  }
}
