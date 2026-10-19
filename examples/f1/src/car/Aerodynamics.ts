import { Vector3 } from 'three';
import type { Behavior, Body } from '@eulerjs/core';
import { SPECIFICATION } from './specification.js';

const { aerodynamics } = SPECIFICATION;

const forward = new Vector3();
const down = new Vector3();
const drag = new Vector3();
const press = new Vector3();
const axle = new Vector3();

/**
 * The air on the car: downforce growing with the square of its speed, shared between the axles
 * where the wings are, and drag against its way through the air. DRS opens the rear wing's flap,
 * shedding drag and some of the rear downforce.
 */
export class Aerodynamics implements Behavior {
  /** Whether DRS is open. */
  drsOpen = false;
  /** The downforce and drag on the last step, in newtons. */
  downforce = 0;
  drag = 0;
  private readonly frontAxle: Vector3;
  private readonly rearAxle: Vector3;

  /** `frontAxle` and `rearAxle`: where the axles cross the car's centre line, in the body's frame. */
  constructor(frontAxle: Vector3, rearAxle: Vector3) {
    this.frontAxle = frontAxle.clone();
    this.rearAxle = rearAxle.clone();
  }

  fixedUpdate(body: Body): void {
    body.directionToWorld(forward.set(0, 0, 1));
    body.directionToWorld(down.set(0, -1, 0));
    const speed = body.velocity.dot(forward);
    const dynamicPressure = 0.5 * aerodynamics.airDensity * speed * speed;
    const front = dynamicPressure * aerodynamics.downforceArea * aerodynamics.frontShare;
    const rear = dynamicPressure * aerodynamics.downforceArea * (1 - aerodynamics.frontShare) * (this.drsOpen ? 1 - aerodynamics.drsRearDownforceCut : 1);
    body.applyForce(press.copy(down).multiplyScalar(front), body.pointToWorld(axle.copy(this.frontAxle)));
    body.applyForce(press.copy(down).multiplyScalar(rear), body.pointToWorld(axle.copy(this.rearAxle)));
    this.downforce = front + rear;

    // against the car's way through the air, at its centre of mass
    const airSpeed = body.velocity.length();
    this.drag = 0.5 * aerodynamics.airDensity * airSpeed * airSpeed * aerodynamics.dragArea * (this.drsOpen ? 1 - aerodynamics.drsDragCut : 1);
    if (airSpeed > 1e-6) body.applyForce(drag.copy(body.velocity).multiplyScalar(-this.drag / airSpeed));
  }
}
