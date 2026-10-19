// The car's numbers, close to a modern Formula 1 car's: published figures where there are any
// (mass, dimensions, wheel size), and where teams keep them secret (aerodynamics, tyres, engine
// curves), values in the range engineers and simulators quote. One place to tune the car.

/** The body's frame: x to the car's left, y up, z forward, its origin at the centre of mass. */
export const SPECIFICATION = {
  /** With the driver and a little fuel, in kg: the minimum the rules allow is 798. */
  mass: 800,
  /** Moment of inertia as of a solid box this size, in metres: about 1300 kg·m² about the vertical. */
  inertiaBox: { width: 1.4, height: 0.5, length: 4.2 },
  /** How high the centre of mass stands, in metres. */
  centerOfMassHeight: 0.28,
  /** From the front axle to the rear, in metres. */
  wheelbase: 3.6,
  /** The share of the car's weight on the front wheels, standing still. */
  frontWeightShare: 0.45,
  /** Between the wheels' centres across each axle, in metres. */
  frontTrack: 1.6,
  rearTrack: 1.55,

  wheel: {
    /** 18-inch rims, 720 mm across the tyre. */
    radius: 0.36,
    /** About their axles, tyre, rim and brake together, in kg·m². */
    frontInertia: 1.0,
    rearInertia: 1.3,
  },

  /** Slicks on a warm dry track. */
  tyre: {
    /** Grip at the load the tyre is built for: slicks grip far better than road tyres' 1. */
    grip: 1.7,
    /**
     * The rear tyres are far wider (405 mm to the front's 305) and grip more, which keeps the car
     * from spinning at the limit: with the same grip all round, the rear would let go first.
     */
    rearGrip: 1.87,
    /** The slip angle the tyre corners hardest at, in radians: about 7°. */
    peakSlipAngle: 0.12,
    peakSlipRatio: 0.1,
    slidingGrip: 0.75,
    /** Grip falls 10% each time the load doubles: downforce gives less than its weight in grip. */
    loadSensitivity: 0.15,
    /** The load the grip is quoted at, in newtons: a wheel's share of the car's weight. */
    nominalLoad: 2000,
    rollingResistance: 0.012,
  },

  /** Stiff, as aerodynamics wants the car held level, in N/m and N·s/m at the wheel. */
  suspension: {
    travel: 0.08,
    frontStiffness: 140_000,
    rearStiffness: 160_000,
    frontDamping: 7000,
    rearDamping: 7500,
  },

  aerodynamics: {
    airDensity: 1.225,
    /** Downforce: lift coefficient times frontal area, in m². At 300 km/h about twice the car's weight. */
    downforceArea: 4.2,
    /** Drag: drag coefficient times frontal area, in m². */
    dragArea: 1.25,
    /** The share of the downforce on the front axle: a little less than of the weight, for stability at speed. */
    frontShare: 0.4,
    /** With DRS open: the share of the drag and of the rear downforce the open flap sheds. */
    drsDragCut: 0.12,
    drsRearDownforceCut: 0.25,
  },

  engine: {
    /** A 1.6-litre turbocharged V6 with its hybrid boost, as torque at the crankshaft against rpm, in N·m. */
    torqueCurve: [
      [4000, 380],
      [7000, 520],
      [10_000, 620],
      [11_500, 610],
      [12_500, 560],
      [13_000, 520],
    ] as const,
    idleRpm: 4000,
    /**
     * What turns with the crankshaft, in kg·m²: the crankshaft, the flywheel, the MGU-K geared to it.
     * Through the gearbox it weighs on the rear wheels as its square: in first gear five times
     * their own inertia. An estimate: the teams don't say.
     */
    inertia: 0.04,
    /** Where the limiter cuts the fuel. */
    limiterRpm: 13_000,
    /** What the engine holds back with no throttle, at the limiter, in N·m; less lower down. */
    engineBraking: 45,
    /** The share of the engine's torque the gearbox and the differential pass on. */
    efficiency: 0.93,
  },

  gearbox: {
    /** Eight forward gears, each with the final drive: engine turns per wheel turn. */
    ratios: [16.3, 12.4, 10.0, 8.4, 7.2, 6.3, 5.55, 4.9] as const,
    /** How long the drive is cut for a shift, in seconds: a seamless-shift box hardly cuts it at all. */
    shiftTime: 0.008,
    /** How long the engine's revs take to settle to the new gear's after a shift, in seconds: not at once, the engine having inertia. */
    shiftSettle: 0.08,
    /** How long the automatic holds a gear after a shift before it shifts again, in seconds, so that it never hunts. */
    automaticHold: 0.25,
    /** Where the automatic shifts up and down, in rpm. */
    upshiftRpm: 12_200,
    downshiftRpm: 7600,
  },

  /** A limited-slip differential: how hard it holds the rear wheels together, in N·m per rad/s apart. */
  differentialLocking: 25,

  /** Balanced 62% to the front, as the car dives onto its front wheels braking. */
  brakes: {
    /** The most torque each wheel's brake gives, in N·m. */
    frontTorque: 6200,
    rearTorque: 3800,
  },

  steering: {
    /** The most the front wheels turn, in radians: about 17°. */
    maxAngle: 0.3,
  },
} as const;
