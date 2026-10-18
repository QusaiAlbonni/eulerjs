/**
 * Soft constraints, after Erin Catto's soft step solver (Box2D v3): a constraint behaves as a
 * damped spring of the given frequency, which stays stable at any stiffness the substep allows.
 * The solver's impulse for a constraint error C and velocity error v is
 * `-mass · massScale · (v + biasRate · C) - impulseScale · accumulated`.
 */
export interface Softness {
  readonly biasRate: number;
  readonly massScale: number;
  readonly impulseScale: number;
}

/** A rigid constraint: no bias, full mass. */
export const RIGID: Softness = { biasRate: 0, massScale: 1, impulseScale: 0 };

/** The softness of a spring of `hertz` and damping ratio `dampingRatio`, solved every `substep` seconds. */
export function makeSoft(hertz: number, dampingRatio: number, substep: number): Softness {
  if (hertz === 0) return RIGID;
  const angularFrequency = 2 * Math.PI * hertz;
  const dampingTerm = 2 * dampingRatio + substep * angularFrequency;
  const stiffnessTerm = substep * angularFrequency * dampingTerm;
  const scale = 1 / (1 + stiffnessTerm);
  return { biasRate: angularFrequency / dampingTerm, massScale: stiffnessTerm * scale, impulseScale: scale };
}
