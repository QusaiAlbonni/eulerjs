import { Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, PlaneCollider, World } from '@eulerjs/core';
import { F1Car } from '../src/car/F1Car.js';
import { Circuit, KERB_HEIGHTS, KERB_WIDTH } from '../src/track/Circuit.js';
import { MONZA } from '../src/track/monza.js';

// The car's suspension at work over the circuit's ground: smooth on the asphalt, which only
// ripples, bucking over the grass's swells, and the kerbs rising to their outer edge as drawn.

const circuit = new Circuit(MONZA);
/** A sample down the long start straight, well before the line, with grass either side. */
const straight = circuit.samples[circuit.samples.length - 200]!;

/** How fast the car's body moves up and down, as the root mean square in m/s, driven down the straight `across` its middle at `speed`. */
function bounce(across: number, speed: number): { vertical: number; surfaces: Set<string> } {
  const world = new World({ timestep: 1 / 120 });
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 1 })] }));
  const start = straight.position.clone().addScaledVector(straight.left, across);
  const car = new F1Car(world, new Object3D(), start, Math.atan2(straight.tangent.x, straight.tangent.z), (point) => circuit.groundAt(point));
  world.fixedStep();
  car.body.velocity.copy(straight.tangent).multiplyScalar(speed);
  for (const wheel of car.vehicle.wheels) wheel.spinSpeed = speed / wheel.radius;
  car.input.throttle = 0.3;
  for (let step = 0; step < 60; step++) world.fixedStep();
  let squares = 0;
  const surfaces = new Set<string>();
  for (let step = 0; step < 240; step++) {
    world.fixedStep();
    squares += car.body.velocity.y ** 2;
    surfaces.add(circuit.surfaceAt(car.body.position));
  }
  return { vertical: Math.sqrt(squares / 240), surfaces };
}

describe('the car over the circuit’s ground', () => {
  it('rides smoothly on the asphalt, which only ripples, and bucks over the grass', () => {
    const asphalt = bounce(0, 30);
    const grass = bounce(straight.halfWidth + 12, 30);
    expect([...asphalt.surfaces]).toEqual(['asphalt']);
    expect([...grass.surfaces]).toEqual(['grass']);
    // a few millimetres a second on the asphalt; on the grass, the body bobbing by centimetres
    expect(asphalt.vertical).toBeGreaterThan(0.002);
    expect(asphalt.vertical).toBeLessThan(0.03);
    expect(grass.vertical).toBeGreaterThan(5 * asphalt.vertical);
  });

  it('has its kerbs rise from their inner edge to their outer, as the scenery draws them', () => {
    const corner = circuit.samples.find((sample) => sample.kerbs)!;
    const heightAt = (out: number) => circuit.groundAt(corner.position.clone().addScaledVector(corner.left, out)).height ?? 0;
    expect(heightAt(corner.halfWidth + 0.05)).toBeCloseTo(KERB_HEIGHTS[0] + (KERB_HEIGHTS[1] - KERB_HEIGHTS[0]) * (0.05 / KERB_WIDTH), 3);
    expect(heightAt(corner.halfWidth + KERB_WIDTH - 0.05)).toBeGreaterThan(heightAt(corner.halfWidth + 0.3));
    expect(heightAt(corner.halfWidth + KERB_WIDTH - 0.01)).toBeLessThanOrEqual(KERB_HEIGHTS[1]);
    // and the asphalt beside them barely off flat
    expect(Math.abs(heightAt(0))).toBeLessThan(0.005);
  });
});
