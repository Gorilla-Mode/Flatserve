import { expect } from '@playwright/test';
import { encoded, multipartEncoded, station } from '../fixtures';
import { test } from './helpers';

test('exposes the collection cutoff header to a cross-origin browser', async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
  await page.goto('./');
  const api = 'http://127.0.0.1:5221/fgb/collection?userId=2&minX=-1&minY=-1&maxX=1&maxY=1&zoom=14';
  const diagnostics: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('requestfailed', (request) => { if (request.url() === api) diagnostics.push(request.failure()?.errorText ?? ''); });
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    await response.arrayBuffer();
    return { status: response.status, cutoffs: response.headers.get('x-flatserve-lod-cutoffs') };
  }, api).catch((error: unknown) => {
    throw new Error(diagnostics.join('\n'), { cause: error });
  });
  expect(result.status).toBe(200);
  const cutoffs = (result.cutoffs ?? '').split(',').map(Number);
  expect(cutoffs).toHaveLength(3);
  expect(cutoffs.every(Number.isInteger)).toBe(true);
  expect(cutoffs[0]).toBeLessThan(cutoffs[1]);
  expect(cutoffs[1]).toBeLessThan(cutoffs[2]);
});

for (const cutoffs of [[9, 11, 12], [7, 9, 10]] as const) test(`follows the advertised LOD cutoffs ${cutoffs}`, async ({ page }) => {
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
    const lod = zoom < cutoffs[0] ? 3 : zoom < cutoffs[1] ? 2 : zoom < cutoffs[2] ? 1 : 0;
    const layers = [
      { id: 'nrlluftspenn', bytes, lod: user === '1' ? 0 : user === '2' ? lod : undefined },
      { id: 'other', bytes, lod: user === '2' && lod === 2 ? 0 : undefined },
    ];
    return route.fulfill({
      contentType: 'multipart/mixed; boundary=fgb-test',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Flatserve-Lod-Cutoffs',
        'X-Flatserve-Lod-Cutoffs': cutoffs.join(','),
      },
      body: Buffer.from(multipartEncoded(layers)),
    });
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

  async function moveTo(target: number) {
    let current = await zoom();
    const distance = target - Math.floor(current);
    const step = Math.sign(distance);
    const button = page.getByRole('button', { name: step > 0 ? 'Zoom in' : 'Zoom out', exact: true });
    for (let remaining = Math.abs(distance); remaining > 0; remaining--) {
      await button.click();
      await expect.poll(zoom).toBeCloseTo(current + step, 2);
      current = await zoom();
    }
  }

  async function checkLodAt(target: number, lodLabel: string) {
    await moveTo(target);
    await expect.poll(() => requests.at(-1)?.searchParams.get('zoom')).toBe(String(target));
    await expect(readout).toHaveText(new RegExp(` · LOD ${lodLabel}$`));
  }
  const beforeFirstCutoff = requests.length;
  await moveTo(cutoffs[0] - 1);
  await checkLodAt(cutoffs[0], '0, 2');
  expect(requests.slice(beforeFirstCutoff).map((url) => Number(url.searchParams.get('zoom'))))
    .toEqual([cutoffs[0]]);
  await checkLodAt(cutoffs[1], '1');
  await checkLodAt(cutoffs[2], '0');
  await checkLodAt(cutoffs[2] - 1, '1');
  await checkLodAt(cutoffs[1] - 1, '0, 2');
  await checkLodAt(cutoffs[0] - 1, '3');

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
