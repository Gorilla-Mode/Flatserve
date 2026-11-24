import { expect } from '@playwright/test';
import { encoded, multipartEncoded, station } from '../fixtures';
import { test } from './helpers';

test('sends the map zoom and displays the LOD reported by the loaded response', async ({ page }) => {
  const api = 'https://lod.example';
  const requests: URL[] = [];
  const bytes = encoded([station('Test')]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
  await page.route(`${api}/fgb/indexes`, (route) => route.fulfill({ json: { layers: [] } }));
  await page.route(`${api}/fgb/style`, (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
  await page.route(`${api}/fgb/collection?**`, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const { searchParams } = url;
    const zoom = Number(searchParams.get('zoom'));
    const user = searchParams.get('userId');
    const layers = [
      { id: 'nrlluftspenn', bytes, lod: user === '1' ? 0 : user === '0' ? undefined : zoom < 6 ? 1 : 2 },
      { id: 'other', bytes, lod: user === '2' && zoom >= 6 ? 0 : undefined },
    ];
    return route.fulfill({ contentType: 'multipart/mixed; boundary=fgb-test', body: Buffer.from(multipartEncoded(layers)) });
  });

  await page.goto('./');
  const readout = page.locator('.map-readout');
  await expect(readout).toHaveText(/^Zoom \d+\.\d{2} · LOD —$/);
  const zoom = async () => Number((await readout.innerText()).match(/^Zoom (\d+\.\d{2})/)?.[1]);
  const initial = await zoom();
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => requests[0]?.searchParams.get('zoom')).toBe(String(Math.floor(initial)));
  await expect(readout).toContainText('LOD —');

  const user = page.getByLabel('Select user', { exact: true });
  await user.selectOption('2');
  await expect(readout).toContainText('LOD 1');
  expect(requests.at(-1)?.searchParams.get('zoom')).toBe(String(Math.floor(await zoom())));

  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  for (let previous = await zoom(); previous < 6; previous = await zoom()) {
    await zoomIn.click();
    await expect.poll(zoom).toBeGreaterThanOrEqual(previous + 0.9);
  }
  await expect(readout).toContainText('LOD 0, 2');
  expect(requests.at(-1)?.searchParams.get('zoom')).toBe('6');

  await user.selectOption('1');
  await expect(readout).toHaveText(/ · LOD 0$/);
  await user.selectOption('0');
  await expect.poll(() => requests.at(-1)?.searchParams.get('userId')).toBe('0');
  await expect(readout).toHaveText(/ · LOD —$/);

  const map = (await page.locator('.map').boundingBox())!;
  const label = (await readout.boundingBox())!;
  expect(label.x - map.x).toBe(10);
  expect(map.y + map.height - label.y - label.height).toBe(10);
});
