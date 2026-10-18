import { Euler, MathUtils, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';
import type { Ocean, WaveSurface } from '@eulerjs/marine';

export type CameraMode = 'follow' | 'free';

export interface CameraRigOptions {
  camera: PerspectiveCamera;
  /** What the follow camera orbits, normally the boat. */
  target: Object3D;
  /** Keeps the follow camera above the waves. */
  ocean: Ocean<WaveSurface>;
  /** Element that receives drags and scrolls, normally the renderer's canvas. */
  domElement: HTMLElement;
}

const ORBIT = {
  startDistance: 22,
  minimumDistance: 6,
  maximumDistance: 120,
  startPitch: 0.3,
  minimumPitch: -0.2,
  maximumPitch: 1.45,
  /** How high above the target's origin the camera aims, in metres. */
  aimHeight: 2,
  /** How close to the water surface the camera may go, in metres. */
  waterClearance: 1,
  /** Rate (1/s) at which the aim point catches up with the target vertically; horizontally it follows exactly. */
  verticalFollowRate: 4,
  zoomPerScrollUnit: 0.001,
};
const FREE_FLIGHT = { speed: 30, maximumPitch: 1.5 };
const RADIANS_PER_PIXEL = 0.005;
/** Longest frame the smoothing accounts for, so a stalled tab doesn't make the camera jump. */
const MAXIMUM_FRAME_DELTA = 0.1;

const orbitOffset = new Vector3();
const forward = new Vector3();
const right = new Vector3();
const lookAngles = new Euler(0, 0, 0, 'YXZ');

/**
 * Two cameras in one. "follow" orbits the target: drag to look around, scroll to zoom. "free"
 * flies anywhere: drag to look, arrow keys to move.
 */
export class CameraRig {
  private currentMode: CameraMode = 'follow';
  private orbitYaw = 0;
  private orbitPitch = ORBIT.startPitch;
  private orbitDistance = ORBIT.startDistance;
  private readonly aimPoint = new Vector3();
  private freeYaw = 0;
  private freePitch = 0;
  private dragging = false;
  private readonly heldKeys = new Set<string>();
  private readonly camera: PerspectiveCamera;
  private readonly target: Object3D;
  private readonly ocean: Ocean<WaveSurface>;
  private readonly domElement: HTMLElement;

  constructor(options: CameraRigOptions) {
    this.camera = options.camera;
    this.target = options.target;
    this.ocean = options.ocean;
    this.domElement = options.domElement;
    this.resetBehindTarget();
    this.aimPoint.copy(this.target.position);

    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: true });
    this.domElement.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  get mode(): CameraMode {
    return this.currentMode;
  }

  toggleMode(): void {
    if (this.currentMode === 'follow') {
      lookAngles.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.freeYaw = lookAngles.y;
      this.freePitch = lookAngles.x;
      this.currentMode = 'free';
    } else {
      this.resetBehindTarget();
      this.currentMode = 'follow';
    }
  }

  /** Swings the follow camera round behind the target. */
  resetBehindTarget(): void {
    this.target.getWorldDirection(forward);
    this.orbitYaw = Math.atan2(-forward.x, -forward.z);
  }

  /** `time` is the simulation time being rendered, used to find the water surface. */
  update(frameDelta: number, time: number): void {
    const delta = Math.min(frameDelta, MAXIMUM_FRAME_DELTA);
    if (this.currentMode === 'follow') this.updateFollow(delta, time);
    else this.updateFree(delta);
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  /** Follows the target's position but not its rotation, and smooths the vertical part so the view doesn't bob with every wave. */
  private updateFollow(delta: number, time: number): void {
    const aim = this.aimPoint;
    aim.x = this.target.position.x;
    aim.z = this.target.position.z;
    aim.y += (this.target.position.y + ORBIT.aimHeight - aim.y) * (1 - Math.exp(-ORBIT.verticalFollowRate * delta));

    const horizontalReach = Math.cos(this.orbitPitch);
    orbitOffset
      .set(Math.sin(this.orbitYaw) * horizontalReach, Math.sin(this.orbitPitch), Math.cos(this.orbitYaw) * horizontalReach)
      .multiplyScalar(this.orbitDistance);
    this.camera.position.copy(aim).add(orbitOffset);
    const waterHeight = this.ocean.surfaceHeight(this.camera.position.x, this.camera.position.z, time);
    this.camera.position.y = Math.max(this.camera.position.y, waterHeight + ORBIT.waterClearance);
    this.camera.lookAt(aim);
  }

  private updateFree(delta: number): void {
    lookAngles.set(this.freePitch, this.freeYaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(lookAngles);
    forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const distance = FREE_FLIGHT.speed * delta;
    if (this.heldKeys.has('ArrowUp')) this.camera.position.addScaledVector(forward, distance);
    if (this.heldKeys.has('ArrowDown')) this.camera.position.addScaledVector(forward, -distance);
    if (this.heldKeys.has('ArrowRight')) this.camera.position.addScaledVector(right, distance);
    if (this.heldKeys.has('ArrowLeft')) this.camera.position.addScaledVector(right, -distance);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button === 0 || event.button === 2) this.dragging = true;
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    if (this.currentMode === 'follow') {
      this.orbitYaw -= event.movementX * RADIANS_PER_PIXEL;
      this.orbitPitch = MathUtils.clamp(this.orbitPitch + event.movementY * RADIANS_PER_PIXEL, ORBIT.minimumPitch, ORBIT.maximumPitch);
    } else {
      this.freeYaw -= event.movementX * RADIANS_PER_PIXEL;
      this.freePitch = MathUtils.clamp(this.freePitch - event.movementY * RADIANS_PER_PIXEL, -FREE_FLIGHT.maximumPitch, FREE_FLIGHT.maximumPitch);
    }
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (this.currentMode !== 'follow') return;
    this.orbitDistance = MathUtils.clamp(
      this.orbitDistance * Math.exp(event.deltaY * ORBIT.zoomPerScrollUnit),
      ORBIT.minimumDistance,
      ORBIT.maximumDistance,
    );
  };

  private readonly onContextMenu = (event: Event) => event.preventDefault();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.code.startsWith('Arrow')) this.heldKeys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.heldKeys.delete(event.code);
  };
}
