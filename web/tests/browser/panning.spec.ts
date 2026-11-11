import { expect } from '@playwright/test';
import { test, moveOnMap } from './helpers';
import { encoded } from '../fixtures';
import type { Feature } from 'geojson';
import { writeFile } from 'node:fs/promises';
import { geometryIntersectsBounds } from '../../src/geometry';
import type { ViewQuery, ViewResult } from '../../src/spatialIndex';

declare global {
  interface Window {
    panningState: { query: ViewQuery | null; result: ViewResult | null };
  }
}

const features: Feature[] = Array.from({ length: 240 }, (_, index) => {
  const x = 5 + (index % 20) * 1.3;
  const y = 58 + Math.floor(index / 20) * 1.1;
  const ring = Array.from({ length: 513 }, (_, vertex) => {
    const angle = vertex / 512 * Math.PI * 2;
    return [x + Math.cos(angle) * .4, y + Math.sin(angle) * .2];
  });
  return { type: 'Feature', properties: { fixture: index }, geometry: { type: 'Polygon', coordinates: [ring] } };
});
const body = Buffer.from(encoded(features));

for (const bbox of [false, true]) test(`profiles polygon-heavy ${bbox ? 'BBox' : 'viewport'} dragging within coverage`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const metrics = { datasetUploads: 0, featureSerializations: 0, boundsMessages: 0, batches: 0 };
    Object.assign(window, { panningMetrics: metrics });
    window.panningState = { query: null, result: null };
    const observed = new WeakSet<Worker>();
    const stringify = JSON.stringify;
    JSON.stringify = function (value, ...args) {
      if (value && (value.type === 'FeatureCollection' || (Array.isArray(value) && value[0]?.type === 'Feature')))
        metrics.featureSerializations++;
      return stringify(value, ...args as [never, never]);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'LD' && !['query-bbox', 'fetched-buffer', 'authorized-area'].includes(message.data?.source)) metrics.datasetUploads++;
      if (message?.type === 'bounds') {
        metrics.boundsMessages++;
        window.panningState.query = message;
      }
      if (message?.type === 'data') {
        metrics.batches++;
        if (!observed.has(this)) {
          observed.add(this);
          this.addEventListener('message', ({ data }) => { window.panningState.result = data; });
        }
      }
      return post.call(this, message, args[0] as StructuredSerializeOptions);
    };
  });
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
  await page.route('https://pan.example/fgb/style', (route) => route.fulfill({ status: 404 }));
  await page.route('https://pan.example/fgb/indexes', (route) => route.fulfill({ json: { layers: [] } }));
  let requests = 0;
  await page.route('https://pan.example/fgb/collection?**', (route) => {
    requests++;
    return route.fulfill({ contentType: 'application/octet-stream', body });
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('https://pan.example');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('240 features in view');
  if (bbox) {
    await page.getByRole('button', { name: 'BBox', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/^\d+ features in bbox$/);
  }
  await page.waitForTimeout(500);
  const before = requests;
  await page.evaluate(() => {
    const metrics = (window as unknown as { panningMetrics: Record<string, number> }).panningMetrics;
    Object.keys(metrics).forEach((key) => { metrics[key] = 0; });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  const initial = await page.getByRole('status').innerText();
  await moveOnMap(page, .7, .55);
  await page.mouse.down();
  for (let step = 1; step <= 20; step++) {
    await moveOnMap(page, .7 - step * .005, .55, 2);
    await page.waitForTimeout(60);
  }
  if (bbox) await expect(page.getByRole('status')).not.toHaveText(initial);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const { profile } = await cdp.send('Profiler.stop');
  const metrics = await page.evaluate(() => (window as unknown as { panningMetrics: Record<string, number> }).panningMetrics);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const activeCpuMs = (profile.samples ?? []).reduce((sum, id, index) => sum + (['(idle)', '(program)'].includes(nodes.get(id) ?? '') ? 0 : (profile.timeDeltas?.[index] ?? 0)), 0) / 1000;
  await testInfo.attach('panning-profile', { body: JSON.stringify({ ...metrics, requests: requests - before, activeCpuMs }), contentType: 'application/json' });
  await testInfo.attach('cpu-profile', { body: JSON.stringify(profile), contentType: 'application/json' });
  await writeFile(testInfo.outputPath('panning-profile.json'), JSON.stringify({ ...metrics, requests: requests - before, activeCpuMs }, null, 2));
  await writeFile(testInfo.outputPath('panning.cpuprofile'), JSON.stringify(profile));
  console.log({ bbox, ...metrics, requests: requests - before, activeCpuMs });
  expect(requests).toBe(before);
  if (!process.env.PANNING_BASELINE) {
    expect(metrics.datasetUploads).toBe(0);
    expect(metrics.featureSerializations).toBe(0);
    expect(metrics.batches).toBe(0);
    expect(metrics.boundsMessages).toBeGreaterThan(5);
    expect(metrics.boundsMessages).toBeLessThan(25);
    await expect.poll(async () => page.evaluate(() => window.panningState.result?.sequence === window.panningState.query?.sequence)).toBe(true);
    const query = await page.evaluate(() => window.panningState.query!);
    const expectedCount = features.filter((feature) => geometryIntersectsBounds(feature.geometry, query.bounds)).length;
    await expect(page.getByRole('status')).toHaveText(`${expectedCount} features in ${bbox ? 'bbox' : 'view'}`);
  }
});
