import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { serialize } from 'flatgeobuf/geojson';
import type { Feature, Geometry, Position } from 'geojson';
import { test } from './helpers';

const api = 'http://localhost:5221';
const square = (x: number, y: number): Position[][] => [
  [[x - 1, y - .5], [x + 1, y - .5], [x + 1, y + .5], [x - 1, y + .5], [x - 1, y - .5]],
];
const geometries: Geometry[] = [
  { type: 'Point', coordinates: [8, 60] },
  { type: 'MultiPoint', coordinates: [[14, 60], [20, 60]] },
  { type: 'LineString', coordinates: [[24, 59.5], [28, 60.5]] },
  { type: 'Polygon', coordinates: square(8, 65) },
  { type: 'MultiLineString', coordinates: [[[13, 64.5], [15, 65.5]], [[19, 64.5], [21, 65.5]]] },
  { type: 'MultiPolygon', coordinates: [square(26, 65), square(8, 69)] },
  { type: 'GeometryCollection', geometries: [
    { type: 'Point', coordinates: [14, 69] },
    { type: 'LineString', coordinates: [[19, 68.5], [21, 69.5]] },
    { type: 'Polygon', coordinates: square(26, 69) },
  ] },
];
const features: Feature[] = geometries.map((geometry) => ({
  type: 'Feature', properties: { brannvesen: 'Geometry fixture' }, geometry,
}));
const response = Buffer.from(serialize({ type: 'FeatureCollection', features }, 4326));

// The fixture has no discovery envelope, so the camera keeps App's initial fitted bounds.
// Sample projected locations on the real rendered canvas without exposing the map in production.
async function samples(page: Page, positions: Position[], color: number[], radius = 4) {
  const screenshot = await page.locator('.maplibregl-canvas').screenshot();
  return page.evaluate(async ({ base64, positions, color, radius }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const mercator = (latitude: number) => 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
    const scale = Math.min((canvas.width - 90) / 28, (canvas.height - 90) / (mercator(72) - mercator(57)));
    return positions.map(([longitude, latitude]) => {
      const x = Math.round(canvas.width / 2 + (longitude - 18) * scale);
      const y = Math.round(canvas.height / 2 - (mercator(latitude) - (mercator(72) + mercator(57)) / 2) * scale);
      let count = 0;
      for (let py = y - radius; py <= y + radius; py++) {
        for (let px = x - radius; px <= x + radius; px++) {
          const offset = (py * canvas.width + px) * 4;
          if (color.every((channel, index) => Math.abs(data[offset + index] - channel) <= 3)) count++;
        }
      }
      return count;
    });
  }, { base64: screenshot.toString('base64'), positions, color, radius });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background',
      paint: { 'background-color': '#0c0c0c' } }] },
  }));
  await page.route(`${api}/fgb/collection?**`, (route) => route.fulfill({
    contentType: 'application/octet-stream', body: response,
  }));
  await page.route(`${api}/fgb/filter?**`, (route) => route.fulfill({
    contentType: 'application/octet-stream', body: response,
  }));
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('7 features in view');
});

test('renders all standard FGB geometries and collection members, keeping original feature counts', async ({ page }) => {
  const points = [[8, 60], [14, 60], [20, 60], [14, 69]];
  const lines = [[26, 60], [14, 65], [20, 65], [20, 69]];
  const polygonCenters = [[8, 65], [26, 65], [8, 69], [26, 69]];
  for (const [name, positions, color, radius] of [
    ['red point centers', points, [187, 52, 42], 4],
    ['white point borders', points, [255, 255, 255], 7],
    ['red line strokes', lines, [187, 52, 42], 4],
    ['18% red polygon fills', polygonCenters, [44, 19, 17], 4],
  ] as const) {
    await expect.poll(async () => (await samples(page, positions, [...color], radius)).every((count) => count > 2),
      { message: name }).toBe(true);
  }
  // Polygon vertices and line endpoints have no white point markers.
  expect(await samples(page, [[7, 64.5], [25, 64.5], [7, 68.5], [25, 68.5], [24, 59.5]], [255, 255, 255], 8))
    .toEqual([0, 0, 0, 0, 0]);
  await page.getByLabel('Brannvesen', { exact: true }).selectOption('Geometry fixture');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps dataset polygons red and draws blue authorized geometry above them', async ({ page }) => {
  await page.route(`${api}/fgb/auth-polygon/2`, (route) => route.fulfill({ json: {
    type: 'Feature', properties: { userId: 2 }, geometry: { type: 'Polygon', coordinates: [
      [[8, 63], [18, 63], [18, 70], [8, 70], [8, 63]],
    ] },
  } }));
  await page.getByRole('button', { name: 'Show authorized area', exact: true }).click();
  // Its left edge crosses two dataset polygons; blue must remain visible on top.
  await expect.poll(async () => (await samples(page, [[8, 65], [8, 69]], [56, 189, 248])).every((count) => count > 2)).toBe(true);
  expect((await samples(page, [[12, 67]], [17, 33, 40]))[0]).toBeGreaterThan(20);
  expect((await samples(page, [[26, 65], [26, 69]], [44, 19, 17])).every((count) => count > 20)).toBe(true);
  await expect(page.getByRole('status')).toHaveText('7 features in view');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/geometries-and-authorization.png' });
});
