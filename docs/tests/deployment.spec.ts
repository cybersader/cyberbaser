import { test, expect } from '@playwright/test';

/**
 * Deployment verification tests
 * Run against live site: TEST_URL=https://test.cyberbaser.com bun run test:e2e
 */

test.describe('Deployment Verification', () => {
  test('site is accessible', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('no console errors on homepage', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors (if any)
    const criticalErrors = errors.filter(e => !e.includes('favicon'));
    expect(criticalErrors).toHaveLength(0);
  });

  test('critical assets load', async ({ page }) => {
    const failedRequests: string[] = [];

    page.on('requestfailed', request => {
      failedRequests.push(request.url());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(failedRequests).toHaveLength(0);
  });

  test('pages have proper meta tags', async ({ page }) => {
    await page.goto('/');

    // Check essential meta tags
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toBeTruthy();

    const title = await page.title();
    expect(title).toContain('Cyberbase');
  });

  test('HTTPS redirect works', async ({ page, baseURL }) => {
    // Only test on production URLs
    if (baseURL?.includes('localhost')) {
      test.skip();
    }

    const response = await page.goto(baseURL?.replace('https://', 'http://') || '/');
    expect(response?.url()).toMatch(/^https:/);
  });
});
