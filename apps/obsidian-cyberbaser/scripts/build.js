// Bundle the plugin into dist/ (main.js, manifest.json, styles.css). The Iroh
// WASM is embedded in main.js because Obsidian loads a single script.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');
const wasm = await readFile(path.join(root, 'carrier/target/browser/carrier_bg.wasm')).catch(() => {
  throw new Error('Build the WASM first: bun run build:wasm');
});
await mkdir(path.join(root, 'build'), { recursive: true });
await writeFile(path.join(root, 'build/wasm-inline.js'), `export const WASM_BASE64 = ${JSON.stringify(wasm.toString('base64'))};\n`);
const result = await Bun.build({ entrypoints: [path.join(root, 'src/main.js')], format: 'cjs', target: 'browser',
  external: ['obsidian'], minify: true });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
const main = Buffer.from(await result.outputs[0].arrayBuffer());
await writeFile(path.join(dist, 'main.js'), main);
await copyFile(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
await copyFile(path.join(root, 'styles.css'), path.join(dist, 'styles.css'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({ wasmBytes: wasm.length, wasmSha256: sha(wasm), mainBytes: main.length, mainSha256: sha(main) }));
