/**
 * The JONSWAP spectrum of a wind sea, after Horvath's "Empirical directional wave spectra for
 * computer graphics" (2015): how much of the sea's energy there is at each frequency, from the
 * wind's speed and how far it has blown over open water, and how that energy spreads about the
 * wind's direction (Mitsuyasu's cos²ˢ(θ/2), narrower near the peak). Deep water throughout.
 */

export interface SeaState {
  /** Wind speed ten metres up, in m/s. */
  windSpeed: number;
  /** How far the wind has blown over open water, in metres. */
  fetch: number;
  /** The peak enhancement γ: 3.3 for a young sea, 1 for the Pierson–Moskowitz spectrum of a fully grown one. */
  peakEnhancement: number;
  gravity: number;
}

/** The spectrum's peak angular frequency and its energy scale α, from the wind and the fetch. */
export function jonswapParameters(sea: SeaState): { peakFrequency: number; energyScale: number } {
  const { windSpeed, fetch, gravity } = sea;
  return {
    peakFrequency: 22 * Math.cbrt((gravity * gravity) / (windSpeed * fetch)),
    energyScale: 0.076 * Math.pow((windSpeed * windSpeed) / (fetch * gravity), 0.22),
  };
}

/** The energy density at angular frequency ω, S(ω) in m²·s: integrated over ω it is the variance of the sea's height. */
export function jonswap(angularFrequency: number, sea: SeaState): number {
  if (angularFrequency <= 0) return 0;
  const { peakFrequency, energyScale } = jonswapParameters(sea);
  const width = angularFrequency <= peakFrequency ? 0.07 : 0.09;
  const peakShape = Math.exp(-((angularFrequency - peakFrequency) ** 2) / (2 * width * width * peakFrequency * peakFrequency));
  const ratio = peakFrequency / angularFrequency;
  return ((energyScale * sea.gravity * sea.gravity) / angularFrequency ** 5) * Math.exp(-1.25 * ratio ** 4) * Math.pow(sea.peakEnhancement, peakShape);
}

const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** Natural logarithm of the gamma function, by Lanczos's approximation (good to about 15 digits for x > 0). */
function logGamma(value: number): number {
  const shifted = value - 1;
  let sum = 0.99999999999980993;
  for (let index = 0; index < LANCZOS.length; index++) sum += LANCZOS[index]! / (shifted + index + 1);
  const base = shifted + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(base) - base + Math.log(sum);
}

/**
 * How much of the energy at angular frequency ω travels at `angle` radians from the wind,
 * D(ω, θ) = Q(s) |cos(θ/2)|²ˢ, with Q normalising it to 1 over every direction, and the spread s
 * Mitsuyasu's: largest at the peak, so the longest waves keep closest to the wind.
 */
export function directionalSpread(angularFrequency: number, angle: number, sea: SeaState): number {
  const { peakFrequency } = jonswapParameters(sea);
  const peakSpread = 11.5 * (sea.gravity / (peakFrequency * sea.windSpeed)) ** 2.5;
  const ratio = angularFrequency / peakFrequency;
  const spread = peakSpread * (ratio <= 1 ? ratio ** 5 : ratio ** -2.5);
  const normalisation = Math.exp((2 * spread - 1) * Math.log(2) + 2 * logGamma(spread + 1) - logGamma(2 * spread + 1)) / Math.PI;
  return normalisation * Math.pow(Math.abs(Math.cos(angle / 2)), 2 * spread);
}

/**
 * The energy density over the plane of wavenumbers, S(kx, kz) in m⁴, for waves travelling along
 * (kx, kz) with the wind blowing toward `windAngle`: integrated over the plane, the sea's height
 * variance. From S(ω) D(ω, θ) by the change of variables dω dθ = (dω/dk) / k dkx dkz, with deep
 * water's ω = √(g k), so dω/dk = g / 2ω.
 */
export function wavenumberSpectrum(waveNumberX: number, waveNumberZ: number, windAngle: number, sea: SeaState): number {
  const waveNumber = Math.hypot(waveNumberX, waveNumberZ);
  if (waveNumber === 0) return 0;
  const angularFrequency = Math.sqrt(sea.gravity * waveNumber);
  const angle = Math.atan2(waveNumberZ, waveNumberX) - windAngle;
  return jonswap(angularFrequency, sea) * directionalSpread(angularFrequency, angle, sea) * (sea.gravity / (2 * angularFrequency)) / waveNumber;
}

/**
 * `wavenumberSpectrum` for one sea and wind, its constants worked out once: for filling a grid of
 * waves, where the same sea is asked about tens of thousands of times.
 */
export function wavenumberSpectrumOf(windAngle: number, sea: SeaState): (waveNumberX: number, waveNumberZ: number) => number {
  const { peakFrequency, energyScale } = jonswapParameters(sea);
  const peakSpread = 11.5 * (sea.gravity / (peakFrequency * sea.windSpeed)) ** 2.5;
  const gravity = sea.gravity;
  return (waveNumberX, waveNumberZ) => {
    const waveNumber = Math.hypot(waveNumberX, waveNumberZ);
    if (waveNumber === 0) return 0;
    const angularFrequency = Math.sqrt(gravity * waveNumber);
    // JONSWAP's S(ω), as `jonswap`
    const width = angularFrequency <= peakFrequency ? 0.07 : 0.09;
    const peakShape = Math.exp(-((angularFrequency - peakFrequency) ** 2) / (2 * width * width * peakFrequency * peakFrequency));
    const ratio = peakFrequency / angularFrequency;
    const energy = ((energyScale * gravity * gravity) / angularFrequency ** 5) * Math.exp(-1.25 * ratio ** 4) * Math.pow(sea.peakEnhancement, peakShape);
    // and its spread about the wind, as `directionalSpread`
    const frequencyRatio = angularFrequency / peakFrequency;
    const spread = peakSpread * (frequencyRatio <= 1 ? frequencyRatio ** 5 : frequencyRatio ** -2.5);
    const normalisation = Math.exp((2 * spread - 1) * Math.LN2 + 2 * logGamma(spread + 1) - logGamma(2 * spread + 1)) / Math.PI;
    const angle = Math.atan2(waveNumberZ, waveNumberX) - windAngle;
    const share = normalisation * Math.pow(Math.abs(Math.cos(angle / 2)), 2 * spread);
    return (energy * share * (gravity / (2 * angularFrequency))) / waveNumber;
  };
}
