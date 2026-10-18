import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

/**
 * Serves the examples, built by scripts/build-examples.mjs into `directory`, under
 * `<base>examples/<name>/` from the docs' dev server, as the deployed site has them. The examples
 * are Vite apps of their own, so VitePress knows nothing of them; its builds copy them in.
 */
export function serveExamples(directory: string, base: string, names: ReadonlySet<string>): Plugin {
  const prefix = `${base}examples/`;
  const handle = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
    if (!path.startsWith(prefix)) return next();
    const relative = normalize(path.slice(prefix.length));
    // anything else under /examples/, the gallery page among it, is VitePress's own
    const example = relative.split('/')[0] ?? '';
    if (!names.has(example)) return next();
    let file = join(directory, relative);
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) {
        response.writeHead(301, { Location: `${path}/` }).end();
        return;
      }
      file = join(file, 'index.html');
    }
    if (!existsSync(file)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      const built = existsSync(join(directory, example));
      response.end(built ? 'Not found.' : `The ${example} example isn't built. Run npm run docs:examples, then reload.`);
      return;
    }
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  };
  return {
    name: 'eulerjs:serve-examples',
    configureServer: (server) => void server.middlewares.use(handle),
  };
}
