import { expect } from '@playwright/test';
import { test } from './helpers';

const api = 'http://localhost:5221';

test.beforeEach(async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
});

test('discovers before selection, supports keyboard selection, preserves settings and active filters, and resets on reconnect', async ({ page }) => {
  const requests: URL[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/fgb/')) requests.push(new URL(request.url()));
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  const user = page.getByLabel('Select user', { exact: true });
  const attribute = page.getByLabel('Brannvesen', { exact: true });
  const filter = page.getByRole('button', { name: 'Filter', exact: true });
  const bbox = page.getByRole('button', { name: 'BBox', exact: true });
  const buffer = page.getByRole('button', { name: 'Buffer', exact: true });
  const show = page.getByRole('button', { name: 'Show buffer', exact: true });
  await expect(user).toHaveValue('');
  await expect(user.locator('option')).toHaveText(['Select user…', 'Agder', 'Oslo', 'Norway']);
  await expect(attribute.locator('option', { hasText: 'Oslo brann- og redningsetat' })).toHaveCount(1);
  const catalog = await attribute.locator('option').allTextContents();
  await attribute.selectOption({ label: 'Oslo brann- og redningsetat' });
  await expect(filter).toBeDisabled();
  await bbox.click();
  await show.click();
  await expect(page.getByRole('status')).toHaveText('Select a user to load stations.');
  await page.waitForTimeout(200);
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('userId')).toBe('2');
  expect(requests[0].searchParams.get('minX')).toBe('-180');
  const showBox = (await show.boundingBox())!;
  const userBox = (await user.boundingBox())!;
  expect(userBox.y).toBeGreaterThanOrEqual(showBox.y + showBox.height);
  await user.focus();
  await expect(user).toBeFocused();
  await page.keyboard.press('a');
  await page.keyboard.press('Tab');
  await expect(user).toHaveValue('0');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  await buffer.click();
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  const reference = requests.at(-1)!;
  const spatialBounds = (url: URL) => ['minX', 'minY', 'maxX', 'maxY'].map((key) => url.searchParams.get(key));
  // Identical request bounds prove that user switches preserve the camera and BBox/Buffer settings.
  for (const id of ['1', '2', '0']) {
    const before = requests.length;
    const timingCount = await page.locator('.timings-point').count();
    await user.selectOption(id);
    await expect.poll(() => requests.length).toBe(before + 1);
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
    expect(requests.at(-1)!.searchParams.get('userId')).toBe(id);
    expect(spatialBounds(requests.at(-1)!)).toEqual(spatialBounds(reference));
    expect(await attribute.locator('option').allTextContents()).toEqual(catalog);
    await expect(attribute).toHaveValue('Oslo brann- og redningsetat');
    await expect(bbox).toHaveAttribute('aria-pressed', 'true');
    await expect(buffer).toHaveAttribute('aria-pressed', 'false');
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.timings-point')).toHaveCount(timingCount + 1);
  }
  await filter.click();
  await expect(page.getByRole('status')).toHaveText('7 features matching filter');
  const filterUrl = requests.at(-1)!.href;
  for (const id of ['1', '2']) {
    const before = requests.length;
    await user.selectOption(id);
    await expect.poll(() => requests.length).toBe(before + 1);
    await expect(page.getByRole('status')).toHaveText('7 features matching filter');
    expect(requests.at(-1)!.href).toBe(filterUrl);
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(attribute).toHaveValue('Oslo brann- og redningsetat');
  }
  expect(requests.filter((url) => url.searchParams.get('minX') === '-180')).toHaveLength(1);
  await filter.click();
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  expect(spatialBounds(requests.at(-1)!)).toEqual(spatialBounds(reference));
  await page.locator('.connection-heading button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(user).toHaveValue('');
  await expect(attribute).toHaveValue('');
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toHaveText('Select a user to load stations.');
  await expect(page.locator('.timings-point')).toHaveCount(1);
  await user.selectOption('0');
  await page.reload();
  await expect(user).toHaveValue('');
  await expect(page.getByRole('dialog')).toBeVisible();
});

for (const id of ['0', '1']) {
  test(`discovery and its retry use Norway when user ${id} is chosen before connecting`, async ({ page }) => {
    const discovery: URL[] = [];
    let fail = true;
    await page.route(`${api}/fgb/collection?**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('minX') !== '-180') return route.continue();
      discovery.push(url);
      if (fail) return route.fulfill({ status: 503, body: 'Offline' });
      return route.continue();
    });
    await page.goto('./');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    const user = page.getByLabel('Select user', { exact: true });
    await expect(user).toBeEnabled();
    await user.selectOption(id);
    await page.locator('.connection-heading button').click();
    await page.getByLabel('API URL', { exact: true }).fill(api);
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(user).toHaveValue(id);
    await expect(page.getByRole('alert')).toContainText('Filters: API returned HTTP 503.');
    fail = false;
    await page.getByRole('button', { name: 'Retry filters', exact: true }).click();
    await expect(page.getByLabel('Brannvesen', { exact: true }).locator('option', { hasText: 'Oslo brann- og redningsetat' })).toHaveCount(1);
    expect(discovery).toHaveLength(2);
    expect(discovery.every((url) => url.searchParams.get('userId') === '2')).toBe(true);
  });
}

test('switching users cancels a pending map response without restarting pending discovery', async ({ page }) => {
  const requests: URL[] = [];
  let releaseDiscovery!: () => void;
  let releaseMap!: () => void;
  const heldDiscovery = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  const heldMap = new Promise<void>((resolve) => { releaseMap = resolve; });
  let aborted = false;
  let finished = false;
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).searchParams.get('userId') === '0') aborted = true;
  });
  await page.route(`${api}/fgb/collection?**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const response = await route.fetch();
    if (url.searchParams.get('minX') === '-180') await heldDiscovery;
    else if (url.searchParams.get('userId') === '0') await heldMap;
    await route.fulfill({ response });
    if (url.searchParams.get('userId') === '0') finished = true;
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  const user = page.getByLabel('Select user', { exact: true });
  await user.selectOption('0');
  await expect(page.getByRole('status')).toContainText('Loading');
  await user.selectOption('1');
  await expect(page.getByRole('status')).toHaveText(/^\d+ features in view$/);
  await expect.poll(() => aborted).toBe(true);
  const status = await page.getByRole('status').innerText();
  releaseMap();
  await expect.poll(() => finished).toBe(true);
  await expect(page.getByRole('status')).toHaveText(status);
  await expect(page.getByText('Loading filter values…')).toBeVisible();
  expect(requests.filter((url) => url.searchParams.get('minX') === '-180')).toHaveLength(1);
  releaseDiscovery();
  await expect(page.getByLabel('Brannvesen', { exact: true }).locator('option', { hasText: 'Oslo brann- og redningsetat' })).toHaveCount(1);
  await expect(user).toHaveValue('1');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
