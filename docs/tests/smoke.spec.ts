import { test, expect } from '@playwright/test';

const BASE = '/cyberbaser';

test.describe('Smoke', () => {
  test('splash loads and has rotating hero', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle(/Cyberbaser/);
    // Rotating-text wrapper from the hero
    await expect(page.locator('.cb-rotate-wrap')).toBeVisible();
    // CTA buttons render
    await expect(page.getByRole('link', { name: /Read the vision/i })).toBeVisible();
    // Architecture stack SVG renders
    await expect(page.locator('.cb-stack-svg')).toBeVisible();
  });

  test('announcement banner renders', async ({ page }) => {
    await page.goto(`${BASE}/`);
    // Starlight-announcement injects into its own class
    await expect(page.locator('.sl-announcement-text')).toBeVisible();
  });

  test('top nav renders', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const nav = page.locator('header nav');
    await expect(nav).toBeVisible();
  });

  test('search button is present', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const searchButton = page.locator('site-search button, button[data-open-modal]');
    await expect(searchButton.first()).toBeVisible();
  });

  test('sidebar navigation present on content pages', async ({ page }) => {
    await page.goto(`${BASE}/getting-started/`);
    const sidebar = page.locator('#starlight__sidebar, aside nav, nav ul');
    await expect(sidebar.first()).toBeVisible();
  });
});

test.describe('Key content pages render', () => {
  const pages: [string, string | RegExp][] = [
    ['/getting-started/', /Getting Started/i],
    ['/getting-started/vision/', /Vision/i],
    ['/getting-started/principles/', /Principles/i],
    ['/getting-started/roadmap/', /Roadmap/i],
    ['/concepts/', /Concepts/i],
    ['/concepts/problem/', /Problem/i],
    ['/concepts/ecosystem/', /Ecosystem/i],
    ['/concepts/primitives/', /First-Principles Primitives/i],
    ['/design/', /Design/i],
    ['/design/architecture/', /Architecture/i],
    ['/design/translation-layer/', /Translation Layer/i],
    ['/design/contribution-workflows/', /Contribution Workflows/i],
    ['/research/', /Research/i],
    ['/research/prior-art/', /Prior Art/i],
    ['/reference/', /Reference/i],
    ['/reference/open-questions/', /Open Questions/i],
    ['/reference/tradeoffs/', /Trade-offs/i],
    ['/reference/existing-work/', /Existing Work/i],
    ['/development/', /Development/i],
  ];

  for (const [path, heading] of pages) {
    test(`${path} renders with correct h1`, async ({ page }) => {
      const res = await page.goto(`${BASE}${path}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1').first()).toContainText(heading);
    });
  }
});

test.describe('Rich content fixtures (custom components)', () => {
  test('problem page has the triangle diagram', async ({ page }) => {
    await page.goto(`${BASE}/concepts/problem/`);
    await expect(page.locator('.cb-triangle-svg')).toBeVisible();
  });

  test('architecture page has the arch diagram', async ({ page }) => {
    await page.goto(`${BASE}/design/architecture/`);
    await expect(page.locator('.cb-arch-svg')).toBeVisible();
  });

  test('ecosystem page has layered stack', async ({ page }) => {
    await page.goto(`${BASE}/concepts/ecosystem/`);
    await expect(page.locator('.cb-layers')).toBeVisible();
  });

  test('translation layer page has tier tables', async ({ page }) => {
    await page.goto(`${BASE}/design/translation-layer/`);
    await expect(page.locator('.cb-tier').first()).toBeVisible();
    await expect(page.locator('.cb-tier-1')).toBeVisible();
    await expect(page.locator('.cb-tier-2')).toBeVisible();
    await expect(page.locator('.cb-tier-3')).toBeVisible();
  });

  test('primitives page has definition blocks', async ({ page }) => {
    await page.goto(`${BASE}/concepts/primitives/`);
    await expect(page.locator('.cb-def').first()).toBeVisible();
  });
});

test.describe('Theme / palette', () => {
  // Force dark mode for these tests — Starlight respects prefers-color-scheme
  test.use({ colorScheme: 'dark' });

  test('dark-mode silver base is applied', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const accent = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--sl-color-accent').trim();
    });
    // In dark mode our accent should be #10b981
    expect(accent.toLowerCase().replace('#', '')).toBe('10b981');
  });

  test('dark-mode background is near-black silver', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const black = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--sl-color-black').trim();
    });
    expect(black.toLowerCase().replace('#', '')).toBe('0a0e14');
  });
});

test.describe('Theme / light mode', () => {
  test.use({ colorScheme: 'light' });

  test('light-mode accent is darker emerald', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const accent = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--sl-color-accent').trim();
    });
    // Light mode accent is #059669
    expect(accent.toLowerCase().replace('#', '')).toBe('059669');
  });
});
