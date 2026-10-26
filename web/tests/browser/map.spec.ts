import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function greenOutline(page: Page) {
  const screenshot = await page.locator('.maplibregl-canvas').screenshot({ mask: [page.locator('.controls')] });
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
    let count = 0;
    let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - 22) > 5 || Math.abs(data[i + 1] - 163) > 5 || Math.abs(data[i + 2] - 74) > 5) continue;
      const x = (i / 4) % canvas.width;
      const y = Math.floor(i / 4 / canvas.width);
      count++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { count, minX, maxX, minY, maxY, width: canvas.width, height: canvas.height };
  }, screenshot.toString('base64'));
}

async function expectInsetOutline(page: Page) {
  const pixels = await greenOutline(page);
  expect(pixels.count).toBeGreaterThan(100);
  expect(pixels.minX).toBeGreaterThanOrEqual(pixels.width * 0.2 - 3);
  expect(pixels.maxX).toBeLessThanOrEqual(pixels.width * 0.8 + 3);
  expect(pixels.minY).toBeGreaterThanOrEqual(pixels.height * 0.2 - 3);
  expect(pixels.maxY).toBeLessThanOrEqual(pixels.height * 0.8 + 3);
}

test.beforeEach(async ({ page }) => {
  if (process.env.FLATSERVE_LIVE_BASEMAP === '1') return;
  // Keep browser tests independent of the public basemap service.
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background',
      paint: { 'background-color': '#0c0c0c' } }] },
  }));
});

test('connects, loads stations, caches filters through camera moves, and prompts again on reload', async ({ page }) => {
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
    const response = await route.fetch({ url: `http://localhost:5221${original.pathname.replace('/proxy/v1', '')}${original.search}` });
    await route.fulfill({ response });
    paths.push(original.pathname);
  });
  await input.fill('http://localhost:5221/proxy/v1');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await expect(page.locator('.api-url')).toHaveText('http://localhost:5221/proxy/v1/');
  await expect.poll(() => paths.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('status')).toHaveText('639 features in view');
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let mode: 'empty' | 'error' | 'success' = 'empty';
  let failures = 0;
  await page.route('http://localhost:5221/fgb/collection?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('minX') === '-180' || mode === 'success') {
      await route.continue();
    } else if (mode === 'error') {
      failures++;
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
  // Zooming in stays inside the empty successful buffer. Zoom out to exceed it.
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('API returned HTTP 503.');
  const failedRequests = failures;
  await page.waitForTimeout(350);
  expect(failures).toBe(failedRequests);
  mode = 'success';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/\d+ features in view/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('bbox follows the camera, survives filters, wraps on mobile, and restores viewport queries', async ({ page }) => {
  const requests: URL[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/fgb/collection?')) requests.push(new URL(request.url()));
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  const bbox = page.getByRole('button', { name: 'BBox', exact: true });
  await expect(bbox).toBeDisabled();
  await expect(bbox).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await expect(bbox).toBeEnabled();
  await page.waitForTimeout(350);
  // Header fitting may reuse the initial buffer. Establish one at the final camera position.
  await bbox.click();
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await bbox.click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  const viewport = requests.at(-1)!;
  await bbox.click();
  await expect(bbox).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  const inset = requests.at(-1)!;
  for (const key of ['minX', 'minY']) expect(Number(inset.searchParams.get(key))).toBeGreaterThan(Number(viewport.searchParams.get(key)));
  for (const key of ['maxX', 'maxY']) expect(Number(inset.searchParams.get(key))).toBeLessThan(Number(viewport.searchParams.get(key)));
  await expectInsetOutline(page);
  // Recover the active rectangles from the invisible 25%-per-side request buffers.
  const pixels = await greenOutline(page);
  const coordinate = (url: URL, key: string) => {
    const min = Number(url.searchParams.get(key.endsWith('X') ? 'minX' : 'minY'));
    const max = Number(url.searchParams.get(key.endsWith('X') ? 'maxX' : 'maxY'));
    return key.startsWith('min') ? min + (max - min) / 6 : max - (max - min) / 6;
  };
  const mercatorY = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
  const screenX = (longitude: number) => pixels.width * (longitude - coordinate(viewport, 'minX'))
    / (coordinate(viewport, 'maxX') - coordinate(viewport, 'minX'));
  const screenY = (latitude: number) => pixels.height * (mercatorY(coordinate(viewport, 'maxY')) - mercatorY(latitude))
    / (mercatorY(coordinate(viewport, 'maxY')) - mercatorY(coordinate(viewport, 'minY')));
  expect(Math.abs(pixels.minX - screenX(coordinate(inset, 'minX')))).toBeLessThan(3);
  expect(Math.abs(pixels.maxX - screenX(coordinate(inset, 'maxX')))).toBeLessThan(3);
  expect(Math.abs(pixels.minY - screenY(coordinate(inset, 'maxY')))).toBeLessThan(3);
  expect(Math.abs(pixels.maxY - screenY(coordinate(inset, 'minY')))).toBeLessThan(3);
  await bbox.click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  expect(requests.at(-1)!.search).toBe(viewport.search);
  expect((await greenOutline(page)).count).toBe(0);
  await bbox.click();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const select = page.getByLabel('Brannvesen', { exact: true });
  await select.selectOption({ label: 'Oslo brann- og redningsetat' });
  await expect(bbox).toBeDisabled();
  await expect(bbox).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  expect((await greenOutline(page)).count).toBe(0);
  const filteredRequests = requests.length;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(filteredRequests);
  await select.selectOption('');
  await expect(bbox).toBeEnabled();
  await expect(bbox).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  expect(requests.at(-1)!.search).not.toBe(inset.search);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  // Pan, then rotate and tilt with MapLibre's right-button gesture.
  for (const button of ['left', 'right'] as const) {
    await page.mouse.move(700, 450);
    await page.mouse.down({ button });
    await page.mouse.move(850, button === 'right' ? 330 : 550, { steps: 20 });
    await page.mouse.up({ button });
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
    await expectInsetOutline(page);
  }
  await page.screenshot({ path: 'test-results/bbox-rotated.png' });
  await page.setViewportSize({ width: 280, height: 650 });
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await expectInsetOutline(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const toolbar = await page.locator('.toolbar').boundingBox();
  const bboxButton = await bbox.boundingBox();
  expect(bboxButton!.y).toBeGreaterThan(toolbar!.y + 10);
  await page.screenshot({ path: 'test-results/bbox-mobile.png' });
  expect(requests.filter((url) => url.searchParams.get('minX') === '-180')).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.reload();
  await expect(bbox).toHaveAttribute('aria-pressed', 'false');
});

test('turning bbox off cancels a delayed request and ignores its late response', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await page.waitForTimeout(350);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let delayedUrl = '';
  let finished = false;
  let aborted = false;
  let delayNext = true;
  page.on('requestfailed', (request) => { if (request.url() === delayedUrl) aborted = true; });
  await page.route('http://localhost:5221/fgb/collection?**', async (route) => {
    if (!delayNext) return route.continue();
    delayNext = false;
    delayedUrl = route.request().url();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
    finished = true;
  });
  const bbox = page.getByRole('button', { name: 'BBox', exact: true });
  await bbox.click();
  await expect.poll(() => delayedUrl).not.toBe('');
  await expect(page.getByRole('status')).toHaveText(/^Loading… \d+ features in bbox$/);
  await bbox.click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await expect.poll(() => aborted).toBe(true);
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  expect((await greenOutline(page)).count).toBe(0);
});

for (const useBbox of [false, true]) {
  test(`updates during dragging, reuses coverage, and catches up after a slow ${useBbox ? 'bbox' : 'viewport'} request`, async ({ page }) => {
    const requests: string[] = [];
    const failed: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/fgb/collection?')) requests.push(request.url());
    });
    page.on('requestfailed', (request) => {
      if (request.url().includes('/fgb/collection?')) failed.push(request.url());
    });
    await page.goto('./');
    await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('639 features in view');
    await expect(page.getByLabel('Brannvesen', { exact: true })).toHaveCount(0);
    await page.waitForTimeout(200);
    const beforeZoom = requests.length;
    await page.mouse.move(640, 420);
    await page.mouse.wheel(0, -300);
    await expect(page.getByRole('status')).not.toHaveText('639 features in view');
    await page.waitForTimeout(500);
    // Zooming in changes displayed stations using the existing buffer.
    expect(requests).toHaveLength(beforeZoom);
    const bbox = page.getByRole('button', { name: 'BBox', exact: true });
    await bbox.click();
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
    if (!useBbox) {
      await bbox.click();
      await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/);
    }
    const beforeDrag = requests.length;
    const initialStatus = await page.getByRole('status').innerText();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let delayNext = true;
    await page.route('http://localhost:5221/fgb/collection?**', async (route) => {
      if (!delayNext) return route.continue();
      delayNext = false;
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    await page.mouse.move(1150, 450);
    await page.mouse.down();
    await page.mouse.move(700, 450, { steps: 30 });
    // Both the request and local display update happen before mouseup/moveend.
    await expect.poll(() => requests.length).toBe(beforeDrag + 1);
    await expect(page.getByRole('status')).not.toHaveText(initialStatus);
    await page.mouse.move(150, 450, { steps: 30 });
    await page.waitForTimeout(150);
    expect(requests).toHaveLength(beforeDrag + 1);
    expect(failed).toEqual([]);
    release();
    await expect.poll(() => requests.length).toBe(beforeDrag + 2);
    await expect(page.getByRole('status')).not.toContainText('Loading');
    await page.mouse.up();
    await page.waitForTimeout(400);
    // The final moveend sees coverage and does not repeat the request.
    expect(requests).toHaveLength(beforeDrag + 2);
    expect(failed).toEqual([]);
  });
}

test('requests new coverage while wheel scrolling is still ongoing', async ({ page }) => {
  let requests = 0;
  page.on('request', (request) => { if (request.url().includes('/fgb/collection?')) requests++; });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await page.getByRole('button', { name: 'BBox', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  const before = requests;
  await page.mouse.move(640, 420);
  let finished = false;
  const scrolling = (async () => {
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 80);
      await page.waitForTimeout(80);
    }
    finished = true;
  })();
  try {
    await expect.poll(() => requests, { intervals: [25] }).toBeGreaterThan(before);
    expect(finished).toBe(false);
  } finally {
    await scrolling;
  }
  await expect(page.getByRole('status')).not.toContainText('Loading');
});

for (const useBbox of [false, true]) {
  test(`Buffer switches exact and expanded ${useBbox ? 'bbox' : 'viewport'} requests and cancels slow work`, async ({ page }) => {
    const requests: URL[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/fgb/collection?')) requests.push(new URL(request.url()));
    });
    await page.goto('./');
    const buffer = page.getByRole('button', { name: 'Buffer', exact: true });
    await expect(buffer).toBeDisabled();
    await expect(buffer).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('639 features in view');
    await expect(buffer).toBeEnabled();
    const bboxResponse = page.waitForResponse((response) => response.url().includes('/fgb/collection?'));
    await page.getByRole('button', { name: 'BBox', exact: true }).click();
    await bboxResponse;
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
    if (!useBbox) {
      await page.getByRole('button', { name: 'BBox', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('639 features in view');
    }
    const expanded = requests.at(-1)!;
    const initialStatus = await page.getByRole('status').innerText();
    const outline = await greenOutline(page);
    await buffer.click();
    await expect(buffer).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('status')).toHaveText(initialStatus);
    const exact = requests.at(-1)!;
    for (const axis of ['X', 'Y']) {
      const min = Number(exact.searchParams.get(`min${axis}`));
      const max = Number(exact.searchParams.get(`max${axis}`));
      expect(Number(expanded.searchParams.get(`min${axis}`))).toBeCloseTo(min - (max - min) * .25, 7);
      expect(Number(expanded.searchParams.get(`max${axis}`))).toBeCloseTo(max + (max - min) * .25, 7);
    }
    expect(await greenOutline(page)).toEqual(outline);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let delayedUrl = '';
    let finished = false;
    let aborted = false;
    let delayNext = true;
    page.on('requestfailed', (request) => { if (request.url() === delayedUrl) aborted = true; });
    await page.route('http://localhost:5221/fgb/collection?**', async (route) => {
      if (!delayNext) return route.continue();
      delayNext = false;
      delayedUrl = route.request().url();
      const response = await route.fetch({ url: 'http://localhost:5221/fgb/collection?minX=-1&minY=-1&maxX=1&maxY=1' });
      await held;
      await route.fulfill({ response });
      finished = true;
    });
    await buffer.click();
    await expect.poll(() => delayedUrl).not.toBe('');
    await expect(page.getByRole('status')).toHaveText(`Loading… ${initialStatus}`);
    await buffer.click();
    await expect(page.getByRole('status')).toHaveText(initialStatus);
    await expect.poll(() => aborted).toBe(true);
    release();
    await expect.poll(() => finished).toBe(true);
    await expect(page.getByRole('status')).toHaveText(initialStatus);
    expect(requests.at(-1)!.search).toBe(exact.search);
    expect(await greenOutline(page)).toEqual(outline);
  });
}

test('preserves Buffer across filters, bbox changes and reconnects, then resets on reload', async ({ page }) => {
  let releaseStyle!: () => void;
  const heldStyle = new Promise<void>((resolve) => { releaseStyle = resolve; });
  await page.route('https://tiles.openfreemap.org/**', async (route) => {
    await heldStyle;
    await route.fulfill({ json: { version: 8, sources: {}, layers: [] } });
  });
  await page.goto('./');
  const buffer = page.getByRole('button', { name: 'Buffer', exact: true });
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(buffer).toBeDisabled();
  releaseStyle();
  await expect(buffer).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  await buffer.click();
  await expect(buffer).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'BBox', exact: true }).click();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const select = page.getByLabel('Brannvesen', { exact: true });
  await select.selectOption({ label: 'Oslo brann- og redningsetat' });
  await expect(buffer).toBeDisabled();
  await expect(buffer).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  await select.selectOption('');
  await expect(buffer).toBeEnabled();
  await expect(buffer).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(buffer).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await page.reload();
  await expect(buffer).toBeDisabled();
  await expect(buffer).toHaveAttribute('aria-pressed', 'true');
});

for (const width of [280, 375]) {
  test(`dark controls, dialog, errors and focus fit at ${width}px with readable contrast`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('./');
    const input = page.getByLabel('API URL', { exact: true });
    await input.fill('ftp://example.org');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await input.focus();
    await expect(input).toHaveCSS('outline-color', 'rgb(74, 222, 128)');
    await page.screenshot({ path: `test-results/dialog-${width}.png` });
    await input.fill('http://localhost:5221');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('639 features in view');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.getByLabel('Brannvesen', { exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Buffer', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Buffer', exact: true })).toHaveCSS('outline-color', 'rgb(74, 222, 128)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const measurements = await page.locator('.toolbar button, .maplibregl-ctrl-group button, select').evaluateAll((elements) =>
      elements.map((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
    for (const size of measurements) {
      expect(size.width).toBeGreaterThanOrEqual(40);
      expect(size.height).toBeGreaterThanOrEqual(40);
    }
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const luminance = (token: string) => {
        const hex = style.getPropertyValue(token).trim().slice(1);
        const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
          .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      return [
        ['--text', '--panel'], ['--text', '--field'], ['--text', '--hover'],
        ['--secondary', '--panel'], ['--secondary', '--field'], ['--error', '--panel'],
        ['--selected-text', '--selected'],
      ].map(([fg, bg]) => ({ fg, bg, ratio: (luminance(fg) + .05) / (luminance(bg) + .05) }));
    });
    for (const pair of contrast) expect(pair.ratio, `${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/controls-${width}.png` });
  });
}
