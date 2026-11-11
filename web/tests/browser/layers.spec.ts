import { expect } from '@playwright/test';
import { test } from './helpers';
import { encoded, headerOnly, multipartEncoded, station } from '../fixtures';

test('shows every multipart layer and toggles visibility without fetching again', async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
  let requests = 0;
  const layers = [
    { id: 'Stations', bytes: encoded([station('Oslo', 8)]) },
    { id: 'Øst', bytes: encoded([station('Sør', 9)]) },
    { id: 'Empty', bytes: headerOnly(encoded()) },
  ];
  await page.route('http://localhost:5221/fgb/collection?**', (route) => {
    requests++;
    return route.fulfill({ contentType: 'multipart/mixed; boundary="fgb-test"', body: Buffer.from(multipartEncoded(layers)) });
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('2 features in view');
  const list = page.getByRole('region', { name: 'Layers', exact: true });
  await expect(list.getByRole('checkbox')).toHaveCount(3);
  for (const checkbox of await list.getByRole('checkbox').all()) await expect(checkbox).toBeChecked();
  const before = requests;
  await list.getByRole('checkbox', { name: /Øst/ }).uncheck();
  await expect(page.getByRole('status')).toHaveText('1 features in view');
  await list.getByRole('checkbox', { name: /Stations/ }).uncheck();
  await expect(page.getByRole('status')).toHaveText('No features found.');
  await list.getByRole('checkbox', { name: /Øst/ }).check();
  await expect(page.getByRole('status')).toHaveText('1 features in view');
  expect(requests).toBe(before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
