import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './helpers';
import { encoded, headerOnly, station } from '../fixtures';

test.use({ hasTouch: true });

const base = `https://timings.example/${'long-api-path-'.repeat(18)}`;
const filterName = 'Sør & Øst / '.repeat(25);
const bytes = Buffer.from(encoded([station(filterName)]));
const points = (page: Page) => page.locator('.timings-point');
const details = (page: Page) => page.getByRole('dialog', { name: 'Request details' });

async function connect(page: Page) {
  await page.getByLabel('API URL', { exact: true }).fill(base);
  await page.getByRole('dialog', { name: 'Connect to Flatserve' }).getByRole('button', { name: 'Connect', exact: true }).click();
}

async function assertDetails(page: Page) {
  const dialog = details(page);
  await expect(dialog).toBeVisible();
  const value = (label: string) => dialog.getByRole('row', { name: new RegExp(`^${label} `) }).getByRole('cell');
  const url = await value('API URL').innerText();
  expect(url.startsWith(base)).toBe(true);
  expect(new URL(url).searchParams.size).toBeGreaterThan(0);
  const times = [];
  for (const name of ['Request time', 'Parse time', 'Total time']) {
    await expect(value(name)).toHaveText(/^\d+\.\d ms$/);
    times.push(parseFloat(await value(name).innerText()));
  }
  expect(Math.abs(times[0] + times[1] - times[2])).toBeLessThanOrEqual(.11);
  await expect(dialog).toContainText('Parse time includes downloading and decoding the response body.');
  return { url, request: times[0], total: times[2] };
}

test('empty and single-point charts, both metrics, click/keyboard dismissal and reconnect reset', async ({ page }) => {
  let releaseStyle!: () => void;
  const style = new Promise<void>((resolve) => { releaseStyle = resolve; });
  await page.route('https://tiles.openfreemap.org/**', async (route) => {
    await style;
    await route.fulfill({ json: { version: 8, sources: {}, layers: [] } });
  });
  const requests: string[] = [];
  let hold = false;
  let releaseRequests!: () => void;
  const held = new Promise<void>((resolve) => { releaseRequests = resolve; });
  await page.route('https://timings.example/**', async (route) => {
    requests.push(route.request().url());
    if (hold) await held;
    await route.fulfill({ body: bytes, contentType: 'application/octet-stream' });
  });
  await page.goto('./');
  await expect(page.locator('.timings-chart')).toHaveText('No completed requests yet');
  await connect(page);
  await expect(points(page)).toHaveCount(1);
  const toggle = page.getByRole('button', { name: 'Include parsing' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.timings-metric')).toHaveText('Request');
  await expect(page.locator('.timings-axis').first()).toHaveText('ms');
  await expect(page.locator('.timings-axis').nth(1)).toHaveText('0');
  await expect(page.locator('.timings-chart')).toContainText('Calls');
  await expect(page.locator('.request-timings figcaption')).toHaveText('API requests');
  const chartBox = (await page.locator('.timings-chart').boundingBox())!;
  expect((await toggle.boundingBox())!.y).toBeGreaterThanOrEqual(chartBox.y + chartBox.height);
  await points(page).click();
  const values = await assertDetails(page);
  expect(values.url).toBe(requests[0]);
  await details(page).getByRole('button', { name: 'Close' }).click();
  await expect(points(page)).toBeFocused();
  await expect(points(page)).toHaveAttribute('aria-label', `Call 1, request: ${values.request.toFixed(1)} ms. ${values.url}`);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveCSS('border-color', 'rgb(74, 222, 128)');
  await expect(page.locator('.timings-metric')).toHaveText('Request + parsing');
  await expect(points(page)).toHaveAttribute('aria-label', `Call 1, request + parsing: ${values.total.toFixed(1)} ms. ${values.url}`);
  for (const key of ['Enter', 'Space']) {
    await toggle.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(points(page)).toBeFocused();
    await expect(points(page).locator('.timings-hit')).toHaveCSS('stroke', 'rgb(74, 222, 128)');
    await page.keyboard.press(key);
    expect(await assertDetails(page)).toEqual(values);
    await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);
    await expect(points(page)).toBeFocused();
  }
  expect(requests).toHaveLength(1);
  hold = true;
  await page.locator('.connection-heading button').click();
  await connect(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(points(page)).toHaveCount(0);
  await expect(page.locator('.timings-chart')).toHaveText('No completed requests yet');
  releaseRequests();
  releaseStyle();
  await expect(points(page).first()).toBeVisible();
  await toggle.click();
  await points(page).first().click();
  await page.reload();
  await expect(details(page)).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(points(page)).toHaveCount(0);
});

test('retains ten calls and keeps an evicted selection stable with fallback focus', async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
  await page.route('https://timings.example/**', (route) => route.fulfill({ body: bytes }));
  await page.goto('./');
  await connect(page);
  await expect(page.getByRole('status')).toHaveText('1 features in view');
  await expect(page.getByRole('button', { name: 'Buffer', exact: true })).toBeEnabled();
  await points(page).first().click();
  const selected = await assertDetails(page);
  const label = await points(page).first().getAttribute('aria-label');
  // Simulate ongoing application updates while the native modal blocks user input.
  for (let i = 0; i < 11; i++) {
    const before = await points(page).last().getAttribute('aria-label');
    await page.getByRole('button', { name: 'Buffer', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(points(page).last()).not.toHaveAttribute('aria-label', before!);
  }
  await expect(points(page)).toHaveCount(10);
  await expect(page.locator('.timings-call-tick')).toHaveCount(10);
  const ids = await points(page).evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')!.match(/^Call (\d+),/)![1]));
  await expect(page.locator('.timings-call-tick text')).toHaveText(ids);
  expect(await page.locator('.timings-point').evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))).not.toContain(label);
  expect(await assertDetails(page)).toEqual(selected);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Include parsing' })).toBeFocused();
  for (const width of [1280, 375, 280]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.locator('.timings-call-tick')).toHaveCount(10);
    await page.locator('.request-timings').scrollIntoViewIfNeeded();
    await expect.poll(() => points(page).evaluateAll((elements) => elements.every((element) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.timings-point') === element;
    }))).toBe(true);
    await page.screenshot({ path: `test-results/timings-ten-calls-${width}.png` });
  }
});

for (const width of [1280, 375, 280]) {
  test(`chart and long URL dialog fit at ${width}px, including empty filter success`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
    const requests: string[] = [];
    await page.route('https://timings.example/**', (route) => {
      requests.push(route.request().url());
      return route.fulfill({ body: route.request().url().includes('/filter?') ? Buffer.from(headerOnly(bytes)) : bytes });
    });
    await page.goto('./');
    await connect(page);
    await expect(page.getByRole('status')).toHaveText('1 features in view');
    await page.getByLabel('Brannvesen', { exact: true }).selectOption(filterName);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('No features found.');
    await expect(points(page).last()).toHaveAttribute('aria-label', /\/filter\?/);
    await page.locator('.request-timings').scrollIntoViewIfNeeded();
    const chart = await page.locator('.timings-chart').boundingBox();
    const sidebar = await page.locator('.controls').boundingBox();
    expect(chart!.x + chart!.width).toBeLessThanOrEqual(sidebar!.width);
    expect(await page.locator('.controls').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/timings-chart-${width}.png` });
    const count = requests.length;
    if (width < 400) await points(page).last().tap();
    else await points(page).last().click();
    const selected = await assertDetails(page);
    expect(selected.url).toBe(requests.at(-1));
    expect(new URL(selected.url).searchParams.get('value')).toBe(filterName);
    const dialog = details(page);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    await expect(dialog.locator('.timing-url')).toHaveCSS('user-select', 'text');
    await page.screenshot({ path: `test-results/timings-dialog-${width}.png` });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Include parsing' }).click();
    expect(requests).toHaveLength(count);
  });
}
