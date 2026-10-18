import { MathUtils } from 'three';
import { describe, expect, it } from 'vitest';
import { SAILBOAT_LAYOUT } from '../src/boat/sailboatLayout.js';
import { SailingScenario } from './sailboatScenario.js';

const boatMass = SAILBOAT_LAYOUT.hullMass + SAILBOAT_LAYOUT.ballast.mass;

/** Runs a scenario under autopilot and averages the second half. */
function holdCourse(scenario: SailingScenario, headingDegrees: number, seconds: number) {
  let rudderSum = 0;
  let speedSum = 0;
  let samples = 0;
  let worstHeel = 0;
  const halfway = seconds / 2;
  let elapsed = 0;
  scenario.run(seconds, () => {
    const rudder = scenario.steerToward(headingDegrees);
    elapsed += scenario.world.timestep;
    worstHeel = Math.max(worstHeel, scenario.heelDegrees);
    if (elapsed > halfway) {
      rudderSum += rudder;
      speedSum += scenario.forwardSpeed;
      samples++;
    }
  });
  return { meanRudderDegrees: MathUtils.radToDeg(rudderSum / samples), meanSpeed: speedSum / samples, worstHeel };
}

describe('sailboat example', () => {
  it('floats level in calm water, displacing exactly its own mass', () => {
    const scenario = new SailingScenario({ windSpeed: 0 });
    scenario.run(20);
    const displacedMass = scenario.boat.buoyancy.submergedFraction * scenario.boat.voxels.volume * scenario.ocean.density;
    expect(Math.abs(displacedMass / boatMass - 1)).toBeLessThan(0.005);
    expect(scenario.heelDegrees).toBeLessThan(1);
  });

  it('holds a beam reach at a realistic speed with almost no rudder', () => {
    const scenario = new SailingScenario({ headingOffWind: 90 });
    const result = holdCourse(scenario, 90, 40);
    expect(Math.abs(scenario.headingDegrees - 90)).toBeLessThan(5);
    expect(result.meanSpeed).toBeGreaterThan(2);
    expect(result.meanSpeed).toBeLessThan(4);
    expect(Math.abs(result.meanRudderDegrees)).toBeLessThan(5);
    expect(result.worstHeel).toBeLessThan(20);
  });

  it('makes ground to windward close-hauled, 50° off the wind', () => {
    const scenario = new SailingScenario({ headingOffWind: 50, mainsailTrim: 20, jibTrim: 18 });
    const result = holdCourse(scenario, 50, 40);
    expect(scenario.upwindProgress).toBeGreaterThan(10);
    expect(Math.abs(result.meanRudderDegrees)).toBeLessThan(15);
  });

  it('cannot sail straight into the wind', () => {
    const scenario = new SailingScenario({ headingOffWind: 0, mainsailTrim: 0, jibTrim: 0 });
    scenario.run(30, () => scenario.steerToward(0));
    expect(scenario.upwindProgress).toBeLessThan(0);
  });

  it.each([
    { rudderDegrees: 20, turn: 'starboard (away from +x)', sign: -1 },
    { rudderDegrees: -20, turn: 'port (toward +x)', sign: 1 },
  ])('turns to $turn with $rudderDegrees° of rudder', ({ rudderDegrees, sign }) => {
    const scenario = new SailingScenario({ headingOffWind: 90 });
    holdCourse(scenario, 90, 20);
    const headingBefore = scenario.headingDegrees;
    scenario.boat.foils.rudder.angle = MathUtils.degToRad(rudderDegrees);
    scenario.run(8);
    const turned = MathUtils.euclideanModulo(scenario.headingDegrees - headingBefore + 180, 360) - 180;
    expect(sign * turned).toBeGreaterThan(30);
  });

  it('stands up to 25 knots of wind in waves without capsizing or blowing up', () => {
    const scenario = new SailingScenario({ windSpeed: 13, waves: true, headingOffWind: 90 });
    const result = holdCourse(scenario, 90, 30);
    const body = scenario.boat.body;
    expect(body.position.toArray().every(Number.isFinite)).toBe(true);
    expect(result.worstHeel).toBeLessThan(50);
    const surface = scenario.ocean.surfaceHeight(body.position.x, body.position.z, scenario.world.time);
    expect(Math.abs(body.worldCenterOfMass.y - surface)).toBeLessThan(2);
  }, 60_000);
});
