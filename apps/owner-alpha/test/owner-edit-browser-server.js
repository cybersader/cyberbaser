// Socket fixture for the renderer's browser acceptance. Actual owner HTTP and
// security handlers; source is synthetic, and this fixture cannot apply writes.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createOwnerAlphaHandler } from '../src/server.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { detectYamlFrontmatterRange } from '../src/source.js';
const [input, readerOrigin] = process.argv.slice(2);
let handler;
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(readerOrigin).port) - 1, fetch: request => handler ? handler(request) : new Response(null, { status: 503 }) });
const raw = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url)));
raw.listen = { host: '127.0.0.1', port: server.port, readerPort: Number(new URL(readerOrigin).port) };
const config = validateOwnerAlphaConfig(raw);
handler = createOwnerAlphaHandler({ config,
  createEditSession: async ({ renderer }) => {
    if (!['target.md', 'index.md'].includes(renderer.relativePath)) throw Error('synthetic page only');
    const base = await readFile(path.join(input, renderer.relativePath));
    return { schemaVersion: 1, artifactType: 'owner-alpha-edit-session', relativePath: renderer.relativePath, slug: renderer.slug,
      liveUrl: `${readerOrigin}/${renderer.slug}`, baseCommit: '1'.repeat(40), policyRevision: computePolicyRevision(config),
      source: { text: base.toString('utf8'), bytesBase64: base.toString('base64'), byteLength: base.length,
        digest: `sha-256=:${createHash('sha256').update(base).digest('base64')}:`, frontmatter: detectYamlFrontmatterRange(base) } };
  },
  saveEdit: async () => { throw Error('browser-fixture-no-effects'); }, lookupJob: async () => null,
});
process.stdout.write(`${JSON.stringify({ origin: handler.ownerOrigin, bootstrap: handler.bootstrapToken })}\n`);
process.on('SIGTERM', () => { server.stop(true); process.exit(0); });
