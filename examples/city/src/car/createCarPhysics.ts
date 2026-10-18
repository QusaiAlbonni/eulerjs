import { Vector3 } from 'three';
import type { Object3D, Quaternion } from 'three';
import { Body, BoxCollider, MassProperties } from '@eulerjs/core';
import type { World } from '@eulerjs/core';
import { CAR_LAYOUT } from './carLayout.js';
import type { CarLayout } from './carLayout.js';
import { Vehicle } from './Vehicle.js';

export interface CarPhysics {
  readonly body: Body;
  readonly vehicle: Vehicle;
}

export interface CarPhysicsOptions {
  world: World;
  /** Where the car stands; it is put on its wheels at the ride height. */
  position?: Vector3 | undefined;
  quaternion?: Quaternion | undefined;
  /** The three.js object the car's pose is written to. */
  object?: Object3D | undefined;
  layout?: CarLayout | undefined;
}

/** The car as eulerjs sees it: one body, the chassis, carried and driven by its wheels. Needs no browser. */
export function createCarPhysics(options: CarPhysicsOptions): CarPhysics {
  const layout = options.layout ?? CAR_LAYOUT;
  const chassisMass = layout.mass - layout.lowMass.mass;
  const massProperties = MassProperties.box(layout.chassisSize, chassisMass).combine(MassProperties.point(layout.lowMass.mass, layout.lowMass.position));
  const position = options.position?.clone() ?? new Vector3();
  position.y = rideHeight(layout);
  const body = options.world.addBody(
    new Body({
      massProperties,
      position,
      quaternion: options.quaternion,
      object: options.object,
      colliders: [new BoxCollider({ size: layout.chassisSize, friction: 0.4 })],
      // a parked car would fall asleep, and its wheels with it, waiting for a push
      canSleep: false,
    }),
  );
  const vehicle = body.addBehavior(new Vehicle(layout));
  return { body, vehicle };
}

/** Height of the chassis centre with the car's weight resting evenly on its springs. */
export function rideHeight(layout: CarLayout, gravity = 9.81): number {
  const compression = (layout.mass * gravity) / layout.wheels.length / layout.springStiffness;
  return -layout.wheels[0]!.mount.y + layout.suspensionLength - compression + layout.wheelRadius;
}
