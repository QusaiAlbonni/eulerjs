/**
 * The worker a SpectralWaves evaluates its physics' waves in, off the main thread:
 *
 *     waves.useWorker(new Worker(new URL('@eulerjs/marine/spectral-worker', import.meta.url), { type: 'module' }));
 */
import { serveSpectralFields } from './spectralWorker.js';
import type { SpectralPort } from './spectralWorker.js';

serveSpectralFields(globalThis as unknown as SpectralPort);
