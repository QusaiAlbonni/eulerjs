import { JavaScriptBackend } from '@eulerjs/core';
import { describeBackendConformance } from './backendConformance.js';

describeBackendConformance('JavaScriptBackend', () => new JavaScriptBackend());
describeBackendConformance('JavaScriptBackend (soft step)', () => new JavaScriptBackend({ solver: 'soft-step' }));
