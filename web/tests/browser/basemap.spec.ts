import { expect } from '@playwright/test';
import { ByteBuffer } from 'flatbuffers';
import { Header } from 'flatgeobuf/lib/mjs/flat-geobuf/header.js';
import { expectSidebarLayout, moveOnMap, test } from './helpers';

// Opt in separately: the regular browser suite never depends on public tiles.
test('OpenFreeMap Dark renders roads, labels, attribution, and overlays at city and street scales', async ({ page }) => {
  test.skip(process.env.FLATSERVE_LIVE_BASEMAP !== '1', 'Requires the live OpenFreeMap service.');
  test.setTimeout(90_000);
  // Keep real stations and tiles, but fit the discovery envelope to central Oslo.
  await page.route('http://localhost:5221/fgb/collection?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('minX') !== '-180') return route.continue();
    const response = await route.fetch();
    const bytes = new Uint8Array(await response.body());
    const header = Header.getSizePrefixedRootAsHeader(new ByteBuffer(bytes.subarray(8)));
    header.envelopeArray()!.set([10.72, 59.90, 10.78, 59.93]);
    await route.fulfill({ response, body: Buffer.from(bytes) });
  });
  const loaded: string[] = [];
  page.on('response', (response) => {
    if (response.ok() && response.url().startsWith('https://tiles.openfreemap.org/')) loaded.push(response.url());
  });
  const styleResponse = page.waitForResponse('https://tiles.openfreemap.org/styles/dark');
  await page.goto('./');
  const style = await (await styleResponse).json();
  expect(style.layers.some((layer: { id: string; type: string }) => layer.type === 'line' && /road|highway/i.test(layer.id))).toBe(true);
  expect(style.layers.some((layer: { id: string; type: string }) => layer.type === 'symbol' && /road|highway/i.test(layer.id))).toBe(true);
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenFreeMap');
  await expect(page.locator('.maplibregl-ctrl-attrib a[href*="openstreetmap.org"]')).toBeVisible();
  expect(loaded.some((url) => url.includes('/fonts/'))).toBe(true);
  expect(loaded.some((url) => /\/\d+\/\d+\/\d+\.pbf/.test(url))).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectSidebarLayout(page);
  await page.getByRole('button', { name: 'BBox', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await page.getByRole('button', { name: 'Show buffer', exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/dark-city.png' });
  const refreshCoverage = async () => {
    // Cached city coverage can lie outside a zoomed street view. Establish a
    // fresh buffer at each inspection camera so both outlines are on screen.
    const bbox = page.getByRole('button', { name: 'BBox', exact: true });
    await bbox.click();
    await expect(page.getByRole('status')).toHaveText(/^(\d+ features in view|No features found\.)$/);
    await bbox.click();
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
    await page.waitForTimeout(250);
  };
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForTimeout(350);
  }
  await page.waitForLoadState('networkidle');
  await refreshCoverage();
  await page.screenshot({ path: 'test-results/dark-street.png' });
  await moveOnMap(page, .55, .625);
  await page.mouse.down({ button: 'right' });
  await moveOnMap(page, .67, .46, 20);
  await page.mouse.up({ button: 'right' });
  await page.waitForLoadState('networkidle');
  await refreshCoverage();
  await page.screenshot({ path: 'test-results/dark-tilted.png' });
  for (const width of [375, 280]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForLoadState('networkidle');
    await refreshCoverage();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const show = page.getByRole('button', { name: 'Show buffer', exact: true });
    await expect(show).toBeEnabled();
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    const map = await expectSidebarLayout(page);
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    if ((await attribution.getAttribute('open')) === null) await attribution.locator('summary').click();
    const link = attribution.locator('a[href*="openstreetmap.org"]');
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
    await expect(attribution).toHaveCSS('background-color', 'rgb(23, 27, 32)');
    await expect(link).toHaveCSS('color', 'rgb(229, 231, 235)');
    await page.keyboard.press('Tab');
    await link.focus();
    await expect(link).toHaveCSS('outline-color', 'rgb(74, 222, 128)');
    const box = await attribution.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(map.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: `test-results/dark-mobile-${width}.png` });
  }
});
