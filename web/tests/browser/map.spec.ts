import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  if (process.env.FLATSERVE_LIVE_BASEMAP === '1') return;
  // Keep browser tests independent of the public demo tile service.
  await page.route('https://demotiles.maplibre.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background',
      paint: { 'background-color': '#dce6ed' } }] },
  }));
});

test('connects, streams stations, caches filters through camera moves, and prompts again on reload', async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/fgb/')) requests.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('API URL', { exact: true })).toHaveValue('http://localhost:5220');
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const select = page.getByLabel('Brannvesen', { exact: true });
  await expect(select.locator('option', { hasText: 'Oslo brann- og redningsetat' })).toHaveCount(1);
  await select.selectOption({ label: 'Oslo brann- og redningsetat' });
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  const requestCount = requests.length;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(700);
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  expect(requests).toHaveLength(requestCount);
  await select.selectOption({ label: 'Kristiansandsregionen BR' });
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  await select.selectOption({ label: 'Oslo brann- og redningsetat' });
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  expect(requests.filter((url) => url.includes('/filter?'))).toHaveLength(2);
  await select.selectOption('');
  await expect.poll(() => requests.filter((url) => url.includes('/collection?')).length).toBeGreaterThan(2);
  await expect(page.getByRole('status')).toHaveText(/\d+ features in view/);
  await expect.poll(async () => Number((await page.getByRole('status').innerText()).split(' ')[0]),
    { message: 'The zoomed viewport should return a subset of the dataset.' }).toBeLessThan(639);
  expect(requests.filter((url) => new URL(url).searchParams.get('minX') === '-180')).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/map.png' });
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('validates the URL and changes a connection while preserving its base path', async ({ page }) => {
  await page.goto('./');
  const input = page.getByLabel('API URL', { exact: true });
  await input.fill('ftp://example.org');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter an absolute HTTP(S) API URL.');
  await input.fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  const paths: string[] = [];
  await page.route('http://localhost:5221/proxy/v1/**', async (route) => {
    const original = new URL(route.request().url());
    paths.push(original.pathname);
    const response = await route.fetch({ url: `http://localhost:5221${original.pathname.replace('/proxy/v1', '')}${original.search}` });
    await route.fulfill({ response });
  });
  await input.fill('http://localhost:5221/proxy/v1');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await expect(page.locator('.api-url')).toHaveText('http://localhost:5221/proxy/v1/');
  await expect.poll(() => paths.length).toBeGreaterThanOrEqual(2);
  expect(paths.every((path) => path === '/proxy/v1/fgb/collection')).toBe(true);
});

test('fits on a phone viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('./');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('shows empty results, reports request errors, and retries', async ({ page }) => {
  let mode: 'empty' | 'error' | 'success' = 'empty';
  await page.route('http://localhost:5221/fgb/collection?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('minX') === '-180' || mode === 'success') {
      await route.continue();
    } else if (mode === 'error') {
      await route.fulfill({ status: 503, body: 'Unavailable', headers: { 'Access-Control-Allow-Origin': '*' } });
    } else {
      const response = await route.fetch({ url: 'http://localhost:5221/fgb/collection?minX=-1&minY=-1&maxX=1&maxY=1' });
      await route.fulfill({ response });
    }
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('No features found.');
  mode = 'error';
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('API returned HTTP 503.');
  mode = 'success';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/\d+ features in view/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
