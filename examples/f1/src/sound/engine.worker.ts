import type { SoundParameters } from './dsp.js';
import { EngineSound } from './EngineSound.js';

// The engine's simulation, off the audio thread: it renders the engine's sound a little ahead and
// sends it to the audio worklet over a port, a chunk for each the worklet says it has played.

/** What the page sends the worker. */
export type EngineWorkerMessage = { start: { sampleRate: number; port: MessagePort } } | { parameters: SoundParameters } | { shift: true };
/** What the worker sends the page: the share of its time the simulation takes, over the last second of sound. */
export interface LoadMessage {
  load: number;
}
/** What the worklet sends the worker over the port: how many samples it has played. */
export interface PlayedMessage {
  played: number;
}

/** How far ahead of the audio the worker keeps, in samples: about 46 ms, as engine-sim keeps its own. */
export const LEAD = 2048;
const BLOCK = 128;

let sound: EngineSound | undefined;
let worklet: MessagePort | undefined;
let sampleRate = 44_100;
/** Time spent rendering, in ms, and the sound it rendered, in samples, since the load was last reported. */
let busy = 0;
let rendered = 0;

self.onmessage = (event: MessageEvent<EngineWorkerMessage>) => {
  const message = event.data;
  if ('start' in message) {
    sampleRate = message.start.sampleRate;
    sound = new EngineSound(sampleRate, 7);
    worklet = message.start.port;
    worklet.onmessage = (played: MessageEvent<PlayedMessage>) => render(played.data.played);
    render(LEAD);
  } else if ('parameters' in message) sound?.set(message.parameters);
  else sound?.shift();
};

function render(samples: number): void {
  if (!sound || !worklet) return;
  const started = performance.now();
  const chunk = new Float32Array(Math.ceil(samples / BLOCK) * BLOCK);
  for (let start = 0; start < chunk.length; start += BLOCK) sound.render(chunk.subarray(start, start + BLOCK));
  // counted before it is sent: sending hands its buffer over, leaving it empty here
  rendered += chunk.length;
  worklet.postMessage(chunk, [chunk.buffer]);
  busy += performance.now() - started;
  if (rendered >= sampleRate) {
    const message: LoadMessage = { load: busy / ((1000 * rendered) / sampleRate) };
    self.postMessage(message);
    busy = rendered = 0;
  }
}
