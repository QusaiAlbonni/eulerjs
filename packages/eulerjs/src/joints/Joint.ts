import type { DistanceJoint } from './DistanceJoint.js';
import type { SixDofJoint } from './SixDofJoint.js';

/** Every kind of joint: hinges, sliders, fixed and cone-twist joints are SixDofJoints. A backend that can't simulate one throws when it is added. */
export type Joint = DistanceJoint | SixDofJoint;
