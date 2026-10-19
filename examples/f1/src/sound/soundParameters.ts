import { MathUtils } from 'three';
import type { Wheel } from '@eulerjs/vehicle';
import type { F1Car } from '../car/F1Car.js';
import { SURFACES } from '../track/Circuit.js';
import type { SoundParameters } from './dsp.js';

/**
 * How far past its peak a tyre slips, along and across together, before it is heard sliding, and
 * where it is loudest: well past, a lock-up or a slide. ABS holds a braking tyre just past its
 * peak, which is no slide, and is silent.
 */
const SQUEAL_FROM = 1.6;
const SQUEAL_FULL = 3;

/** What the car's sound follows, read off the car: `onboard` when heard from in it. */
export function soundParametersOf(car: F1Car, onboard: boolean, into: SoundParameters): SoundParameters {
  const powertrain = car.powertrain;
  const wheels = car.vehicle.wheels;
  into.rpm = powertrain.rpm;
  into.throttle = car.input.throttle;
  into.brake = car.input.brake;
  into.limiting = powertrain.limiting;
  into.speed = car.body.velocity.length();
  into.squeal = 0;
  into.kerb = 0;
  into.rough = 0;
  for (const wheel of wheels) {
    if (!wheel.onGround) continue;
    // only on the asphalt and the kerbs: on grass and gravel a tyre slides quietly
    const hard = wheel.surface !== SURFACES.grass && wheel.surface !== SURFACES.gravel;
    if (hard) into.squeal = Math.max(into.squeal, MathUtils.smoothstep(slipPastPeak(wheel, car.antiLock), SQUEAL_FROM, SQUEAL_FULL));
    if (wheel.surface === SURFACES.kerb) into.kerb += 1 / wheels.length;
    if (wheel.surface === SURFACES.gravel) into.rough += 1 / wheels.length;
    if (wheel.surface === SURFACES.grass) into.rough += 0.5 / wheels.length;
  }
  into.onboard = onboard ? 1 : 0;
  return into;
}

/** How far a tyre slips, along and across together, as a share of its peak: 1 at the peak. */
/**
 * How far a tyre slides, along and across together, as a share of its peak: 1 at the peak. With
 * ABS, braking slip along it isn't a slide: ABS keeps it from locking, its slip leaping now and
 * then as it lets the brake off and on, which is ABS at work.
 */
function slipPastPeak(wheel: Wheel, antiLock: boolean): number {
  const along = antiLock && wheel.slipRatio < 0 ? 0 : wheel.slipRatio / wheel.peakSlipRatio;
  return Math.hypot(along, Math.tan(wheel.slipAngle) / Math.tan(wheel.peakSlipAngle));
}
