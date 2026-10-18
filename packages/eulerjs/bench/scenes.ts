import { IcosahedronGeometry, Vector3 } from 'three';
import { Body, BoxCollider, ConvexCollider, JavaScriptBackend, MassProperties, PlaneCollider, SphereCollider, World } from 'eulerjs';

/**
 * Scenes for the benchmarks and quality reports. Positions come from the generators below, so
 * other engines can be given exactly the same scenes.
 */

/** A grid of 1 m boxes, staggered so they fall into a pile. */
export function boxPilePositions(countPerSide: number): Vector3[] {
  const positions: Vector3[] = [];
  for (let column = 0; column < countPerSide; column++) {
    for (let layer = 0; layer < countPerSide; layer++) {
      for (let row = 0; row < countPerSide; row++) {
        positions.push(new Vector3(column * 1.2 + layer * 0.3, 1 + layer * 1.3, row * 1.2 - layer * 0.2));
      }
    }
  }
  return positions;
}

/** Spheres of radius 0.5 resting on the ground, 3 m apart. */
export function sphereFieldPositions(countPerSide: number): Vector3[] {
  const positions: Vector3[] = [];
  for (let column = 0; column < countPerSide; column++) {
    for (let row = 0; row < countPerSide; row++) positions.push(new Vector3(column * 3, 0.5, row * 3));
  }
  return positions;
}

/** Rocks dropped into a heap. */
export function rockPilePositions(countPerSide: number): Vector3[] {
  const positions: Vector3[] = [];
  for (let column = 0; column < countPerSide; column++) {
    for (let layer = 0; layer < countPerSide; layer++) {
      for (let row = 0; row < countPerSide; row++) positions.push(new Vector3(column * 1.1 + layer * 0.3, 1 + layer * 1.2, row * 1.1));
    }
  }
  return positions;
}

/** 1 m boxes stacked with 1 mm gaps. */
export function stackPositions(height: number): Vector3[] {
  return Array.from({ length: height }, (_unused, level) => new Vector3(0, 0.5 + level * 1.001, 0));
}

/** The rock shape: a rounded hull with 42 corners. */
export function rockHull(): ConvexCollider {
  return ConvexCollider.fromGeometry(new IcosahedronGeometry(0.5, 1));
}

/** The JavaScript backend with the solver named by EULER_SOLVER ('xpbd' or 'soft-step'), soft step if it isn't set. */
export function benchmarkBackend(): JavaScriptBackend {
  const solver = process.env.EULER_SOLVER;
  if (solver !== undefined && solver !== 'xpbd' && solver !== 'soft-step') throw new Error(`EULER_SOLVER is ${solver}, not 'xpbd' or 'soft-step'`);
  return new JavaScriptBackend({ solver });
}

/** `substeps` defaults to the world's own default, which is what most users get. */
export function groundedWorld(substeps?: number): World {
  const world = new World({ substeps, backend: benchmarkBackend() });
  world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
  return world;
}

export function boxPile(countPerSide: number, canSleep = true): World {
  const world = groundedWorld();
  const size = new Vector3(1, 1, 1);
  for (const position of boxPilePositions(countPerSide)) {
    world.addBody(new Body({ massProperties: MassProperties.box(size, 10), position, colliders: [new BoxCollider({ size })], canSleep }));
  }
  return world;
}

export function sphereField(countPerSide: number, canSleep = true): World {
  const world = groundedWorld();
  for (const position of sphereFieldPositions(countPerSide)) {
    world.addBody(new Body({ massProperties: MassProperties.sphere(0.5, 1), position, colliders: [new SphereCollider({ radius: 0.5 })], canSleep }));
  }
  return world;
}

export function rockPile(countPerSide: number, canSleep = true): World {
  const world = groundedWorld();
  const rock = rockHull();
  const massProperties = rock.massProperties({ density: 2500 });
  for (const position of rockPilePositions(countPerSide)) {
    world.addBody(new Body({ massProperties, position, colliders: [rock], canSleep }));
  }
  return world;
}

export function boxStack(height: number, substeps?: number, canSleep = true): { world: World; top: Body } {
  const world = groundedWorld(substeps);
  let top: Body | undefined;
  for (const position of stackPositions(height)) {
    top = world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position, canSleep, colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
  }
  return { world, top: top! };
}

export function runSeconds(world: World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
}

/** Median time of one call of `step`, over several batches. */
export function timeStep(step: () => void, batches = 7, stepsPerBatch = 60): number {
  const batchTimes: number[] = [];
  for (let batch = 0; batch < batches; batch++) {
    const started = performance.now();
    for (let index = 0; index < stepsPerBatch; index++) step();
    batchTimes.push((performance.now() - started) / stepsPerBatch);
  }
  return batchTimes.sort((first, second) => first - second)[Math.floor(batches / 2)]!;
}
