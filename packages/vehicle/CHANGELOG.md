# @eulerjs/vehicle

## 0.2.0

### Minor Changes

- [`75e3bb3`](https://github.com/QusaiAlbonni/eulerjs/commit/75e3bb304354d6d0027d0459b3035e281b3b1a66) - A `surface` option, `(point, hit) => GroundSurface`, says what the ground is like where each wheel touches it: its `grip`, its extra `rollingResistance`, and its `height` above the collider, for kerbs, grass and gravel on one collider, and bumps felt through the suspension. Each wheel reports the `surface` it was on.

- [`75e3bb3`](https://github.com/QusaiAlbonni/eulerjs/commit/75e3bb304354d6d0027d0459b3035e281b3b1a66) - Slip tyres, for racing cars: with `tyres: 'slip'`, each wheel spins of its own, given `driveTorque` and `brakeTorque`, and its tyre pulls with how much it slips along and across, on a tyre curve with a peak (`peakSlipRatio`, `peakSlipAngle`), less grip past it (`slidingGrip`) and less grip a newton under more load (`loadSensitivity`, `nominalLoad`). Each wheel reports its `spinSpeed`, `slipRatio` and `slipAngle`.

### Patch Changes

- [`75e3bb3`](https://github.com/QusaiAlbonni/eulerjs/commit/75e3bb304354d6d0027d0459b3035e281b3b1a66) - The README's install line names `@eulerjs/core`, not `eulerjs`, which isn't a package.
