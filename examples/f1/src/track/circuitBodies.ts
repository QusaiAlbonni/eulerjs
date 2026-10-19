import { Quaternion, Vector3 } from 'three';
import { Body, BoxCollider, PlaneCollider } from '@eulerjs/core';
import type { World } from '@eulerjs/core';
import { WALL_HEIGHT } from './Circuit.js';
import type { Circuit } from './Circuit.js';

/** How thick the walls' bodies are, in metres: thick enough that a car at full speed can't pass through one in a step. */
const WALL_THICKNESS = 1.2;
/** Samples to each of the walls' boxes. */
const SAMPLES_A_BOX = 3;
/**
 * Boxes to each of the walls' bodies: a body's cost each step is the engine's to pay whether or
 * not it moves, and a wall's boxes cost little more as one body's colliders than one box would.
 */
const BOXES_A_BODY = 24;

/**
 * The circuit to the physics: flat ground, and the walls along both sides, a box every few
 * samples, standing where the scenery draws them, a stretch of boxes to each body. Kerbs, grass and gravel are all the one ground;
 * what each is like comes from `circuit.surfaceAt`, through the car's tyres.
 */
export function addCircuitBodies(world: World, circuit: Circuit): void {
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 1 })] }));
  const samples = circuit.samples;
  const up = new Vector3(0, 1, 0);
  for (const sideIndex of [0, 1] as const) {
    const outward = sideIndex === 0 ? 1 : -1;
    for (const [first, last] of circuit.wallRuns(sideIndex)) {
      let stretch: { middle: Vector3; turn: Quaternion; length: number }[] = [];
      const addStretch = () => {
        if (stretch.length === 0) return;
        // a body at the stretch's first box, its boxes placed from there
        const origin = stretch[0]!.middle;
        world.addBody(
          new Body({
            type: 'static',
            position: origin,
            colliders: stretch.map(
              (box) => new BoxCollider({ size: new Vector3(WALL_THICKNESS, WALL_HEIGHT, box.length + 0.4), offset: box.middle.clone().sub(origin), rotation: box.turn, friction: 0.3, restitution: 0.2 }),
            ),
          }),
        );
        stretch = [];
      };
      for (let index = first; index < last; index += SAMPLES_A_BOX) {
        const sample = samples[index % samples.length]!;
        const from = circuit.barrierPoint(sample, sideIndex);
        const to = circuit.barrierPoint(samples[Math.min(index + SAMPLES_A_BOX, last) % samples.length]!, sideIndex);
        const length = from.distanceTo(to);
        if (length < 0.1) continue;
        // its face on the wall's line, the rest of it behind
        const middle = from.clone().add(to).multiplyScalar(0.5).addScaledVector(sample.left, (outward * WALL_THICKNESS) / 2);
        middle.y = WALL_HEIGHT / 2;
        stretch.push({ middle, turn: new Quaternion().setFromAxisAngle(up, Math.atan2(to.x - from.x, to.z - from.z)), length });
        if (stretch.length === BOXES_A_BODY) addStretch();
      }
      addStretch();
    }
  }
}
