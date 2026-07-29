import { test, expect } from '@playwright/test';

const BASE = '/cyberbaser';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1024, height: 1080 } });

test('homepage remains responsive without initializing the site graph', async ({ page }) => {
  test.setTimeout(90000);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.addInitScript(() => {
    const diagnostics = {
      heartbeatLags: [] as number[],
      intervals: [] as number[],
      longTasks: [] as number[],
    };
    Object.assign(globalThis, { __cyberbaserStability: diagnostics });

    const nativeSetInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      diagnostics.intervals.push(Number(delay));
      return nativeSetInterval(callback, delay, ...args);
    }) as typeof globalThis.setInterval;

    let expected = performance.now() + 100;
    nativeSetInterval(() => {
      const now = performance.now();
      diagnostics.heartbeatLags.push(now - expected);
      expected = now + 100;
    }, 100);

    try {
      new PerformanceObserver((list) => {
        diagnostics.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Long-task observation is supplementary; the heartbeat still detects stalls.
    }
  });

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await expect(page.locator('graph-component, .slsg-graph-skeleton, graph-component canvas')).toHaveCount(0);

  const searchButton = page.locator('button[data-open-modal], site-search button').first();
  const themeToggle = page.locator('astro-theme-toggle[role="button"]').first();
  await expect(searchButton).toBeVisible();
  await expect(themeToggle).toBeVisible();

  for (let iteration = 0; iteration < 9; iteration += 1) {
    await page.evaluate((down) => {
      window.scrollTo({ top: down ? document.documentElement.scrollHeight : 0, behavior: 'instant' });
    }, iteration % 2 === 0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    if (iteration === 2 || iteration === 6) {
      await searchButton.click();
      await expect(page.locator('dialog[open]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    }

    if (iteration === 4 || iteration === 8) {
      const before = await page.locator('html').getAttribute('data-theme');
      await themeToggle.click();
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).not.toBe(before);
    }

    await page.waitForTimeout(5000);
  }

  const diagnostics = await page.evaluate(() => {
    const data = (globalThis as typeof globalThis & {
      __cyberbaserStability: {
        heartbeatLags: number[];
        intervals: number[];
        longTasks: number[];
      };
    }).__cyberbaserStability;
    return {
      maxHeartbeatLag: Math.max(0, ...data.heartbeatLags),
      maxLongTask: Math.max(0, ...data.longTasks),
      rotatingIntervals: data.intervals.filter((delay) => delay === 2500).length,
      samples: data.heartbeatLags.length,
    };
  });

  expect(errors).toEqual([]);
  expect(diagnostics.samples).toBeGreaterThan(400);
  expect(diagnostics.rotatingIntervals).toBe(1);
  expect(diagnostics.maxLongTask).toBeLessThan(500);
  expect(diagnostics.maxHeartbeatLag).toBeLessThan(750);
});

test('standard pages retain backlinks without loading the WebGL graph', async ({ page }) => {
  await page.setViewportSize({ width: 1272, height: 1080 });
  await page.goto(`${BASE}/getting-started/`, { waitUntil: 'networkidle' });

  await expect(page.locator('.slsg-backlinks-panel')).toHaveCount(1);
  await expect(page.locator('graph-component, .slsg-graph-skeleton, graph-component canvas')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(customElements.get('graph-component')))).toBe(false);
});
