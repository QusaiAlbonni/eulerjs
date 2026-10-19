// The exhaust's impulse response the engine is heard through: one of engine-sim's recordings
// (github.com/ange-yaghi/engine-sim, MIT, © 2022 Ange Yaghi; see ENGINE_SIM_LICENSE), at the
// level engine-sim plays it. engine-sim keeps up to 10 000 samples of it; this recording rings
// on for over 100 ms, as an exhaust does in a room, so only its first few milliseconds are kept,
// faded out: the pipe's own sound, heard in the open air.

/** engine-sim's level for its recordings, and the most of one it keeps, in samples. */
const VOLUME = 0.01;
const LONGEST = 10_000;
/** How much of the recording is kept, in seconds, the last share of it faded out. */
const OPEN_AIR_LENGTH = 0.015;
const FADE_SHARE = 0.4;

/** `recording`, −1 to 1, made ready to convolve the engine's sound with. */
export function exhaustResponse(recording: Float32Array, sampleRate: number): Float32Array<ArrayBuffer> {
  // where it has died away, as engine-sim cuts it: below 100 of 32 767
  let length = 0;
  for (let index = 0; index < recording.length; index++) if (Math.abs(recording[index]!) > 100 / 32_767) length = index + 1;
  length = Math.min(length, LONGEST, Math.round(OPEN_AIR_LENGTH * sampleRate));
  const response = new Float32Array(length);
  const fade = Math.round(length * FADE_SHARE);
  for (let index = 0; index < length; index++) {
    const fading = index - (length - fade);
    const level = fading > 0 ? 0.5 + 0.5 * Math.cos((Math.PI * fading) / fade) : 1;
    response[index] = recording[index]! * VOLUME * level;
  }
  return response;
}
