import { readFile, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './helpers';
import { filterUrl } from '../../src/api';

test('live HTTP timing matches the exchange for cold and repeated filter requests', async ({ page, request }, testInfo) => {
  const api = 'http://localhost:5221';
  const examples = await readFile(new URL('../../../Flatserve/test/http/Flatserve.http', import.meta.url), 'utf8');
  const example = examples.match(/GET \{\{Flatserve_HostAddress\}\}(\/fgb\/filter\?[^\r\n]+)\r?\nAccept: ([^\r\n]+)/)!;
  const exampleUrl = new URL(example[1], api);
  const name = exampleUrl.searchParams.get('value')!;
  const url = filterUrl(api, name).href;
  expect(new URL(url).pathname).toBe(exampleUrl.pathname);
  expect(Object.fromEntries(new URL(url).searchParams)).toEqual(Object.fromEntries(exampleUrl.searchParams));

  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
  await page.goto('./');

  // This context has no API connections yet. Inspect the first exchange and a repeat,
  // using the testing file's Accept header and the exact URL the UI will request.
  const samples = [];
  for (const phase of ['first browser connection', 'reused browser connection']) {
    const sample = await page.evaluate(async ({ url, accept }) => {
      const started = performance.now();
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit', headers: { Accept: accept } });
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      const finished = performance.now();
      return { status: response.status, bytes, totalMs: finished - started };
    }, { url, accept: example[2] });
    expect(sample.status).toBe(200);
    const timing = await page.evaluate((url) => {
      const entry = performance.getEntriesByName(url, 'resource').at(-1) as PerformanceResourceTiming;
      return { startTime: entry.startTime, requestStart: entry.requestStart, responseEnd: entry.responseEnd,
        connectStart: entry.connectStart, connectEnd: entry.connectEnd,
        httpMs: entry.responseEnd - entry.requestStart };
    }, url);
    expect(timing.requestStart).toBeGreaterThan(0);
    expect(timing.requestStart).toBeGreaterThanOrEqual(timing.startTime);
    expect(timing.responseEnd).toBeGreaterThan(timing.requestStart);
    samples.push({ phase, ...timing, totalMs: sample.totalMs, bytes: sample.bytes.length });

    // Exercise the .http request outside the browser too; timing is diagnostic,
    // since this client also includes its own connection and scheduling overhead.
    const started = performance.now();
    const response = await request.get(url, { headers: { Accept: example[2] } });
    const body = await response.body();
    expect(response.ok()).toBe(true);
    expect(response.headers()['timing-allow-origin']).toBe('*');
    expect(body).toEqual(Buffer.from(sample.bytes));
    samples.push({ phase: `testing-file client after ${phase}`, totalMs: performance.now() - started, bytes: body.length });
  }

  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/);
  const select = page.getByLabel('Brannvesen', { exact: true });
  await expect(select.locator('option', { hasText: name })).toHaveCount(1);
  await select.selectOption(name);
  const filter = page.getByRole('button', { name: 'Filter', exact: true });
  const filterPoints = page.locator('.timings-point[aria-label*="/filter?"]');
  for (let i = 0; i < 3; i++) {
    await filter.click();
    await expect(filterPoints).toHaveCount(i + 1);
    await expect(page.getByRole('status')).toHaveText('7 features matching filter');
    await filterPoints.last().click();
    const dialog = page.getByRole('dialog', { name: 'Request details' });
    const value = (label: string) => dialog.getByRole('row').filter({
      has: page.getByRole('rowheader', { name: label, exact: true }),
    }).getByRole('cell');
    await expect(value('API URL')).toHaveText(url);
    const timing = await page.evaluate((url) => {
      const entry = performance.getEntriesByName(url, 'resource').at(-1) as PerformanceResourceTiming;
      return { startTime: entry.startTime, requestStart: entry.requestStart, responseEnd: entry.responseEnd,
        httpMs: entry.responseEnd - entry.requestStart };
    }, url);
    expect(timing.requestStart).toBeGreaterThan(0);
    await expect(value('HTTP duration')).toHaveText(`${timing.httpMs.toFixed(1)} ms`);
    const totalMs = parseFloat(await value('Browser total').innerText());
    expect(totalMs).toBeGreaterThanOrEqual(timing.httpMs);
    samples.push({ phase: `UI filter ${i + 1}`, ...timing, totalMs });
    await expect(dialog).toContainText('It excludes queueing, DNS, and connection setup.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    if (i < 2) {
      await filter.click();
      await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/);
    }
  }
  const reportPath = testInfo.outputPath('http-timing-comparison.json');
  await writeFile(reportPath, JSON.stringify({ url, samples }, null, 2));
  await testInfo.attach('http-timing-comparison', { path: reportPath, contentType: 'application/json' });
});
