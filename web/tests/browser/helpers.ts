import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

export const test = base.extend<{ independentFonts: void }>({
  independentFonts: [async ({ page }, use) => {
    if (process.env.FLATSERVE_LIVE_FONTS !== '1') {
      await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    }
    await use();
  }, { auto: true }],
});

/** Move relative to the map canvas, independent of the sidebar and viewport. */
export async function moveOnMap(page: Page, x: number, y: number, steps = 1) {
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps });
}

export async function expectSidebarLayout(page: Page) {
  const controls = page.locator('.controls');
  const sidebar = (await controls.boundingBox())!;
  const map = (await page.locator('.map').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(sidebar.x).toBe(0);
  expect(sidebar.y).toBe(0);
  expect(sidebar.height).toBe(viewport.height);
  expect(sidebar.width).toBeCloseTo(Math.min(280, Math.max(180, viewport.width * .28)), 0);
  expect(map.x).toBe(sidebar.width);
  expect(map.y).toBe(0);
  expect(map.width + sidebar.width).toBe(viewport.width);
  expect(map.height).toBe(viewport.height);
  await expect.poll(async () => (await page.locator('.maplibregl-canvas').boundingBox())!.width).toBe(map.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(controls.getByRole('heading', { level: 2 })).toHaveText(['Options', 'Status', 'Filter']);
  const buffer = (await controls.getByRole('button', { name: 'Buffer', exact: true }).boundingBox())!;
  const show = (await controls.getByRole('button', { name: 'Show buffer', exact: true }).boundingBox())!;
  expect(show.x).toBeGreaterThan(buffer.x);
  expect(show.y).toBeGreaterThanOrEqual(buffer.y + buffer.height);
  expect(show.x + show.width).toBeCloseTo(buffer.x + buffer.width, 0);
  const select = (await controls.getByLabel('Brannvesen', { exact: true }).boundingBox())!;
  const filter = (await controls.getByRole('button', { name: 'Filter', exact: true }).boundingBox())!;
  expect(filter.x).toBeGreaterThan(select.x);
  expect(filter.y).toBeGreaterThanOrEqual(select.y + select.height);
  expect(filter.x + filter.width).toBeCloseTo(select.x + select.width, 0);
  const corners = await page.locator('button, input, select, dialog, .controls, .timings-chart, .maplibregl-ctrl').evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).borderRadius));
  expect(corners.every((corner) => corner === '0px')).toBe(true);
  const fonts = await page.locator('button, input, select, dialog, .controls, .maplibregl-ctrl').evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).fontFamily));
  expect(fonts.every((font) => font.includes('JetBrains Mono'))).toBe(true);
  const title = controls.locator('.connection-heading strong');
  const connect = controls.getByRole('button', { name: 'Connect', exact: true });
  const titleBox = (await title.boundingBox())!;
  const connectBox = (await connect.boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(connectBox.x);
  expect(connectBox.x + connectBox.width).toBeLessThanOrEqual(sidebar.width - 12);
  expect(titleBox.y + titleBox.height / 2).toBeCloseTo(connectBox.y + connectBox.height / 2, 0);
  await expect(title).toHaveCSS('font-size', sidebar.width < 200 ? '14px' : '16px');
  await expect(connect).toHaveCSS('font-size', sidebar.width < 200 ? '12px' : '14px');
  await page.getByLabel('Brannvesen', { exact: true }).focus();
  await expect(page.getByLabel('Brannvesen', { exact: true })).toHaveCSS('border-radius', '0px');
  for (const button of await page.locator('.maplibregl-ctrl-group button').all()) {
    await button.focus();
    await expect(button).toHaveCSS('border-radius', '0px');
  }
  await expect(controls.locator('.request-timings')).toContainText('API requests');
  await expect(controls.getByRole('button', { name: 'Browser total', exact: true })).toBeVisible();
  await expect(controls.locator('.timings-chart svg')).toBeVisible();
  return map;
}
