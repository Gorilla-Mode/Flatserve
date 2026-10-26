import { expect } from '@playwright/test';
import { expectSidebarLayout, test } from './helpers';

test('Google Fonts loads JetBrains Mono and preserves the live page layout', async ({ page }) => {
  test.skip(process.env.FLATSERVE_LIVE_FONTS !== '1', 'Requires the live Google Fonts service.');
  test.setTimeout(90_000);
  // Font delivery is live; isolate this check from the unrelated tile service.
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [] },
  }));
  const loaded: string[] = [];
  page.on('response', (response) => {
    if (response.ok() && /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(response.url())) loaded.push(response.url());
  });
  await page.goto('./');
  const weights = await page.evaluate(async () => {
    const faces = await Promise.all([400, 600, 700].map((weight) => document.fonts.load(`${weight} 14px "JetBrains Mono"`)));
    return faces.map((fonts) => fonts.length > 0 && fonts.every((font) => font.status === 'loaded'));
  });
  expect(weights).toEqual([true, true, true]);
  expect(loaded.some((url) => url.startsWith('https://fonts.googleapis.com/'))).toBe(true);
  expect(loaded.some((url) => url.startsWith('https://fonts.gstatic.com/'))).toBe(true);
  for (const width of [1280, 375, 280]) {
    await page.setViewportSize({ width, height: 700 });
    const dialog = page.getByRole('dialog');
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(dialog).toHaveCSS('font-family', /JetBrains Mono/);
    await page.screenshot({ path: `test-results/font-dialog-${width}.png` });
  }
  await page.getByLabel('API URL', { exact: true }).fill('http://localhost:5221');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('639 features in view');
  for (const width of [1280, 375, 280]) {
    await page.setViewportSize({ width, height: 700 });
    await expectSidebarLayout(page);
    await page.screenshot({ path: `test-results/font-layout-${width}.png` });
  }
});
