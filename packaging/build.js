#!/usr/bin/env bun
// Build the one Cyberbaser program: `bun packaging/build.js [--target bun-linux-x64] [--outfile path]`.
//
// The wrapped entry points are compiled unchanged. Two things differ inside a
// compiled program and are handled here, at build time, not in the sources:
//   - `import.meta.url` would point into the embedded file system, so modules
//     that find files beside themselves (public pages, the renderer, the
//     project root) are given their real installed location instead;
//   - `import.meta.main` is true only for the program's own entry, so each
//     wrapped entry point runs its main block when its mode selects it.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');
const ENTRY = path.join(REPO, 'packaging', 'src', 'cli.js');

function parseArgs(argv) {
  const options = { target: null, outfile: path.join(REPO, 'packaging', 'dist', 'cyberbaser'), entry: ENTRY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target' && argv[i + 1]) options.target = argv[++i];
    else if (argv[i] === '--outfile' && argv[i + 1]) options.outfile = path.resolve(argv[++i]);
    else if (argv[i] === '--entry' && argv[i + 1]) options.entry = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

// Only first-party sources are rewritten; dependencies (including the Iroh
// native loader) are bundled exactly as published.
const FIRST_PARTY = /\/(apps|packages)\/[^/]+\/(src|bin)\/.*\.js$/u;

export function relocateImportMeta(source, relativePath) {
  const id = JSON.stringify(relativePath);
  return source
    .replaceAll('import.meta.url', `globalThis.__cyberbaserModuleUrl(${id})`)
    .replaceAll('import.meta.main', `(globalThis.__cyberbaserEntry === ${id})`);
}

export const relocationPlugin = {
  name: 'cyberbaser-relocate-import-meta',
  setup(build) {
    build.onLoad({ filter: FIRST_PARTY }, async ({ path: file }) => {
      if (file.includes('/node_modules/')) return undefined;
      const source = await Bun.file(file).text();
      if (!source.includes('import.meta')) return undefined;
      const relative = path.relative(REPO, file).split(path.sep).join('/');
      return { contents: relocateImportMeta(source, relative), loader: 'js' };
    });
  },
};

// The files the installed program reads from disk: its web pages, the
// renderer, and the sources the private site's identity check hashes. Tracked
// and new (not ignored) files only, so local dependency folders never ship.
export const RESOURCE_PATHS = Object.freeze([
  'apps/owner-alpha/src', 'apps/owner-alpha/public', 'renderers/quartz-cyberbase',
  ...['correction', 'linkcheck', 'ofm', 'projection', 'proposal', 'proposal-queue', 'proposal-review', 'publish', 'trust']
    .map((name) => `packages/${name}/src`),
]);
export const RESOURCES_TAR = path.join(REPO, 'packaging', 'dist', 'resources.tar');

export async function packResources(file = RESOURCES_TAR) {
  const listed = Bun.spawnSync(['git', '-C', REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...RESOURCE_PATHS]);
  if (listed.exitCode !== 0) throw new Error('git ls-files failed');
  const names = listed.stdout.toString().split('\0').filter((name) => name && !name.includes('/node_modules/'))
    .filter((name) => existsSync(path.join(REPO, name)));
  const stage = await mkdtemp(path.join(os.tmpdir(), 'cyberbaser-resources-'));
  try {
    await writeFile(path.join(stage, '.gitignore'), '.workspace/\n');
    const tar = Bun.spawnSync(['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '--mode=u+rw,go+r,go-w', '-cf', file, '-C', stage, '.gitignore', '-C', REPO, '--null', '-T', '-'],
    { stdin: Buffer.from(`${names.join('\0')}\0`) });
    if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { file, files: names.length + 1 };
}

export async function buildProgram({ target = null, outfile, entry = ENTRY } = {}) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await packResources();
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { outfile, ...(target ? { target } : {}) },
    minify: false,
    sourcemap: 'none',
    plugins: [relocationPlugin],
    define: { 'process.env.CYBERBASER_BUILD_TARGET': JSON.stringify(target ?? `bun-${process.platform}-${process.arch}`) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('build failed');
  }
  return { outfile, milliseconds: Math.round(performance.now() - started) };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const { outfile, milliseconds } = await buildProgram(options);
  const written = existsSync(outfile) ? outfile : `${outfile}.exe`;
  const size = Bun.file(written).size;
  console.log(`built ${path.relative(process.cwd(), written)} (${(size / 1024 / 1024).toFixed(1)} MB) in ${milliseconds} ms`);
}
