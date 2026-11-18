import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './helpers';
import { encoded, headerOnly, multipartEncoded } from '../fixtures';
import type { Feature } from 'geojson';

interface ProfileMetrics {
  measuring: boolean; started: number; displayMs: number; longTasks: number[]; workerDecodeMs: number[];
  decodeRoundTripMs: number[]; fullArraysToWorker: number; binaryTransfers: number; detachedTransfers: number; preparations: number;
}
const count = 50_000;
const layer = (offset: number) => encoded(Array.from({ length: count / 2 }, (_, i): Feature => ({
  type: 'Feature', properties: { gml_id: `point-${offset + i}`, brannvesen: 'All', name: `Station ${offset + i} – Øst` },
  geometry: { type: 'Point', coordinates: [6 + (i % 500) / 100, 58 + Math.floor(i / 500) / 100] },
})));
const first = layer(0), second = layer(count / 2);
const body = Buffer.from(multipartEncoded([{ id: 'first', bytes: first }, { id: 'second', bytes: second }]));

test('profiles binary download, decoding and display of 50,000 multipart features', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(({ count }) => {
    const metrics = { measuring: false, started: 0, displayMs: 0, longTasks: [] as number[],
      workerDecodeMs: [] as number[], decodeRoundTripMs: [] as number[], fullArraysToWorker: 0,
      binaryTransfers: 0, detachedTransfers: 0, preparations: 0 };
    (window as unknown as { decodeProfile: typeof metrics }).decodeProfile = metrics;
    new PerformanceObserver((list) => {
      if (metrics.measuring) for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
    new MutationObserver(() => {
      if (metrics.measuring && !metrics.displayMs && document.querySelector('[role="status"]')?.textContent === `${count.toLocaleString('en-US')} features matching filter`) {
        metrics.displayMs = performance.now() - metrics.started;
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    const fetchOriginal = window.fetch;
    window.fetch = function (input, options) {
      if (String(input).includes('decode-profile.example/fgb/filter?')) metrics.started = performance.now();
      return fetchOriginal.call(this, input, options);
    };
    const post = Worker.prototype.postMessage;
    const observed = new WeakSet<Worker>(), sent = new Map<number, number>();
    Worker.prototype.postMessage = function (message, options) {
      if ((message?.type === 'data' || message?.type === 'decode') && !observed.has(this)) {
        observed.add(this);
        this.addEventListener('message', ({ data }) => {
          if (metrics.measuring && data.type === 'decoded') {
            metrics.workerDecodeMs.push(data.dataset.decodeMs);
            metrics.decodeRoundTripMs.push(performance.now() - sent.get(data.request)!);
          }
        });
      }
      if (metrics.measuring && message?.type === 'data') {
        metrics.preparations++;
        if (Array.isArray(message.features)) metrics.fullArraysToWorker++;
      }
      const buffers: ArrayBuffer[] = message?.type === 'decode' ? message.responses.map((response: { buffer: ArrayBuffer }) => response.buffer) : [];
      if (metrics.measuring && buffers.length) {
        metrics.binaryTransfers += buffers.length; sent.set(message.request, performance.now());
      }
      const result = post.call(this, message, options as StructuredSerializeOptions);
      if (metrics.measuring) metrics.detachedTransfers += buffers.filter((buffer) => buffer.byteLength === 0).length;
      return result;
    };
  }, { count });
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
  await page.route('https://decode-profile.example/fgb/style', (route) => route.fulfill({ status: 404 }));
  await page.route('https://decode-profile.example/fgb/indexes', (route) => route.fulfill({ json: { layers: [{ id: 'first',
    indexes: [{ attribute: 'brannvesen', values: ['All'] }] }] } }));
  await page.route('https://decode-profile.example/fgb/collection?**', (route) => route.fulfill({ body: Buffer.from(headerOnly(first)) }));
  await page.route('https://decode-profile.example/fgb/filter?**', (route) => route.fulfill({ body, contentType: 'multipart/mixed; boundary=fgb-test' }));
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('https://decode-profile.example');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('No features found.');
  await page.getByLabel('Brannvesen', { exact: true }).selectOption('All');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  await page.evaluate(() => { (window as unknown as { decodeProfile: ProfileMetrics }).decodeProfile.measuring = true; });
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(`${count.toLocaleString('en-US')} features matching filter`, { timeout: 90_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const metrics = await page.evaluate(() => {
    const metrics = (window as unknown as { decodeProfile: ProfileMetrics }).decodeProfile;
    metrics.measuring = false; return metrics;
  });
  const { profile } = await cdp.send('Profiler.stop');
  const idle = new Set(profile.nodes.filter((node) => ['(idle)', '(program)', '(root)'].includes(node.callFrame.functionName)).map((node) => node.id));
  const activeCpuMs = (profile.samples ?? []).reduce((sum, id, i) => sum + (idle.has(id) ? 0 : (profile.timeDeltas?.[i] ?? 0)), 0) / 1000;
  const report = { fixture: { features: count, bytes: body.length, layers: 2 }, activeCpuMs, ...metrics };
  await writeFile(testInfo.outputPath('decode-profile.json'), JSON.stringify(report, null, 2));
  await writeFile(testInfo.outputPath('decode.cpuprofile'), JSON.stringify(profile));
  await testInfo.attach('decode-profile', { path: testInfo.outputPath('decode-profile.json'), contentType: 'application/json' });
  if (!process.env.DECODE_BASELINE) {
    expect(report).toMatchObject({ fullArraysToWorker: 0, binaryTransfers: 1, detachedTransfers: 1 });
    expect(report.workerDecodeMs).toHaveLength(1);
    expect(report.displayMs).toBeGreaterThan(0);
  }
});
