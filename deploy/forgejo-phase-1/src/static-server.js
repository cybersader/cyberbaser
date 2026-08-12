import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateRunRoot } from './harness.js';

const runRoot = await validateRunRoot(process.argv[2]);
const publicationRoot = path.join(runRoot, 'publication');
const tlsRoot = path.join(runRoot, 'tls', 'published');
const cert = await readFile(path.join(tlsRoot, 'server.crt'));
const keyFile = path.join(tlsRoot, 'server.key');
const keyMetadata = await lstat(keyFile);
if (!keyMetadata.isFile() || (keyMetadata.mode & 0o077) !== 0) {
  throw new Error('published TLS private key must be one mode-0600 file');
}
const key = await readFile(keyFile);

const server = Bun.serve({
  hostname: '127.0.0.3',
  port: 8443,
  tls: { cert, key },
  async fetch(request) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || url.pathname !== '/' || url.search || url.hash) {
      return new Response('not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    let current;
    try {
      current = await realpath(path.join(publicationRoot, 'current'));
    } catch {
      return new Response('publication pending\n', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const relative = path.relative(publicationRoot, current);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('invalid publication\n', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
    const file = path.join(current, 'index.html');
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) {
      return new Response('invalid publication\n', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response(request.method === 'HEAD' ? null : Bun.file(file), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});

await Bun.write(path.join(runRoot, 'static-server.ready'), `${process.pid}\n`, { mode: 0o600 });
console.log(`wp3 static server ready at ${server.url.origin}`);
await new Promise(() => {});
