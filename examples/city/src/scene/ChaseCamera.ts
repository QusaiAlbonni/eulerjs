import { Vector3 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';

/** Behind and above the car, in the car's frame, and how far ahead of it the camera looks. */
const CHASE_OFFSET = new Vector3(0, 3.2, -8);
const LOOK_AHEAD = 4;
/** High above the car, looking down, for the overhead view. */
const OVERHEAD_OFFSET = new Vector3(0, 45, -12);
/** How quickly the camera catches up with where it should be, per second. */
const FOLLOW_RATE = 5;

const desired = new Vector3();
const lookAt = new Vector3();
const forward = new Vector3();

/** A camera that follows the car round corners, from behind or from overhead (V switches). */
export class ChaseCamera {
  private overhead = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly target: Object3D,
  ) {
    this.update(1);
  }

  toggleView(): void {
    this.overhead = !this.overhead;
  }

  update(frameDelta: number): void {
    // follow the heading only, so the camera doesn't roll and pitch with the body
    forward.set(0, 0, 1).applyQuaternion(this.target.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
    forward.normalize();
    const offset = this.overhead ? OVERHEAD_OFFSET : CHASE_OFFSET;
    desired.copy(this.target.position).addScaledVector(forward, offset.z).setY(this.target.position.y + offset.y);
    const catchUp = 1 - Math.exp(-FOLLOW_RATE * frameDelta);
    this.camera.position.lerp(desired, catchUp);
    lookAt.copy(this.target.position).addScaledVector(forward, LOOK_AHEAD);
    this.camera.lookAt(lookAt);
  }
}
