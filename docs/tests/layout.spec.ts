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
    ['/design/architecture/', '.cb-hub'],
    ['/design/architecture/', '.cb-step'],
    ['/design/architecture/', '.cb-glance'],
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
