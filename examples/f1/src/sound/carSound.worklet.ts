import type { SoundParameters } from './dsp.js';
import type { PlayedMessage } from './engine.worker.js';
import { EngineFinish } from './EngineSound.js';
import { GroundSound } from './GroundSound.js';
import { HybridSound } from './HybridSound.js';

// The car's sound on the audio thread. 'car-sound' plays the engine's sound as the worker sends
// it, on its first output, for the page to convolve with the exhaust's impulse response; and
// makes the hybrid's whine and the tyres', the ground's and the wind's on its second.
// 'engine-finish' levels the convolved engine and muffles it from in the car.

// what the audio worklet's scope has, which TypeScript's DOM library leaves out
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }): void;

/** What the page posts to the processors. */
export type CarSoundMessage = { parameters: SoundParameters } | { engine: MessagePort };

/** How many samples the worklet plays before asking the worker for as many more. */
const ASK_EVERY = 512;

class CarSoundProcessor extends AudioWorkletProcessor {
  private readonly ground = new GroundSound(sampleRate, 7);
  private readonly hybrid = new HybridSound(sampleRate);
  private readonly hybridBlock = new Float32Array(128);
  private readonly chunks: Float32Array[] = [];
  private chunkOffset = 0;
  private played = 0;
  private engine: MessagePort | undefined;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<CarSoundMessage>) => {
      const message = event.data;
      if ('parameters' in message) {
        this.ground.set(message.parameters);
        this.hybrid.set(message.parameters);
      } else {
        this.engine = message.engine;
        this.engine.onmessage = (chunk: MessageEvent<Float32Array>) => this.chunks.push(chunk.data);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const engineOutput = outputs[0]?.[0];
    const groundOutput = outputs[1]?.[0];
    if (engineOutput) this.playEngine(engineOutput);
    if (groundOutput) {
      this.ground.render(groundOutput);
      const hybrid = this.hybridBlock.subarray(0, groundOutput.length);
      this.hybrid.render(hybrid);
      for (let index = 0; index < groundOutput.length; index++) groundOutput[index]! += hybrid[index]!;
      for (let channel = 1; channel < outputs[1]!.length; channel++) outputs[1]![channel]!.set(groundOutput);
    }
    return true;
  }

  /** The engine's sound, as far as the worker has sent it; silence if it has fallen behind. */
  private playEngine(output: Float32Array): void {
    let filled = 0;
    while (filled < output.length && this.chunks.length > 0) {
      const chunk = this.chunks[0]!;
      const taken = Math.min(chunk.length - this.chunkOffset, output.length - filled);
      output.set(chunk.subarray(this.chunkOffset, this.chunkOffset + taken), filled);
      filled += taken;
      this.chunkOffset += taken;
      if (this.chunkOffset === chunk.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    output.fill(0, filled);
    this.played += filled;
    if (this.played >= ASK_EVERY && this.engine) {
      const message: PlayedMessage = { played: this.played };
      this.engine.postMessage(message);
      this.played = 0;
    }
  }
}

class EngineFinishProcessor extends AudioWorkletProcessor {
  private readonly finish = new EngineFinish(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<CarSoundMessage>) => {
      if ('parameters' in event.data) this.finish.onboard = event.data.parameters.onboard;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.[0]) return true;
    if (input) this.finish.run(input, output[0]);
    else output[0].fill(0);
    for (let channel = 1; channel < output.length; channel++) output[channel]!.set(output[0]);
    return true;
  }
}

registerProcessor('car-sound', CarSoundProcessor);
registerProcessor('engine-finish', EngineFinishProcessor);
