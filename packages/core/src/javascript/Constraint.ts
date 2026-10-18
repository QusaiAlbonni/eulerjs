import type { SolverBody } from './SolverBody.js';

/**
 * Something that keeps bodies in a relationship by moving them directly, such as a joint or a
 * contact. The JavaScript backend runs every constraint once per substep:
 *
 * 1. bodies are moved by their velocities and forces,
 * 2. `solvePositions` corrects their poses (use `correctPosition`),
 * 3. velocities of corrected bodies are set to the motion they actually made,
 * 4. `solveVelocities` adjusts velocities directly, for damping, friction or restitution.
 */
export interface Constraint {
  /** The bodies the constraint acts on. When one of them wakes up, the backend wakes the others too. */
  readonly bodies?: readonly SolverBody[];
  solvePositions(substep: number): void;
  solveVelocities?(substep: number): void;
  /** Called once all the step's substeps have run, to report what the constraint carried. */
  finishStep?(timestep: number): void;
}
