import { test, expect } from '@playwright/test';

const BASE = '/cyberbaser';

/**
 * Regression guard for the recurring Starlight layout bug where custom
 * flex/grid components come out lopsided ("the left box is taller").
 *
 * Root cause: Starlight injects `margin-top` onto consecutive flow elements
 * inside `.sl-markdown-content`. That margin lands on the children of our
 * flex/grid containers and the first child is spared, so the 2nd and 3rd
 * items get shoved down and equal-height breaks. brand.css neutralizes it
 * with `... :is(<containers>) > * { margin-top: 0 }`. See CLAUDE.md
 * "Starlight component layout". These tests fail if that fix regresses.
 */

test.describe('Layout regression: equal-height components', () => {
  test('trust dial segments are equal height and top-aligned', async ({ page }) => {
    await page.goto(`${BASE}/concepts/problem/`);
    const segs = page.locator('.cb-dial-seg');
    await expect(segs.first()).toBeVisible();

    const boxes = await segs.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top) };
      }),
    );

    expect(boxes.length).toBe(3);
    const { h: h0, w: w0, top: top0 } = boxes[0];
    for (const b of boxes) {
      expect(Math.abs(b.h - h0)).toBeLessThanOrEqual(1); // equal height
      expect(Math.abs(b.w - w0)).toBeLessThanOrEqual(1); // equal width
      expect(Math.abs(b.top - top0)).toBeLessThanOrEqual(1); // same row top
    }
  });

  test('is/isn\'t ledger columns are equal height', async ({ page }) => {
    await page.goto(`${BASE}/concepts/problem/`);
    const cols = page.locator('.cb-ledger-col');
    await expect(cols.first()).toBeVisible();
    const heights = await cols.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    expect(heights.length).toBe(2);
    expect(Math.abs(heights[0] - heights[1])).toBeLessThanOrEqual(1);
  });

  const equalGroups: [string, string][] = [
    ['primitives nav chips', '.cb-navchip'],
    ['translation-layer tiers', '.cb-xlate-tier'],
    ['round-trip surfaces', '.cb-trip > .cb-mock'],
  ];
  for (const [name, sel] of equalGroups) {
    test(`${name} are equal height`, async ({ page }) => {
      await page.goto(`${BASE}/concepts/primitives/`);
      const loc = page.locator(sel);
      await expect(loc.first()).toBeVisible();
      const hs = await loc.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(hs.length).toBeGreaterThan(1);
      for (const h of hs) expect(Math.abs(h - hs[0])).toBeLessThanOrEqual(1);
    });
  }

  const principleGroups: [string, string][] = [
    ['principles versus columns', '.cb-versus-col'],
    ['principles path lanes', '.cb-path'],
    ['principles PR gate cards', '.cb-gate-cellwrap'],
  ];
  for (const [name, sel] of principleGroups) {
    test(`${name} are equal height`, async ({ page }) => {
      await page.goto(`${BASE}/getting-started/principles/`);
      const loc = page.locator(sel);
      await expect(loc.first()).toBeVisible();
      const hs = await loc.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(hs.length).toBeGreaterThan(1);
      for (const h of hs) expect(Math.abs(h - hs[0])).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('Layout regression: homepage contribution storyboard', () => {
  for (const width of [360, 390, 768, 899]) {
    test(`storyboard stacks in one aligned column @${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1200 });
      await page.goto(`${BASE}/`);
      const steps = page.locator('.cb-storyboard > .cb-jstep');
      await expect(steps).toHaveCount(4);
      await expect(steps.first()).toBeVisible();

      const boxes = await steps.evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { h: r.height, w: r.width, top: r.top, left: r.left };
        }),
      );

      for (const box of boxes) {
        expect(Math.abs(box.w - boxes[0].w)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.left - boxes[0].left)).toBeLessThanOrEqual(1);
      }
      for (let i = 1; i < boxes.length; i += 1) {
        expect(boxes[i].top).toBeGreaterThan(boxes[i - 1].top + boxes[i - 1].h - 1);
      }
    });
  }

  for (const width of [900, 1280]) {
    test(`storyboard forms balanced two-column rows @${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1200 });
      await page.goto(`${BASE}/`);
      const steps = page.locator('.cb-storyboard > .cb-jstep');
      await expect(steps).toHaveCount(4);
      await expect(steps.first()).toBeVisible();

      const boxes = await steps.evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { h: r.height, w: r.width, top: r.top, left: r.left };
        }),
      );

      for (const [left, right] of [[boxes[0], boxes[1]], [boxes[2], boxes[3]]]) {
        expect(Math.abs(left.w - right.w)).toBeLessThanOrEqual(1);
        expect(Math.abs(left.h - right.h)).toBeLessThanOrEqual(1);
        expect(Math.abs(left.top - right.top)).toBeLessThanOrEqual(1);
        expect(right.left).toBeGreaterThan(left.left + left.w - 1);
      }

      for (const selector of ['.cb-jstep-hd', '.cb-jstep-frame', '.cb-jstep-cap']) {
        const tracks = await page.locator(`.cb-storyboard > .cb-jstep ${selector}`).evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { h: r.height, top: r.top };
          }),
        );
        for (const [left, right] of [[tracks[0], tracks[1]], [tracks[2], tracks[3]]]) {
          expect(Math.abs(left.top - right.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(left.h - right.h)).toBeLessThanOrEqual(1);
        }
      }

      expect(Math.abs(boxes[0].left - boxes[2].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[1].left - boxes[3].left)).toBeLessThanOrEqual(1);
      expect(boxes[2].top).toBeGreaterThan(boxes[0].top + boxes[0].h - 1);
    });
  }
});

test.describe('Layout regression: no horizontal overflow on diagram pages', () => {
  const pages = [
    '/',
    '/concepts/primitives/',
    '/concepts/problem/',
    '/concepts/ecosystem/',
    '/getting-started/principles/',
    '/design/architecture/',
    '/design/translation-layer/',
  ];
  const widths = [360, 390, 768, 899, 900, 1280];
  for (const path of pages) {
    for (const w of widths) {
      test(`${path} has no horizontal scroll @${w}px`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: 1000 });
        await page.goto(`${BASE}${path}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(2);
      });
    }
  }
});

test.describe('Layout regression: no Starlight margin-top leak in components', () => {
  // Direct children of these flex/grid containers must NOT carry Starlight's
  // injected margin-top, or equal-height/alignment breaks again.
  const checks: [string, string][] = [
    ['/concepts/problem/', '.cb-dial-bar'],
    ['/concepts/problem/', '.cb-dial-seg'],
    ['/concepts/problem/', '.cb-ledger'],
    ['/concepts/problem/', '.cb-ledger-col'],
    ['/concepts/problem/', '.cb-wins'],
    ['/concepts/ecosystem/', '.cb-tools'],
    ['/concepts/ecosystem/', '.cb-tool'],
    ['/concepts/ecosystem/', '.cb-tool-hd'],
    ['/concepts/primitives/', '.cb-grid-nav'],
    ['/concepts/primitives/', '.cb-ssot'],
    ['/concepts/primitives/', '.cb-xlate'],
    ['/concepts/primitives/', '.cb-xlate-tiers'],
    ['/concepts/primitives/', '.cb-trip'],
    ['/concepts/primitives/', '.cb-openauth'],
    ['/getting-started/principles/', '.cb-own'],
    ['/getting-started/principles/', '.cb-own-trapped'],
    ['/getting-started/principles/', '.cb-rt-pair'],
    ['/getting-started/principles/', '.cb-versus'],
    ['/getting-started/principles/', '.cb-paths'],
    ['/getting-started/principles/', '.cb-shed'],
    ['/getting-started/principles/', '.cb-gate'],
    ['/', '.cb-storyboard'],
    ['/', '.cb-storyboard .cb-jstep'],
    ['/', '.cb-rich-toolbar'],
    ['/', '.cb-rich-foot'],
    ['/design/architecture/', '.cb-journey-4'],
    ['/design/architecture/', '.cb-jstep'],
    ['/design/architecture/', '.cb-glance'],
    ['/design/translation-layer/', '.cb-tl-splice'],
  ];

  for (const [path, container] of checks) {
    test(`${container} children have no leaked margin-top (${path})`, async ({ page }) => {
      await page.goto(`${BASE}${path}`);
      const c = page.locator(container).first();
      await expect(c).toBeVisible();

      const margins = await c.evaluate((el) =>
        Array.from(el.children).map((ch) => getComputedStyle(ch).marginTop),
      );

      expect(margins.length).toBeGreaterThan(0);
      for (const m of margins) {
        expect(m).toBe('0px');
      }
    });
  }
});
