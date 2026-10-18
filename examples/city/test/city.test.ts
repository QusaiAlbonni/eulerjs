import { Quaternion, Scene, Vector3 } from 'three';
import { Body, BoxCollider, PlaneCollider, World } from 'eulerjs';
import { describe, expect, it } from 'vitest';
import { createCarPhysics } from '../src/car/createCarPhysics.js';
import type { CarPhysics } from '../src/car/createCarPhysics.js';
import { BLOCK_PITCH, createCity } from '../src/city/createCity.js';
import type { City } from '../src/city/createCity.js';

/** The car loose in the city: crashing into buildings, through crates, cones and barrels. */

interface Drive extends CarPhysics {
  readonly world: World;
  readonly city: City;
}

function cityWithCar(position = new Vector3(), quaternion = new Quaternion()): Drive {
  const world = new World();
  const city = createCity(world, new Scene());
  return { world, city, ...createCarPhysics({ world, position, quaternion }) };
}

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    world.fixedStep();
    eachStep?.();
  }
}

const unitCorners = [-1, 1].flatMap((east) => [-1, 1].flatMap((up) => [-1, 1].map((north) => new Vector3(east, up, north))));

/** How deep the deepest corner of `body`'s box collider is inside the box collider of `obstacle`, or 0 if none is. */
function cornerDepthIn(body: Body, obstacle: Body): number {
  const own = body.colliders[0] as BoxCollider;
  const box = obstacle.colliders[0] as BoxCollider;
  let deepest = 0;
  for (const corner of unitCorners) {
    const local = obstacle.worldToLocal(body.localToWorld(corner.clone().multiply(own.halfExtents).add(own.offset))).sub(box.offset);
    deepest = Math.max(deepest, Math.min(box.halfExtents.x - Math.abs(local.x), box.halfExtents.y - Math.abs(local.y), box.halfExtents.z - Math.abs(local.z)));
  }
  return deepest;
}

const facingSouth = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
const upright = (body: Body) => body.directionToWorld(new Vector3(0, 1, 0)).y;

describe('a car in the city', () => {
  it('starts with everything at rest where it was put, nothing inside anything else', () => {
    const { world, city } = cityWithCar();
    const startingPlaces = city.props.map((prop) => prop.position.clone());
    runFor(world, 2);
    city.props.forEach((prop, index) => expect(prop.position.distanceTo(startingPlaces[index]!)).toBeLessThan(0.01));
    expect(city.props.every((prop) => prop.isSleeping)).toBe(true);
  });

  it('weaves down the slalom without touching a cone', () => {
    const { world, city, body, vehicle } = cityWithCar();
    const cones = city.props.filter((prop) => Math.abs(prop.position.x) < 2 && prop.position.z > 10 && prop.position.z < 80);
    expect(cones.length).toBe(8);
    vehicle.throttle = 1;
    runFor(world, 7);
    expect(body.position.z).toBeGreaterThan(80);
    expect(cones.every((cone) => cone.isSleeping)).toBe(true);
  });

  it('stops against a building it drives into, without going into it, and stays on its wheels', () => {
    // 20 m from the street-side face of the tower just south-east of the start, heading straight at it
    const nearStart = cityWithCar().city.buildings.filter((building) => building.position.x > 0 && building.position.x < BLOCK_PITCH && building.position.z < 0);
    const target = nearStart.reduce((nearest, building) => (building.position.z > nearest.position.z ? building : nearest));
    const northFace = target.position.z + (target.colliders[0] as BoxCollider).halfExtents.z;
    const { world, city, body, vehicle } = cityWithCar(new Vector3(target.position.x, 0, northFace + 20), facingSouth);
    const building = city.buildings.find((candidate) => candidate.position.equals(target.position))!;
    vehicle.throttle = 1;
    let deepest = 0;
    let fastest = 0;
    let crashed = false;
    runFor(world, 6, () => {
      fastest = Math.max(fastest, body.velocity.length());
      crashed ||= world.contacts.some((contact) => contact.bodyA === building || contact.bodyB === building);
      deepest = Math.max(deepest, cornerDepthIn(body, building));
    });
    expect(crashed).toBe(true);
    expect(fastest).toBeGreaterThan(8);
    expect(deepest).toBeLessThan(0.02);
    // still pushing at the wall with the throttle down, but going nowhere
    expect(Math.abs(vehicle.forwardSpeed(body))).toBeLessThan(0.5);
    expect(upright(body)).toBeGreaterThan(0.95);
  });

  it.each([20, 40, 60])('glances off a wall it hits at %i°, staying on its wheels', (angle) => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9 })] }));
    world.addBody(new Body({ type: 'static', position: new Vector3(0, 5, 12), colliders: [new BoxCollider({ size: new Vector3(200, 10, 4) })] }));
    const heading = (angle * Math.PI) / 180;
    const direction = new Vector3(Math.cos(heading), 0, Math.sin(heading));
    const start = new Vector3(-8 * Math.cos(heading), 0, 10 - 8 * Math.sin(heading));
    const { body } = createCarPhysics({ world, position: start, quaternion: new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), direction) });
    body.velocity.copy(direction).multiplyScalar(20);
    let leastUpright = 1;
    runFor(world, 3, () => (leastUpright = Math.min(leastUpright, upright(body))));
    // before the wheels collided, the body's bottom edge took the blow, and the tyres pushing it
    // against the wall rolled it over
    expect(leastUpright).toBeGreaterThan(0.9);
  });

  it('ploughs through a pyramid of crates', () => {
    const plaza = new Vector3(BLOCK_PITCH / 2, 0, BLOCK_PITCH / 2);
    const { world, city, body, vehicle } = cityWithCar(plaza.clone().add(new Vector3(8, 0, -20)));
    const pyramid = city.props.filter((prop) => prop.position.distanceTo(plaza.clone().add(new Vector3(8, prop.position.y, 0))) < 3);
    expect(pyramid.length).toBe(10);
    vehicle.throttle = 1;
    let deepest = 0;
    runFor(world, 5, () => {
      for (const crate of pyramid) deepest = Math.max(deepest, cornerDepthIn(crate, body), cornerDepthIn(body, crate));
    });
    const scattered = pyramid.filter((crate) => crate.position.distanceTo(plaza.clone().add(new Vector3(8, 0.5, 0))) > 2);
    expect(scattered.length).toBeGreaterThan(5);
    expect(deepest).toBeLessThan(0.03);
    expect(upright(body)).toBeGreaterThan(0.9);
  });
});
