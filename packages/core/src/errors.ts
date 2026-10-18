/** Base class for every error eulerjs throws, so callers can catch the engine's errors as a group. */
export class EulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A mesh can't be used for the requested computation, e.g. it isn't closed or is inside out. */
export class InvalidMeshError extends EulerError {}

/** Mass, inertia or another physical quantity is missing, non-finite or physically impossible. */
export class InvalidMassError extends EulerError {}
