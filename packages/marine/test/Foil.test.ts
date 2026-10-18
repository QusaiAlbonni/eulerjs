import { MathUtils, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, MassProperties, World } from '@eulerjs/core';
import type { FluidMedium, Polar } from '@eulerjs/marine';
import { camberedSailPolar, Foil, sailPolar, symmetricFoilPolar, TablePolar, Wind } from '@eulerjs/marine';
import { SAIL_DRAG_BY_DEGREE, SAIL_LIFT_BY_DEGREE } from '../src/foils/sailTables.js';
import fixture from './fixtures/three-sails-sail-forces.json' with { type: 'json' };

/** A fluid moving uniformly with the given velocity. */
function uniformFlow(velocity: Vector3, density = 1.293): FluidMedium {
  return { density, velocityAt: (_point, _time, target) => target.copy(velocity) };
}

function bodyAtRest(velocity = new Vector3(), angularVelocity = new Vector3()): Body {
  return new Body({ massProperties: MassProperties.box(new Vector3(2, 2, 6), 1000), velocity, angularVelocity });
}

/** The polar three-sails used: table lookups rounded to the nearest whole degree. */
const roundedSailPolar: Polar = {
  liftCoefficient: (angle) => SAIL_LIFT_BY_DEGREE[Math.round(MathUtils.radToDeg(angle))]!,
  dragCoefficient: (angle) => SAIL_DRAG_BY_DEGREE[Math.round(MathUtils.radToDeg(angle))]!,
};

describe('Foil against three-sails', () => {
  it('matches the old sail force in drag and lift magnitude, with the lift direction corrected', () => {
    for (const testCase of fixture.cases) {
      const wind = new Vector3(...testCase.windVelocity);
      const foil = new Foil({
        medium: uniformFlow(wind, testCase.airDensity),
        area: testCase.area,
        center: new Vector3(),
        polar: roundedSailPolar,
        angle: MathUtils.degToRad(testCase.sailYawDegrees),
      });
      const force = foil.computeForce(bodyAtRest(new Vector3(...testCase.boatVelocity)), 0, new Vector3());
      const oldForce = new Vector3(...testCase.force);
      const flowDirection = new Vector3(...testCase.apparentWind).normalize();

      const dragAlongFlow = force.dot(flowDirection);
      const lift = force.clone().addScaledVector(flowDirection, -dragAlongFlow);
      const oldDragAlongFlow = oldForce.dot(flowDirection);
      const oldLift = oldForce.clone().addScaledVector(flowDirection, -oldDragAlongFlow);
      const dynamicPressureTimesArea = 0.5 * testCase.airDensity * new Vector3(...testCase.apparentWind).lengthSq() * testCase.area;

      expect(Math.abs(dragAlongFlow - oldDragAlongFlow) / dynamicPressureTimesArea).toBeLessThan(1e-9);
      expect(Math.abs(lift.length() - oldLift.length()) / dynamicPressureTimesArea).toBeLessThan(1e-9);
      if (oldLift.length() > 1e-6 * dynamicPressureTimesArea) {
        // three-sails pointed sail lift the wrong way: backwards when the sail was trimmed correctly
        expect(lift.clone().normalize().dot(oldLift.clone().normalize())).toBeCloseTo(-1, 9);
      }
    }
  });
});

describe('Foil as a sail', () => {
  // Wind from starboard (+x) blowing toward -x; the boat heads +z; the sail's leading edge (+z) is at the mast.
  const beamReachSail = (sailYawDegrees: number) =>
    new Foil({ medium: uniformFlow(new Vector3(-10, 0, 0)), area: 30, center: new Vector3(), polar: sailPolar, angle: MathUtils.degToRad(sailYawDegrees) });

  it('drives the boat forward on a beam reach with the boom eased to leeward', () => {
    const force = beamReachSail(50).computeForce(bodyAtRest(), 0, new Vector3());
    expect(force.z).toBeGreaterThan(1500);
    expect(force.x).toBeLessThan(0); // and heels it away from the wind
  });

  it('drives less with the boom on the windward side', () => {
    const correct = beamReachSail(50).computeForce(bodyAtRest(), 0, new Vector3());
    const backwinded = beamReachSail(-50).computeForce(bodyAtRest(), 0, new Vector3());
    expect(backwinded.z).toBeLessThan(correct.z / 2);
  });

  it('works with a Wind', () => {
    const wind = new Wind({ speed: 10, angle: Math.PI });
    const fromWind = new Foil({ medium: wind, area: 30, center: new Vector3(), polar: sailPolar, angle: MathUtils.degToRad(50) });
    const fromFlow = beamReachSail(50);
    expect(fromWind.computeForce(bodyAtRest(), 0, new Vector3()).distanceTo(fromFlow.computeForce(bodyAtRest(), 0, new Vector3()))).toBeLessThan(1e-9);
  });
});

describe('Foil physics', () => {
  const keel = () =>
    new Foil({ medium: uniformFlow(new Vector3(), 1029), area: 1.5, center: new Vector3(0, -1, 0), polar: symmetricFoilPolar() });

  it('pushes against leeway: a keel resists sideways drift', () => {
    const drifting = bodyAtRest(new Vector3(0.3, 0, 3));
    const force = keel().computeForce(drifting, 0, new Vector3());
    expect(force.x).toBeLessThan(0);
    expect(Math.abs(force.x)).toBeGreaterThan(Math.abs(force.z));
  });

  it('only creates drag when aligned with the flow', () => {
    const force = keel().computeForce(bodyAtRest(new Vector3(0, 0, 2)), 0, new Vector3());
    expect(Math.abs(force.x)).toBeLessThan(1e-9);
    expect(force.z).toBeLessThan(0);
  });

  it('splits its force into lift across the flow and drag along it', () => {
    const foil = new Foil({ medium: uniformFlow(new Vector3(-10, 0, -2)), area: 4, center: new Vector3(), polar: symmetricFoilPolar(), angle: 0.4 });
    const force = foil.computeForce(bodyAtRest(), 0, new Vector3());
    const flowDirection = new Vector3(-10, 0, -2).normalize();
    const dynamicPressureTimesArea = 0.5 * 1.293 * 104 * 4;
    const angle = foil.lastAngleOfAttack;
    const polar = symmetricFoilPolar();
    expect(force.dot(flowDirection)).toBeCloseTo(dynamicPressureTimesArea * polar.dragCoefficient(angle), 9);
    expect(force.length()).toBeCloseTo(dynamicPressureTimesArea * Math.hypot(polar.liftCoefficient(angle), polar.dragCoefficient(angle)), 9);
  });

  it('ignores flow along its span', () => {
    const foil = new Foil({ medium: uniformFlow(new Vector3(0, 20, 0)), area: 10, center: new Vector3(), polar: sailPolar });
    expect(foil.computeForce(bodyAtRest(), 0, new Vector3()).length()).toBe(0);
    expect(foil.lastFlowSpeed).toBe(0);
  });

  it('feels the flow from the body spinning, not just moving', () => {
    const foil = new Foil({ medium: uniformFlow(new Vector3(), 1029), area: 1, center: new Vector3(0, 0, -3), polar: symmetricFoilPolar() });
    const spinning = bodyAtRest(new Vector3(), new Vector3(0, 1, 0));
    const force = foil.computeForce(spinning, 0, new Vector3());
    // the stern swings toward -x, so the water pushes it back toward +x
    expect(force.x).toBeGreaterThan(0);
  });

  it('turns the chord with its angle, about the span axis', () => {
    const foil = new Foil({ medium: uniformFlow(new Vector3(0, 0, -5)), area: 1, center: new Vector3(), polar: sailPolar, angle: Math.PI / 2 });
    foil.computeForce(bodyAtRest(), 0, new Vector3());
    expect(foil.lastAngleOfAttack).toBeCloseTo(Math.PI / 2, 12);
  });

  it('applies its force where it acts during a step', () => {
    const world = new World({ gravity: new Vector3() });
    const body = world.addBody(bodyAtRest());
    const foil = body.addBehavior(
      new Foil({ medium: uniformFlow(new Vector3(-10, 0, 0)), area: 30, center: new Vector3(0, 5, 0), polar: sailPolar, angle: 0.8 }),
    );
    world.fixedStep();
    expect(foil.lastCenter.y).toBeCloseTo(5, 12);
    expect(body.angularVelocity.length()).toBeGreaterThan(0);
    expect(body.velocity.length()).toBeGreaterThan(0);
  });

  it('swings its centre of effort around the pivot as it turns', () => {
    const boom = new Foil({
      medium: uniformFlow(new Vector3(-10, 0, 0)),
      area: 10,
      center: new Vector3(0, 4, -1),
      pivot: new Vector3(0, 0, 0),
      polar: sailPolar,
      angle: Math.PI / 2,
    });
    boom.computeForce(bodyAtRest(), 0, new Vector3());
    // a quarter turn about +y takes (0, 4, -1) to (-1, 4, 0)
    expect(boom.lastCenter.distanceTo(new Vector3(-1, 4, 0))).toBeLessThan(1e-12);
  });

  it('rejects a chord parallel to the span', () => {
    expect(() => new Foil({ medium: new Wind(), area: 1, center: new Vector3(), polar: sailPolar, chordAxis: new Vector3(0, 2, 0) })).toThrow(RangeError);
  });
});

describe('polars', () => {
  it('symmetric foil: no lift head-on, thin-airfoil slope, sign flip when the flow reverses', () => {
    const polar = symmetricFoilPolar({ liftSlope: 5 });
    expect(polar.liftCoefficient(0)).toBe(0);
    expect(polar.liftCoefficient(0.01) / 0.01).toBeCloseTo(5, 9);
    for (const angle of [0.1, 0.3, 0.7, 1.2]) {
      expect(polar.liftCoefficient(Math.PI - angle)).toBeCloseTo(-polar.liftCoefficient(angle), 12);
    }
    expect(polar.liftCoefficient(Math.PI / 2)).toBeCloseTo(0, 12);
  });

  it('symmetric foil: drag grows from its minimum to a flat plate broadside on', () => {
    const polar = symmetricFoilPolar({ zeroLiftDrag: 0.01 });
    expect(polar.dragCoefficient(0)).toBeCloseTo(0.01, 12);
    expect(polar.dragCoefficient(Math.PI / 2)).toBeCloseTo(2, 12);
  });

  it('symmetric foil: lift changes smoothly through stall', () => {
    const polar = symmetricFoilPolar();
    let largestJump = 0;
    for (let degree = 0; degree < 180; degree += 0.25) {
      const jump = Math.abs(polar.liftCoefficient(MathUtils.degToRad(degree + 0.25)) - polar.liftCoefficient(MathUtils.degToRad(degree)));
      largestJump = Math.max(largestJump, jump);
    }
    expect(largestJump).toBeLessThan(0.05);
  });

  it('cambered sail: lifts at zero angle, climbs to its maximum, then stalls smoothly', () => {
    const polar = camberedSailPolar();
    expect(polar.liftCoefficient(0)).toBeCloseTo(0.3, 12);
    expect((polar.liftCoefficient(0.1) - polar.liftCoefficient(0.05)) / 0.05).toBeCloseTo(3.8, 9);
    let largestLift = 0;
    let largestJump = 0;
    for (let degree = 0; degree < 180; degree += 0.25) {
      const lift = polar.liftCoefficient(MathUtils.degToRad(degree));
      largestLift = Math.max(largestLift, lift);
      largestJump = Math.max(largestJump, Math.abs(polar.liftCoefficient(MathUtils.degToRad(degree + 0.25)) - lift));
    }
    expect(largestLift).toBeCloseTo(1.5, 2);
    expect(largestJump).toBeLessThan(0.05);
    expect(polar.liftCoefficient(MathUtils.degToRad(150))).toBeLessThan(0);
  });

  it('cambered sail: reaches a lift-to-drag ratio around 6 before stall, where the three-sails table stays below 2', () => {
    const bestRatio = (polar: Polar) => {
      let best = 0;
      for (let degree = 1; degree < 90; degree++) {
        const angle = MathUtils.degToRad(degree);
        best = Math.max(best, polar.liftCoefficient(angle) / polar.dragCoefficient(angle));
      }
      return best;
    };
    expect(bestRatio(camberedSailPolar())).toBeGreaterThan(5);
    expect(bestRatio(camberedSailPolar())).toBeLessThan(8);
    expect(bestRatio(sailPolar)).toBeLessThan(2);
  });

  it('table polar interpolates between whole degrees and clamps the range', () => {
    const lift = Array.from({ length: 181 }, (_unused, degree) => degree);
    const polar = new TablePolar(lift, lift);
    expect(polar.liftCoefficient(MathUtils.degToRad(10.5))).toBeCloseTo(10.5, 9);
    expect(polar.dragCoefficient(MathUtils.degToRad(400))).toBe(180);
    expect(polar.liftCoefficient(-1)).toBe(0);
  });

  it('table polar needs one sample per degree', () => {
    expect(() => new TablePolar([0, 1], [0, 1])).toThrow(RangeError);
  });
});
