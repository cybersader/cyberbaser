import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Cyberbase/);
    await expect(page.locator('text=Welcome to Cyberbase')).toBeVisible();
  });

  test('knowledge base loads', async ({ page }) => {
    await page.goto('/kb/');
    await expect(page.locator('text=Knowledge Base')).toBeVisible();
  });

  test('navigation works', async ({ page }) => {
    await page.goto('/');

    // Click on "Explore Knowledge Base" link
    await page.click('text=Explore Knowledge Base');
    await expect(page).toHaveURL(/\/kb/);
  });

  test('search is accessible', async ({ page }) => {
    await page.goto('/');

    // Starlight search button should be present
    const searchButton = page.locator('[data-pagefind-ui], button:has-text("Search"), [aria-label*="Search"]');
    await expect(searchButton.first()).toBeVisible();
  });

  test('theme toggle works', async ({ page }) => {
    await page.goto('/');

    // Find and click theme toggle
    const themeButton = page.locator('starlight-theme-select, [data-theme-toggle]').first();
    if (await themeButton.isVisible()) {
      await themeButton.click();
      // Theme should change (check for data-theme attribute or class change)
    }
  });
});

test.describe('Content Tests', () => {
  test('edit link present on KB pages', async ({ page }) => {
    await page.goto('/kb/');

    // Starlight adds edit links
    const editLink = page.locator('a:has-text("Edit"), a[href*="github.com"][href*="edit"]');
    await expect(editLink.first()).toBeVisible();
  });

  test('sidebar navigation present', async ({ page }) => {
    await page.goto('/kb/');

    // Starlight sidebar
    const sidebar = page.locator('nav[aria-label*="Main"], .sidebar, [data-sidebar]');
    await expect(sidebar.first()).toBeVisible();
  });
});
