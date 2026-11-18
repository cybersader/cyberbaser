// Export the canonical figures for viewers that do not compile MDX/Astro.
// Run from the repo root: build-contained -- bun docs/scripts/export-community-diagrams.mjs
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const docs = fileURLToPath(new URL('../', import.meta.url));
const source = join(docs, 'src/components/community-diagrams');
const assets = join(docs, 'src/assets/community-diagrams');
const publicDir = join(docs, 'public/community-diagrams');
const kinds = ['journey', 'trust', 'authority', 'horizons'];
const css = await readFile(join(source, 'diagrams.css'), 'utf8');
const brand = await readFile(join(docs, 'src/styles/brand.css'), 'utf8');
const light = brand.match(/^:root\[data-theme='light'\] \{([\s\S]*?)^\}/m)?.[1];
if (!light) throw new Error('Missing canonical light palette');
const names = ['white', 'gray-1', 'gray-2', 'gray-4', 'gray-6', 'black', 'accent-high', 'accent-low'];
const palette = names.map(name => {
  const value = light.match(new RegExp(`--sl-color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))?.[1];
  if (!value) throw new Error(`Missing literal token ${name}`);
  return `--sl-color-${name}: ${value};`;
}).join('\n');
const theme = `:root { ${palette}
  --sl-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --sl-font-mono: ui-monospace, monospace;
  color-scheme: only light;
}
html { background: var(--sl-color-black); color: var(--sl-color-white); font: 16px/1.5 var(--sl-font); }
body { margin: 0; padding: 24px; background: var(--sl-color-black); color: var(--sl-color-white); }
* { box-sizing: border-box; }
.cb-map { margin: 0; padding: 16px; background: var(--sl-color-black); }
.cb-map-description, .cb-map-scroll-hint { display: none !important; }
`;
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const document = (styles, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cyberbaser community diagrams</title><style>${styles}</style></head><body>${body}</body></html>`;
await mkdir(assets, { recursive: true });
await mkdir(publicDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const receipt = { format: 1, renderer: 'Playwright Chromium', imageScale: 2, figures: [], portableChecks: [] };
const figures = new Map();
try {
  const context = await browser.newContext({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  // Fully local authored markup. A render must never need a network resource.
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  for (const kind of kinds) {
    const template = await readFile(join(source, `${kind}.html`), 'utf8');
    await page.setContent(document(`${css}\n${theme}`, template));
    await page.evaluate(() => document.fonts.ready);
    const info = await page.locator('figure').evaluate(el => {
      const drawing = el.querySelector('.cb-map-drawing');
      const issues = [];
      if (drawing) {
        for (const text of drawing.querySelectorAll('text')) {
          const box = text.getBBox();
          if (box.x < 0 || box.x + box.width > drawing.viewBox.baseVal.width + 1) issues.push(text.textContent);
        }
      }
      return {
        title: el.querySelector('figcaption strong').textContent,
        explanation: el.querySelector('details p').textContent,
        background: getComputedStyle(el).backgroundColor,
        color: getComputedStyle(el).color,
        hostForeground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        labelsOutside: issues,
      };
    });
    if (info.hostForeground || info.pageOverflow || info.labelsOutside.length) throw new Error(JSON.stringify({ kind, ...info }));
    if (info.background !== 'rgb(250, 251, 252)' || info.color !== 'rgb(10, 14, 20)') throw new Error(`Unexpected export colors: ${JSON.stringify(info)}`);
    const png = await page.locator('figure').screenshot({ type: 'png', omitBackground: false });
    const filename = `${kind}.png`;
    await writeFile(join(assets, filename), png);
    const record = { kind, ...info, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
    receipt.figures.push(record);
    figures.set(kind, { ...record, data: `data:image/png;base64,${png.toString('base64')}` });
  }
  const portableStyle = `${theme}
body { max-width: 1080px; margin: 0 auto; padding: clamp(12px, 3vw, 32px); }
h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 12px; }
p { max-width: 72ch; }
figure { margin: 28px 0 40px; }
img { display: block; width: 100%; height: auto; background: var(--sl-color-black); }
details { border-top: 1px solid var(--sl-color-gray-4); padding: 12px 0; }
summary { cursor: pointer; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--sl-color-accent-high); outline-offset: 4px; }
a { color: var(--sl-color-accent-high); }
.full-size { overflow-x: auto; margin-top: 16px; }
.full-size img { width: 992px; max-width: none; }
`;
  for (const [name, group] of [
    ['community-model', ['journey', 'trust']],
    ['community-system', ['authority', 'horizons']],
  ]) {
    const body = `<h1>${name === 'community-model' ? 'Community contribution model' : 'Community system design'}</h1><p>Portable review copy. The colors, fonts and images do not depend on the viewer. The full diagram fits below; open its full-size view for readable labels on a phone.</p>` + group.map(kind => {
      const f = figures.get(kind);
      return `<figure><img src="${f.data}" alt="${escape(f.title)}"><details><summary>Read the explanation</summary><p>${escape(f.explanation)}</p></details><details><summary>Open full-size diagram</summary><div class="full-size"><img src="${f.data}" alt="${escape(f.title)}"></div></details></figure>`;
    }).join('');
    const html = document(portableStyle, body);
    await writeFile(join(publicDir, `${name}.html`), html);
    for (const width of [390, 1040]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(html);
      await page.locator('body > figure > img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
      const check = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        imagesReady: [...document.querySelectorAll('body > figure > img')].every(img => img.complete && img.naturalWidth > 0),
        background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
        hostForeground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
      }));
      if (check.pageOverflow || !check.imagesReady || check.hostForeground || check.background !== 'rgb(250, 251, 252)' || check.color !== 'rgb(10, 14, 20)') throw new Error(JSON.stringify({ name, width, ...check }));
      receipt.portableChecks.push({ name, width, ...check });
    }
  }
  await context.close();
} finally {
  await browser.close();
}
await writeFile(join(assets, 'export-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ images: receipt.figures.map(({ kind, bytes }) => ({ kind, bytes })), checks: receipt.portableChecks }, null, 2));
