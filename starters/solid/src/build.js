import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import solidPreset from 'babel-preset-solid';
import { renderToString } from 'solid-js/web';
import { buildPaths, rasterValidator, readInput, scanTree } from './tree.js';
import { parseNote, renderMarkdown } from './markdown.js';
import { assertDistinctOutputs, CATALOG, CSS, HOME, MANIFEST, makeResolver, urlPath } from './routes.js';

// Compile only trusted starter components, from this directory. Projected Markdown
// and assets are data, never JSX or compiler inputs. No hydration/client bundle.
const srcDir = fileURLToPath(new URL('./', import.meta.url));
Bun.plugin({
  name: 'starter-solid-ssr',
  setup(builder) {
    builder.onLoad({ filter: /\.jsx$/ }, ({ path: filename }) => {
      if (!filename.startsWith(srcDir)) return undefined;
      const { code } = transformSync(readFileSync(filename, 'utf8'), {
        filename, babelrc: false, configFile: false,
        presets: [[solidPreset, { generate: 'ssr', hydratable: false }]],
      });
      return { contents: code, loader: 'js' };
    });
  },
});

async function build(inputArg, outputArg) {
  const { input, output } = buildPaths(inputArg, outputArg);
  const files = scanTree(input);
  const notes = [];
  const assets = [];
  const groups = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let skippedAssets = 0;
  for (const file of files) {
    if (/\.md$/i.test(file.relative)) {
      const bytes = readInput(file);
      let text;
      try { text = decoder.decode(bytes); }
      catch { throw new Error(`invalid UTF-8 in ${JSON.stringify(file.relative)}`); }
      const note = parseNote(file.relative, text);
      notes.push(note);
      const folder = path.posix.dirname(note.source);
      const key = folder === '.' ? '' : folder;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    } else {
      const validate = rasterValidator(file);
      if (validate) assets.push({ ...file, file: `_media/${file.relative}`, validate });
      else skippedAssets++;
    }
  }
  const hasHome = notes.some((note) => note.file === HOME);
  assertDistinctOutputs([
    CATALOG, CSS, MANIFEST, ...(!hasHome ? [HOME] : []),
    ...notes.map((note) => note.file), ...assets.map((asset) => asset.file),
  ]);
  const resolve = makeResolver(notes, assets);
  const { NotePage, CatalogPage } = await import('./Page.jsx');
  const css = readFileSync(path.join(srcDir, CSS));

  // A non-recursive exclusive mkdir protects against an output created between the
  // initial check and this write. No output or input is cleaned or overwritten.
  mkdirSync(output);
  const put = (file, content) => {
    const destination = path.join(output, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: 'wx' });
  };
  const writePage = (file, view) => put(file, `<!doctype html>\n${renderToString(view)}\n`);
  put(CSS, css);
  for (const asset of assets) {
    const bytes = readInput(asset);
    if (!asset.validate(bytes)) throw new Error(`asset changed during build: ${JSON.stringify(asset.relative)}`);
    put(asset.file, bytes);
  }
  const groupOrder = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1);
  const catalog = (file) => writePage(file, () => CatalogPage({ file, groups: groupOrder, count: notes.length }));
  catalog(CATALOG);
  if (!hasHome) catalog(HOME);
  for (const note of notes) {
    const markdownHtml = renderMarkdown(note, resolve);
    writePage(note.file, () => NotePage({ note, markdownHtml }));
  }
  // Write only after all pages were successfully emitted. Values are relative to
  // this output root; an empty build still contains the catalog and manifest.
  put(MANIFEST, `${JSON.stringify(notes.map(({ source, file }) => ({ source, file, url: urlPath(file) })), null, 2)}\n`);
  console.log(`Solid reader: ${notes.length} notes, ${assets.length} images, ${skippedAssets} skipped assets`);
}

if (process.argv.length !== 4) {
  console.error('Usage: bun run --cwd starters/solid build <projected-dir> <fresh-output-dir>');
  process.exitCode = 1;
} else {
  try { await build(process.argv[2], process.argv[3]); }
  catch (error) {
    console.error(`Solid reader build refused: ${error.message}`);
    process.exitCode = 1;
  }
}
