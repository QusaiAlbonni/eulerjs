import { MathUtils, Vector3 } from 'three';

/**
 * Where everything is on boat.glb, in the boat's frame (+z toward the bow, +y up, the origin
 * near the deck), measured from the model's meshes. Masses and foil sizes are chosen for a
 * cruiser of this size (about 8.5 m long) rather than taken from the model.
 */
export const SAILBOAT_LAYOUT = {
  /** Edge of the cubes the hull is filled with for buoyancy and mass; small enough to catch the keel fin. */
  hullCellSize: 0.25,
  /** Mass of the hull, rig and fittings, spread evenly through the hull's volume. */
  hullMass: 2700,
  /** Lead in the keel bulb, which keeps the centre of mass low enough to stand up to the sails. */
  ballast: { mass: 1800, position: new Vector3(0, -1.35, 0.1) },
  /**
   * The hull mesh runs up the mast; the boat collides as the convex hull of its vertices below this
   * height (the deck and cabin top), not as a tall invisible pyramid up to the masthead.
   */
  hullColliderTop: 1.1,
  /** Height of the frame origin above the waterline when floating level, used to drop the boat in place. */
  originAboveWaterline: 0.3,
  /**
   * Water resistance on the hull, as drag per second when fully submerged (see Buoyancy). The
   * linear value gives about 3 m/s on a reach in 8 m/s of wind; the angular one damps rolling and yawing.
   */
  hullDrag: { linear: 0.25, angular: 1 },

  mainsail: {
    area: 14,
    spanAxis: new Vector3(0, 1, 0),
    /** Centroid of the sail triangle (head, tack, clew). */
    center: new Vector3(0, 3.9, 0.13),
    /** Mast, which the boom swings around. */
    pivot: new Vector3(0, 3.88, 1.11),
    maxAngle: MathUtils.degToRad(80),
    /** How fast the sheet can be eased or trimmed, in rad/s. */
    trimRate: MathUtils.degToRad(40),
  },
  jib: {
    area: 16,
    center: new Vector3(0, 3.95, 2.45),
    /** Tack, at the foot of the forestay. */
    pivot: new Vector3(0, 0.59, 4.58),
    /** The forestay, from the tack up to the masthead, which the jib turns about. */
    spanAxis: new Vector3(0, 9.76, -3.25).normalize(),
    maxAngle: MathUtils.degToRad(80),
    trimRate: MathUtils.degToRad(40),
  },
  /**
   * Keel fin plus the hull's lateral area, which together stop the boat sliding sideways. The
   * fin is centred at z = 0.1, but the hull's forefoot pulls the centre of lateral resistance
   * forward; at z = 1 the boat holds a reach with almost no rudder.
   */
  keel: {
    area: 2,
    center: new Vector3(0, -1, 1),
    /** Below 2π because the fin is short and deep in chord. */
    liftSlope: 3,
  },
  rudder: {
    area: 0.65,
    /** A quarter of the chord behind the leading edge. */
    center: new Vector3(0, -0.83, -3.01),
    /** Rudder post at the leading edge. */
    pivot: new Vector3(0, -0.83, -2.86),
    liftSlope: 3.5,
    maxAngle: MathUtils.degToRad(35),
    turnRate: MathUtils.degToRad(60),
    /** How fast the rudder recentres when let go, in rad/s. */
    returnRate: MathUtils.degToRad(45),
  },
} as const;

export type SailboatLayout = typeof SAILBOAT_LAYOUT;
