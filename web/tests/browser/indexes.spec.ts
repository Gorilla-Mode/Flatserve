import { expect } from '@playwright/test';
import { test } from './helpers';
import { encoded, multipartEncoded, station } from '../fixtures';

const api = 'http://localhost:5221';

test.beforeEach(async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
  await page.route(`${api}/fgb/collection?**`, (route) => route.fulfill({
    contentType: 'multipart/mixed; boundary=fgb-test',
    body: Buffer.from(multipartEncoded([{ id: 'roads', bytes: encoded([station('not-indexed')]) }])),
  }));
});

test('uses reported attributes and values, resets active filters on index change, and supports empty strings', async ({ page }) => {
  await page.route(`${api}/fgb/indexes`, (route) => route.fulfill({ json: { layers: [
    { id: 'roads', indexes: [{ attribute: 'name', values: ['Øst & West', ''] }] },
    { id: 'zones', indexes: [{ attribute: 'category', values: ['A'] }, { attribute: 'name', values: ['Øst & West'] }] },
  ] } }));
  const queries: URL[] = [];
  await page.route(`${api}/fgb/filter?**`, (route) => {
    queries.push(new URL(route.request().url()));
    return route.fulfill({ body: Buffer.from(encoded([station('match')])), contentType: 'application/vnd.fgb' });
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  const index = page.getByLabel('Index', { exact: true });
  await expect(index.locator('option')).toHaveText(['category', 'name']);
  await expect(page.getByLabel('Brannvesen', { exact: true })).toHaveCount(0);
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await index.selectOption('name');
  const value = page.getByLabel('Name', { exact: true });
  await expect(value.locator('option')).toHaveText(['Select value', '(empty)', 'Øst & West']);
  await value.selectOption('Øst & West');
  const filter = page.getByRole('button', { name: 'Filter', exact: true });
  await filter.click();
  await expect(page.getByRole('status')).toHaveText('1 features matching filter');
  expect(Object.fromEntries(queries[0].searchParams)).toEqual({ attribute: 'name', value: 'Øst & West' });
  await index.selectOption('category');
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(filter).toBeDisabled();
  await index.selectOption('name');
  await value.selectOption('');
  await filter.click();
  await expect.poll(() => queries.length).toBe(2);
  expect(Object.fromEntries(queries[1].searchParams)).toEqual({ attribute: 'name', value: '' });
});

test('shows no indexes and retries metadata errors independently of the map', async ({ page }) => {
  let fail = true;
  await page.route(`${api}/fgb/indexes`, (route) => fail ? route.fulfill({ status: 503 })
    : route.fulfill({ json: { layers: [{ id: 'roads', indexes: [] }] } }));
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill(api);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Indexes: API returned HTTP 503.');
  fail = false;
  await page.getByRole('button', { name: 'Retry indexes' }).click();
  await expect(page.getByText('No text indexes are available.')).toBeVisible();
  await expect(page.getByLabel('Index', { exact: true })).toBeDisabled();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('1 features in view');
  await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeDisabled();
});
