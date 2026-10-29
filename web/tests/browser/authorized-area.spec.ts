import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { moveOnMap, test } from './helpers';

const api = 'http://localhost:5221';
const areaButton = (page: Page) => page.getByRole('button', { name: 'Show authorized area', exact: true });
const userSelect = (page: Page) => page.getByLabel('Select user', { exact: true });
const polygon = {
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[[5, 58], [30, 58], [30, 71], [5, 71], [5, 58]]] },
};

// Check rendered colors on the canvas, independently of DOM controls and labels.
async function mapPixels(page: Page) {
  const screenshot = await page.locator('.maplibregl-canvas').screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return [[56, 189, 248], [17, 33, 40], [22, 163, 74], [239, 68, 68], [255, 255, 255]].map((color) => {
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (color.every((channel, index) => Math.abs(data[i + index] - channel) <= 2)) count++;
      }
      return count;
    });
  }, screenshot.toString('base64'));
}

async function connect(page: Page) {
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background',
      paint: { 'background-color': '#0c0c0c' } }] },
  }));
});

test('keyboard toggle below the user, cached rendering, camera and settings preservation, filters, movement and resets', async ({ page }) => {
  const requests: URL[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/fgb/')) requests.push(new URL(request.url()));
  });
  await page.goto('./');
  const toggle = areaButton(page);
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await connect(page);
  await expect(toggle).toBeDisabled();
  await userSelect(page).selectOption('0');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/);
  await expect(toggle).toBeEnabled();
  const userBox = (await userSelect(page).boundingBox())!;
  const toggleBox = (await toggle.boundingBox())!;
  expect(toggleBox.y).toBeGreaterThanOrEqual(userBox.y + userBox.height);
  const bbox = page.getByRole('button', { name: 'BBox', exact: true });
  const buffer = page.getByRole('button', { name: 'Buffer', exact: true });
  const showBuffer = page.getByRole('button', { name: 'Show buffer', exact: true });
  await bbox.click();
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await showBuffer.click();
  await expect.poll(async () => (await mapPixels(page))[3]).toBeGreaterThan(100);
  const before = await mapPixels(page);
  const stationStatus = await page.getByRole('status').innerText();
  const timingCount = await page.locator('.timings-point').count();
  const requestCount = requests.length;
  expect(requests.filter((url) => url.pathname.includes('auth-polygon'))).toHaveLength(0);
  await userSelect(page).focus();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await mapPixels(page))[0]).toBeGreaterThan(20);
  const shown = await mapPixels(page);
  expect(shown[1]).toBeGreaterThan(20); // 12% cyan fill on the dark basemap.
  expect(shown.slice(2, 4)).toEqual(before.slice(2, 4)); // BBox and buffer remain above the area.
  expect(requests).toHaveLength(requestCount + 1);
  expect(requests.at(-1)!.pathname).toBe('/fgb/auth-polygon/0');
  await expect(page.locator('.timings-point')).toHaveCount(timingCount);
  await expect(page.getByRole('status')).toHaveText(stationStatus);
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await mapPixels(page)).toEqual(before);
  await toggle.click();
  expect(await mapPixels(page)).toEqual(shown);
  expect(requests).toHaveLength(requestCount + 1);
  await expect(bbox).toHaveAttribute('aria-pressed', 'true');
  await expect(buffer).toHaveAttribute('aria-pressed', 'true');
  await expect(showBuffer).toHaveAttribute('aria-pressed', 'true');

  const attribute = page.getByLabel('Brannvesen', { exact: true });
  const filter = page.getByRole('button', { name: 'Filter', exact: true });
  await attribute.selectOption({ label: 'Oslo brann- og redningsetat' });
  await filter.click();
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  await expect(toggle).toBeEnabled();
  expect((await mapPixels(page))[0]).toBeGreaterThan(20);
  for (const id of ['1', '2']) {
    await userSelect(page).selectOption(id);
    await expect.poll(() => requests.filter((url) => url.pathname === `/fgb/auth-polygon/${id}`).length).toBe(1);
    await expect(page.getByText('Loading authorized area…')).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('7 features matching filter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(attribute).toHaveValue('Oslo brann- og redningsetat');
  }
  const areaCount = requests.filter((url) => url.pathname.includes('auth-polygon')).length;
  await moveOnMap(page, .5, .5);
  await page.mouse.down();
  await moveOnMap(page, .6, .55, 8);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(500);
  expect(requests.filter((url) => url.pathname.includes('auth-polygon'))).toHaveLength(areaCount);
  await toggle.click();
  await toggle.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  expect(requests.filter((url) => url.pathname.includes('auth-polygon'))).toHaveLength(areaCount);
  await page.locator('.connection-heading button').click();
  await connect(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toBeDisabled();
  expect((await mapPixels(page))[0]).toBe(0);
  await userSelect(page).selectOption('0');
  await toggle.click();
  await expect.poll(() => requests.filter((url) => url.pathname === '/fgb/auth-polygon/0').length).toBe(2);
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('stays disabled until the map is ready, even with Agder selected and connected', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://tiles.openfreemap.org/**', async (route) => {
    await held;
    await route.fulfill({ json: { version: 8, sources: {}, layers: [] } });
  });
  await page.goto('./');
  await connect(page);
  await userSelect(page).selectOption('0');
  await expect(areaButton(page)).toBeDisabled();
  release();
  await expect(areaButton(page)).toBeEnabled();
});

test('shows independent loading/errors, retries, and cancels pending requests when hidden', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0, aborted = false;
  page.on('requestfailed', (request) => {
    if (request.url().includes('auth-polygon')) aborted = true;
  });
  await page.route(`${api}/fgb/auth-polygon/**`, async (route) => {
    attempts++;
    if (attempts === 1) {
      await held;
      return route.fulfill({ status: 503, body: 'Late failure' });
    }
    if (attempts === 2) return route.fulfill({ status: 503, body: 'Unavailable' });
    if (attempts === 3) return route.fulfill({ json: { type: 'Feature', geometry: null } });
    return route.fulfill({ json: polygon });
  });
  await page.goto('./');
  await connect(page);
  await userSelect(page).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  const timings = await page.locator('.timings-point').count();
  await areaButton(page).click();
  await expect(page.getByText('Loading authorized area…')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await areaButton(page).click();
  await expect.poll(() => aborted).toBe(true);
  release();
  await expect(page.getByText('Loading authorized area…')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await areaButton(page).click();
  await expect(page.getByRole('alert')).toContainText('Authorized area API returned HTTP 503');
  await expect(areaButton(page)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Retry authorized area', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('valid Polygon and finite coordinates');
  await page.getByRole('button', { name: 'Retry authorized area', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await mapPixels(page))[0]).toBeGreaterThan(100);
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await expect(page.locator('.timings-point')).toHaveCount(timings);
  expect(attempts).toBe(4);
});

declare global {
  interface Window {
    pendingAreas: { id: string; signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }[];
  }
}

for (const stale of ['success', 'error']) {
  test(`clears previous geometry, aborts work and ignores a stale ${stale} even if fetch ignores cancellation`, async ({ page }) => {
    await page.addInitScript(() => {
      const originalFetch = window.fetch;
      window.pendingAreas = [];
      window.fetch = (input, options) => {
        const url = String(input);
        if (!url.includes('/fgb/auth-polygon/')) return originalFetch(input, options);
        return new Promise<Response>((resolve, reject) => {
          window.pendingAreas.push({ id: url.split('/').at(-1)!, signal: options!.signal!, resolve, reject });
        });
      };
    });
    await page.goto('./');
    await connect(page);
    await userSelect(page).selectOption('0');
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/);
    await areaButton(page).click();
    await expect.poll(() => page.evaluate(() => window.pendingAreas.length)).toBe(1);
    await page.evaluate((feature) => window.pendingAreas[0].resolve(Response.json(feature)), polygon);
    await expect.poll(async () => (await mapPixels(page))[0]).toBeGreaterThan(100);
    await userSelect(page).selectOption('1');
    await expect(page.getByText('Loading authorized area…')).toBeVisible();
    expect((await mapPixels(page))[0]).toBe(0);
    await userSelect(page).selectOption('2');
    await expect.poll(() => page.evaluate(() => window.pendingAreas.map((request) => [request.id, request.signal.aborted])))
      .toEqual([['0', true], ['1', true], ['2', false]]);
    await page.evaluate(({ feature, stale }) => {
      if (stale === 'success') window.pendingAreas[1].resolve(Response.json(feature));
      else window.pendingAreas[1].reject(new Error('Stale failure'));
    }, { feature: polygon, stale });
    await expect(page.getByText('Loading authorized area…')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await mapPixels(page))[0]).toBe(0);
    await page.evaluate((feature) => window.pendingAreas[2].resolve(Response.json(feature)), polygon);
    await expect.poll(async () => (await mapPixels(page))[0]).toBeGreaterThan(100);
    // Revisiting a user discards their previous geometry and starts a new request.
    await userSelect(page).selectOption('0');
    await expect.poll(() => page.evaluate(() => window.pendingAreas.length)).toBe(4);
    expect((await mapPixels(page))[0]).toBe(0);
    await page.locator('.connection-heading button').click();
    await connect(page);
    await expect.poll(() => page.evaluate(() => window.pendingAreas[3].signal.aborted)).toBe(true);
    await page.evaluate((feature) => window.pendingAreas[3].resolve(Response.json(feature)), polygon);
    await expect(areaButton(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await mapPixels(page))[0]).toBe(0);
  });
}
