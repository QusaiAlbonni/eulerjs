import { createFieldScratch, evaluateFields } from './spectralFields.js';
import type { FieldScratch, FieldSource } from './spectralFields.js';

/**
 * The messages SpectralWaves and its worker send each other. Fields go back and forth as
 * transferred buffers, so none is copied: the worker fills the one it is sent and sends it back.
 */
export type SpectralRequest = { kind: 'setup'; source: FieldSource } | { kind: 'evaluate'; time: number; phaseTime: number; version: number; fields: Float64Array };
export interface SpectralReply {
  /** The simulation time asked for: the request's, sent back to file the fields under. */
  time: number;
  /** The sea's version it was asked for under: once the sea changes, older ones are of no use. */
  version: number;
  fields: Float64Array;
}

/** What a Worker, a worker's own global scope and a MessagePort all are, as far as this goes. */
export interface SpectralPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/**
 * Answers SpectralWaves' requests arriving on `port`: in a worker, the worker's global scope (see
 * `spectralWorkerEntry.ts`), or one end of a MessageChannel to evaluate on the main thread
 * asynchronously.
 */
export function serveSpectralFields(port: SpectralPort): void {
  let source: FieldSource | undefined;
  let scratch: FieldScratch | undefined;
  port.onmessage = (event: MessageEvent) => {
    const request = event.data as SpectralRequest;
    if (request.kind === 'setup') {
      source = request.source;
      scratch = createFieldScratch(source.resolution);
      return;
    }
    if (!source || !scratch) throw new Error('A spectral sea worker was asked for waves before it was set up');
    evaluateFields(source, request.phaseTime, request.fields, scratch);
    const reply: SpectralReply = { time: request.time, version: request.version, fields: request.fields };
    port.postMessage(reply, [request.fields.buffer]);
  };
}
