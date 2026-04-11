// Visual-regression screenshot capture — NOT an assertion test.
// Run with:   bunx playwright test tests/screenshots.spec.ts --reporter=list
// Output:     test-results/screenshots/*.png
//
// This spec exists so we can drive the dev site through real Playwright
// (reliable, reproducible, commit-able) instead of MCP browser tools for
// design iteration. It captures key pages in both dark and light mode at
// a consistent desktop width so diffs are legible.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = '/cyberbaser';
const OUT = resolve(process.cwd(), 'test-results/screenshots');

mkdirSync(OUT, { recursive: true });

const pages = [
  { slug: '', name: 'home' },
  { slug: '/getting-started/', name: 'getting-started' },
  { slug: '/getting-started/vision/', name: 'vision' },
  { slug: '/getting-started/principles/', name: 'principles' },
  { slug: '/getting-started/roadmap/', name: 'roadmap' },
  { slug: '/concepts/', name: 'concepts' },
  { slug: '/concepts/problem/', name: 'problem' },
  { slug: '/concepts/ecosystem/', name: 'ecosystem' },
  { slug: '/concepts/primitives/', name: 'primitives' },
  { slug: '/design/architecture/', name: 'architecture' },
  { slug: '/design/translation-layer/', name: 'translation-layer' },
  { slug: '/design/contribution-workflows/', name: 'contribution-workflows' },
  { slug: '/research/prior-art/', name: 'prior-art' },
  { slug: '/reference/open-questions/', name: 'open-questions' },
  { slug: '/reference/tradeoffs/', name: 'tradeoffs' },
  { slug: '/agent-context/', name: 'agent-context' },
  { slug: '/agent-context/zz-log/', name: 'zz-log' },
  { slug: '/agent-context/zz-log/2026-04-11-reinit-and-docs-site/', name: 'zz-log-reinit' },
  { slug: '/agent-context/zz-challenges/', name: 'zz-challenges' },
  { slug: '/agent-context/zz-challenges/mdx-auto-wrapping/', name: 'zz-challenges-mdx' },
  { slug: '/agent-context/zz-challenges/translation-layer-round-trip-enforcement/', name: 'zz-challenges-roundtrip' },
];

// Hide the Astro dev toolbar (it's position:fixed and gets captured in
// full-page screenshots as a floating pill, looking like broken UI).
const HIDE_DEV_TOOLBAR_CSS = `
  astro-dev-toolbar, #dev-toolbar-root, dev-toolbar { display: none !important; }
`;

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`Screenshots · ${scheme}`, () => {
    test.use({
      colorScheme: scheme,
      viewport: { width: 1440, height: 900 },
    });

    for (const { slug, name } of pages) {
      test(`${name} (${scheme})`, async ({ page }) => {
        await page.goto(`${BASE}${slug}`);
        // Force theme cookie so Starlight picks it up consistently
        await page.evaluate((s) => {
          document.documentElement.setAttribute('data-theme', s);
          localStorage.setItem('starlight-theme', s);
        }, scheme);
        // Re-navigate so the theme applies from the server-rendered HTML
        await page.reload();
        // Suppress the Astro dev toolbar in full-page screenshots
        await page.addStyleTag({ content: HIDE_DEV_TOOLBAR_CSS });
        // Wait for the rotating-text element on home, or h1 elsewhere
        if (name === 'home') {
          await page.waitForSelector('.cb-rotate-wrap', { state: 'visible' });
          // Give the headline gradient fonts time to settle
          await page.waitForTimeout(500);
        } else {
          await page.waitForSelector('h1', { state: 'visible' });
        }
        await page.screenshot({
          path: `${OUT}/${name}.${scheme}.png`,
          fullPage: true,
        });
      });
    }
  });
}
