import { readFileSync } from 'node:fs';
import { BufferGeometryLoader, MathUtils, Quaternion, Vector3 } from 'three';
import { World } from '@eulerjs/core';
import { Ocean, SpectralWaves, SumOfSines, Wind } from '@eulerjs/marine';
import type { WaveSurface } from '@eulerjs/marine';
import { createSailboatPhysics } from '../src/boat/sailboatPhysics.js';
import type { SailboatPhysics } from '../src/boat/sailboatPhysics.js';
import { SAILBOAT_LAYOUT } from '../src/boat/sailboatLayout.js';

const hullGeometry = new BufferGeometryLoader().parse(
  JSON.parse(readFileSync(new URL('./fixtures/hull-geometry.json', import.meta.url), 'utf8')),
);

const UP = new Vector3(0, 1, 0);

export interface ScenarioOptions {
  windSpeed?: number;
  /** Heading relative to where the wind comes from, in degrees: 0 is straight into it. */
  headingOffWind?: number;
  /** Boom and jib angles off the centreline, in degrees, eased away from the wind. */
  mainsailTrim?: number;
  jibTrim?: number;
  waves?: boolean;
}

/** A boat on a sea with the wind coming from +z, pointed `headingOffWind` degrees toward +x of it. */
export class SailingScenario {
  readonly world = new World({ timestep: 1 / 120 });
  readonly ocean: Ocean<WaveSurface>;
  readonly boat: SailboatPhysics;
  readonly start: Vector3;

  constructor(options: ScenarioOptions = {}) {
    // waves: the spectral sea the example sails on; or none
    this.ocean = new Ocean<WaveSurface>({ waves: options.waves ? new SpectralWaves() : new SumOfSines({ waveCount: 0 }) });
    const wind = new Wind({ speed: options.windSpeed ?? 8, angle: -Math.PI / 2 });
    this.boat = createSailboatPhysics({
      world: this.world,
      ocean: this.ocean,
      wind,
      hullGeometry,
      quaternion: new Quaternion().setFromAxisAngle(UP, MathUtils.degToRad(options.headingOffWind ?? 90)),
    });
    // With the wind over the port side, the sails are eased to starboard: negative angles.
    this.boat.foils.mainsail.angle = -MathUtils.degToRad(options.mainsailTrim ?? 45);
    this.boat.foils.jib.angle = -MathUtils.degToRad(options.jibTrim ?? 40);
    this.start = this.boat.body.position.clone();
  }

  /** Direction of travel, measured from +z toward +x, in degrees. */
  get headingDegrees(): number {
    const heading = this.headingVector();
    return MathUtils.radToDeg(Math.atan2(heading.x, heading.z));
  }

  get heelDegrees(): number {
    return MathUtils.radToDeg(UP.clone().applyQuaternion(this.boat.body.quaternion).angleTo(UP));
  }

  get forwardSpeed(): number {
    return this.boat.body.velocity.dot(this.headingVector());
  }

  /** Distance made good toward where the wind comes from. */
  get upwindProgress(): number {
    return this.boat.body.position.z - this.start.z;
  }

  run(seconds: number, eachStep?: () => void): void {
    for (let step = 0; step < Math.round(seconds / this.world.timestep); step++) {
      eachStep?.();
      this.world.fixedStep();
    }
  }

  /** Steers toward a heading like a simple autopilot, returning the rudder angle it chose (radians). */
  steerToward(headingDegrees: number): number {
    const error = MathUtils.degToRad(headingDegrees - this.headingDegrees);
    const wrappedError = Math.atan2(Math.sin(error), Math.cos(error));
    const limit = SAILBOAT_LAYOUT.rudder.maxAngle;
    // a negative rudder angle turns the bow toward +x; the yaw rate term stops it overshooting
    const rudder = MathUtils.clamp(-1.5 * wrappedError + 0.8 * this.boat.body.angularVelocity.y, -limit, limit);
    this.boat.foils.rudder.angle = rudder;
    return rudder;
  }

  private headingVector(): Vector3 {
    return new Vector3(0, 0, 1).applyQuaternion(this.boat.body.quaternion).setY(0).normalize();
  }
}
