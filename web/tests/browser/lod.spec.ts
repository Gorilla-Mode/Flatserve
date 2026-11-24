import { expect } from '@playwright/test';
import { encoded, multipartEncoded, station } from '../fixtures';
import { test } from './helpers';

test('sends the map zoom and displays the LOD reported by the loaded response', async ({ page }) => {
  const api = 'https://lod.example';
  const requests: URL[] = [];
  const bytes = encoded([station('Test')]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
    const lod = zoom < 8 ? 3 : zoom < 11 ? 2 : zoom < 12 ? 1 : 0;
    const layers = [
      { id: 'nrlluftspenn', bytes, lod: user === '1' ? 0 : user === '2' ? lod : undefined },
      { id: 'other', bytes, lod: user === '2' && lod === 2 ? 0 : undefined },
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
  await expect(readout).toHaveText(/ · LOD 3$/);
  expect(requests.at(-1)?.searchParams.get('zoom')).toBe(String(Math.floor(await zoom())));

  async function checkLodAt(target: number, lodLabel: string) {
    let current = await zoom();
    const distance = target - Math.floor(current);
    const step = Math.sign(distance);
    const button = page.getByRole('button', { name: step > 0 ? 'Zoom in' : 'Zoom out', exact: true });
    for (let remaining = Math.abs(distance); remaining > 0; remaining--) {
      await button.click();
      await expect.poll(zoom).toBeCloseTo(current + step, 2);
      current = await zoom();
    }
    await expect.poll(() => requests.at(-1)?.searchParams.get('zoom')).toBe(String(target));
    await expect(readout).toHaveText(new RegExp(` · LOD ${lodLabel}$`));
  }
  await checkLodAt(8, '0, 2');
  await checkLodAt(11, '1');
  await checkLodAt(12, '0');
  await checkLodAt(11, '1');
  await checkLodAt(10, '0, 2');
  await checkLodAt(7, '3');

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
