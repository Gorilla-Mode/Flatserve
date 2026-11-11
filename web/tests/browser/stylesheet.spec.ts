import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './helpers';
import { encoded, multipartEncoded, station } from '../fixtures';

const api = 'https://style.example/proxy';
// An actual GeoFlatpack-generated stylesheet, including embedded SVG metadata.
const style = JSON.parse(await readFile(new URL('../data/geoflatpack-style.json', import.meta.url), 'utf8'));
const ids = Object.keys(style.sources);
const styledBytes = Buffer.from(multipartEncoded([
  { id: ids[0], bytes: encoded([{ ...station('star', 10),
    properties: { __geoflatpack_vertices: 'Polygon' }, geometry: { type: 'Point', coordinates: [10, 63] } }]) },
  { id: ids[1], bytes: encoded([{ ...station('line'), geometry: { type: 'LineString', coordinates: [[16, 61], [20, 64]] } }]) },
]));

test.beforeEach(async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0c0c0c' } }] },
  }));
  await page.route(`${api}/fgb/indexes`, (route) => route.fulfill({ json: { layers: [] } }));
  await page.route(`${api}/fgb/collection?**`, (route) => route.fulfill({ contentType: 'multipart/mixed; boundary=fgb-test', body: styledBytes }));
});

async function connect(page: import('@playwright/test').Page) {
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
}

test('applies a generated style and its SVG, retaining it across data and visibility changes', async ({ page }) => {
  let requests = 0;
  await page.route(`${api}/fgb/style`, (route) => { requests++; return route.fulfill({ json: style }); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('./');
  await connect(page);
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('2 features in view');
  await expect(page.locator('.layer-list small', { hasText: /^Styled$/ })).toHaveCount(2);
  // Measure red pixels around the isolated star, away from the styled line.
  const starPixels = async () => {
    const png = await page.locator('.maplibregl-canvas').screenshot();
    return page.evaluate(async (base64) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const mercator = (latitude: number) => 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
      const scale = Math.min((canvas.width - 90) / 28, (canvas.height - 90) / (mercator(72) - mercator(57)));
      const x = Math.round(canvas.width / 2 + (10 - 18) * scale);
      const y = Math.round(canvas.height / 2 - (mercator(63) - (mercator(72) + mercator(57)) / 2) * scale);
      const pixels = context.getImageData(x - 12, y - 12, 24, 24).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (Math.abs(pixels[i] - 220) < 5 && Math.abs(pixels[i + 1] - 38) < 5 && Math.abs(pixels[i + 2] - 38) < 5) count++;
      return count;
    }, png.toString('base64'));
  };
  await expect.poll(starPixels).toBeGreaterThan(5);
  const checkbox = page.getByRole('checkbox', { name: new RegExp(ids[0]) });
  await checkbox.uncheck();
  await expect.poll(starPixels).toBe(0);
  await checkbox.check();
  await expect.poll(starPixels).toBeGreaterThan(5);
  await page.getByRole('button', { name: 'Buffer', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('1');
  await expect(page.getByRole('status')).toHaveText('2 features in view');
  expect(requests).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('falls back on HTTP errors, retries explicitly, and ignores an old connection response', async ({ page }) => {
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${api}/fgb/style`, async (route) => {
    requests++;
    if (requests === 1) return route.fulfill({ status: 404 });
    if (requests === 2) await held;
    return route.fulfill({ json: style });
  });
  await page.goto('./');
  await connect(page);
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('note')).toContainText('Using basic styling');
  await expect(page.getByRole('status')).toHaveText('2 features in view');
  await page.getByRole('button', { name: 'Retry stylesheet' }).click();
  await expect.poll(() => requests).toBe(2);
  await page.locator('.connection-heading button').click();
  await connect(page);
  await expect.poll(() => requests).toBe(3);
  release();
  await expect(page.locator('.layer-list small', { hasText: /^Styled$/ })).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
