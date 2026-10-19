---
'@eulerjs/vehicle': minor
---

Slip tyres, for racing cars: with `tyres: 'slip'`, each wheel spins of its own, given `driveTorque` and `brakeTorque`, and its tyre pulls with how much it slips along and across, on a tyre curve with a peak (`peakSlipRatio`, `peakSlipAngle`), less grip past it (`slidingGrip`) and less grip a newton under more load (`loadSensitivity`, `nominalLoad`). Each wheel reports its `spinSpeed`, `slipRatio` and `slipAngle`.
