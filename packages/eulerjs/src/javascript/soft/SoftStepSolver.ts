import type { Contact, StepSettings } from '../../backend.js';
import type { DistanceJoint } from '../../joints/DistanceJoint.js';
import type { Joint } from '../../joints/Joint.js';
import { SixDofJoint } from '../../joints/SixDofJoint.js';
import type { Manifold } from '../collision/CollisionSystem.js';
import type { SolverBody } from '../SolverBody.js';
import { BodyTable } from './BodyTable.js';
import { ContactTable } from './ContactTable.js';
import { JointTable } from './JointTable.js';
import { SixDofTable } from './SixDofTable.js';
import { makeSoft } from './softness.js';

/**
 * How stiff constraints are, as a share of the substep rate: stiffer than a quarter of it and a
 * chain of equal links already starts to shake itself apart.
 */
const STIFFNESS_PER_SUBSTEP_RATE = 0.25;
/** The most stiffness contacts get, in hertz: stiff enough to hold a stack, soft enough to settle a pile gently. */
const CONTACT_HERTZ = 30;
/** Contacts with a body that doesn't move are this much stiffer: nothing on the other side gives way. */
const FIXED_CONTACT_STIFFENING = 2;
/** Contacts are heavily overdamped, so a body pushed out of another comes to rest without bouncing. */
const CONTACT_DAMPING_RATIO = 10;
/** Rigid joints are as stiff as the substeps allow, so they stretch less with more substeps. */
const JOINT_DAMPING_RATIO = 2;

/**
 * Solves a step by soft step, after Box2D v3: on each substep, velocities take the forces, then
 * the impulses the constraints ended the last substep with (warm starting), then a pass of
 * impulses that pulls every constraint back as a stiff damped spring; positions move; and a last
 * pass of impulses without the pull takes out the speed it added. Bounces are applied once, at
 * the end. Unlike the position-based solver, it works on velocities throughout and carries each
 * constraint's impulse from step to step, which is what lets stacks rest still.
 */
export class SoftStepSolver {
  private readonly bodies = new BodyTable();
  private readonly contactTable = new ContactTable();
  private readonly jointTable = new JointTable();
  private readonly sixDofTable = new SixDofTable();
  private reported: Contact[] | undefined = [];

  get contacts(): readonly Contact[] {
    this.reported ??= this.contactTable.reports(this.bodies);
    return this.reported;
  }

  step(
    solverBodies: readonly SolverBody[],
    jointBodies: ReadonlyMap<DistanceJoint, readonly [SolverBody, SolverBody | undefined]>,
    sixDofBodies: ReadonlyMap<SixDofJoint, readonly [SolverBody, SolverBody | undefined]>,
    manifolds: readonly Manifold[],
    settings: StepSettings,
  ): void {
    const substep = settings.timestep / settings.substeps;
    const stiffest = STIFFNESS_PER_SUBSTEP_RATE / substep;
    const contactHertz = Math.min(CONTACT_HERTZ, stiffest);
    const contactSoftness = makeSoft(contactHertz, CONTACT_DAMPING_RATIO, substep);
    const fixedSoftness = makeSoft(Math.min(FIXED_CONTACT_STIFFENING * contactHertz, stiffest), CONTACT_DAMPING_RATIO, substep);
    const jointSoftness = makeSoft(stiffest, JOINT_DAMPING_RATIO, substep);
    const bodies = this.bodies;
    bodies.load(solverBodies);
    this.contactTable.prepare(manifolds, bodies);
    this.jointTable.prepare(jointBodies, bodies, substep);
    this.sixDofTable.prepare(sixDofBodies, bodies);
    for (let substepIndex = 0; substepIndex < settings.substeps; substepIndex++) {
      bodies.integrateVelocities(substep, settings.gravity);
      this.jointTable.updateArms(bodies);
      this.jointTable.warmStart(bodies);
      this.sixDofTable.warmStart(bodies);
      this.contactTable.warmStart(bodies);
      this.jointTable.solve(bodies, substep, jointSoftness);
      this.sixDofTable.solve(bodies, substep, jointSoftness);
      this.contactTable.solve(bodies, substep, contactSoftness, fixedSoftness);
      bodies.integratePositions(substep);
      this.jointTable.updateArms(bodies);
      this.jointTable.solve(bodies, substep, undefined);
      this.sixDofTable.solve(bodies, substep, undefined);
      this.contactTable.solve(bodies, substep, undefined, undefined);
      this.contactTable.accumulate();
    }
    this.contactTable.applyRestitution(bodies);
    this.contactTable.storeImpulses(bodies);
    this.jointTable.finish(substep);
    this.sixDofTable.finish(substep);
    bodies.store();
    this.reported = undefined;
  }

  /** Forgets what it kept of a joint that has been taken out. */
  forget(joint: Joint): void {
    if (joint instanceof SixDofJoint) this.sixDofTable.forget(joint);
    else this.jointTable.forget(joint);
  }
}
