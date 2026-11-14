import { readFile, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test, moveOnMap } from './helpers';
import type { Feature, Position } from 'geojson';
import { encoded, multipartEncoded } from '../fixtures';
import { geometryIntersectsBounds } from '../../src/geometry';
import type { ViewQuery, ViewResult } from '../../src/spatialIndex';

const style = JSON.parse(await readFile(new URL('../data/geoflatpack-style.json', import.meta.url), 'utf8'));
const datasets = Object.keys(style.sources);
const ring = (x: number, y: number, radius: number, vertices = 257): Position[] => Array.from({ length: vertices }, (_, i) => {
  const angle = i / (vertices - 1) * Math.PI * 2;
  return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius / 2];
});
const polygons: Feature[] = Array.from({ length: 180 }, (_, i) => {
  const x = 5 + (i % 18) * 1.4, y = 58 + Math.floor(i / 18) * 1.3;
  return { type: 'Feature', properties: { gml_id: `polygon-${i}`, brannvesen: 'All', __geoflatpack_vertices: '' }, geometry: { type: 'MultiPolygon', coordinates: [
    [ring(x, y, .45), ring(x, y, .1, 65).reverse()], [ring(x + .6, y + .2, .2)],
  ] } };
});
const vertices: Feature[] = polygons.map((feature, i) => ({ type: 'Feature', properties: {
  ...feature.properties, __geoflatpack_vertices: 'Polygon',
}, geometry: { type: 'Point', coordinates: [5 + (i % 18) * 1.4, 58 + Math.floor(i / 18) * 1.3] } }));
const lines: Feature[] = polygons.map((feature, i) => ({ type: 'Feature', properties: { gml_id: `line-${i}`, brannvesen: 'All' },
  geometry: { type: 'MultiLineString', coordinates: [ring(5 + (i % 18) * 1.4, 58 + Math.floor(i / 18) * 1.3, .5, 129)] } }));
const grouped = [[...polygons, ...vertices], lines];
const bodyFor = (groups: Feature[][]) => Buffer.from(multipartEncoded(groups.map((features, i) => ({ id: datasets[i], bytes: encoded(features) }))));
const fullBody = bodyFor(grouped);

interface Metrics {
  frames: number[]; longTasks: number[]; uploads: number; fullUploads: number; diffBytes: number; payloadBytes: number;
  added: number; removed: number; updated: number; layerChanges: number; filterChanges: number;
  sourceCreations: number; layerCreations: number; tileReloads: number; filterTriggeredReloads: number; removedSources: number; boundsQueries: number; preparations: number; workerMs: number[];
}
declare global { interface Window {
  zoomMetrics: Metrics;
  zoomPayloads: { diff: boolean; payload: unknown }[];
  zoomState: { query?: ViewQuery; result?: ViewResult; measuring: boolean; previousFrame: number };
} }

for (const mode of ['static', 'viewport', 'bbox'] as const) test(`profiles generated-style multipart wheel zoom: ${mode}`, async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const metrics: Metrics = { frames: [], longTasks: [], uploads: 0, fullUploads: 0, diffBytes: 0, payloadBytes: 0,
      added: 0, removed: 0, updated: 0, layerChanges: 0, filterChanges: 0,
      sourceCreations: 0, layerCreations: 0, tileReloads: 0, filterTriggeredReloads: 0, removedSources: 0, boundsQueries: 0, preparations: 0, workerMs: [] };
    window.zoomMetrics = metrics;
    window.zoomPayloads = [];
    window.zoomState = { measuring: false, previousFrame: 0 };
    const state = window.zoomState;
    const frame = (time: number) => {
      if (state.measuring && state.previousFrame) metrics.frames.push(time - state.previousFrame);
      state.previousFrame = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new PerformanceObserver((list) => {
      if (state.measuring) for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
    const sources = new Set<string>();
    const layerIds = new Set<string>();
    const filters = new Map<string, string>();
    const filteredSources = new Set<string>();
    const observed = new WeakSet<Worker>();
    const post = Worker.prototype.postMessage;
    const started = new Map<number, number>();
    const datasetSource = (source: string) => source?.startsWith('flatserve-');
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'data') {
        if (state.measuring) { metrics.preparations++; started.set(message.version, performance.now()); }
        if (!observed.has(this)) {
          observed.add(this);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'prepared') {
              const time = started.get(data.delta.version);
              if (time !== undefined) { metrics.workerMs.push(performance.now() - time); started.delete(data.delta.version); }
            } else if (data.sequence !== undefined) state.result = data;
          });
        }
      }
      if (message?.type === 'bounds') { state.query = message; if (state.measuring) metrics.boundsQueries++; }
      if (message?.type === 'LD' && datasetSource(message.data?.source)) {
        const source = message.data.source;
        if (!sources.has(source)) { sources.add(source); if (state.measuring) metrics.sourceCreations++; }
        if (state.measuring) {
          metrics.uploads++;
          filteredSources.delete(source);
          const diff = message.data.dataDiff;
          // Retain references and count bytes after profiling; serializing large baseline
          // payloads inside this hook would distort the CPU comparison.
          window.zoomPayloads.push({ diff: !!diff, payload: diff ?? message.data.data });
          if (!diff) metrics.fullUploads++;
          else {
            metrics.added += diff.add?.length ?? 0; metrics.removed += diff.remove?.length ?? 0; metrics.updated += diff.update?.length ?? 0;
          }
        }
      }
      if (message?.type === 'UL' || message?.type === 'SL') {
        for (const layer of (message.type === 'SL' ? message.data : message.data.layers) ?? []) if (datasetSource(layer.source)) {
          if (state.measuring) {
            metrics.layerChanges++;
            if (!layerIds.has(layer.id)) metrics.layerCreations++;
            if (filters.get(layer.id) !== JSON.stringify(layer.filter)) {
              metrics.filterChanges++; filteredSources.add(layer.source);
            }
          }
          layerIds.add(layer.id); filters.set(layer.id, JSON.stringify(layer.filter));
        }
      }
      if (state.measuring && message?.type === 'RT' && datasetSource(message.data?.source)) {
        metrics.tileReloads++;
        if (filteredSources.has(message.data.source)) metrics.filterTriggeredReloads++;
      }
      if (state.measuring && message?.type === 'RS' && datasetSource(message.data?.source)) metrics.removedSources++;
      return post.call(this, message, args[0] as StructuredSerializeOptions);
    };
  });
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0c0c0c' } },
  ] } }));
  await page.route('https://zoom.example/fgb/style', (route) => route.fulfill({ json: style }));
  await page.route('https://zoom.example/fgb/indexes', (route) => route.fulfill({ json: { layers: [{ id: datasets[0],
    indexes: [{ attribute: 'brannvesen', values: ['All'] }] }] } }));
  let requests = 0;
  await page.route('https://zoom.example/fgb/filter?**', (route) => route.fulfill({ contentType: 'multipart/mixed; boundary=fgb-test', body: fullBody }));
  await page.route('https://zoom.example/fgb/collection?**', (route) => {
    requests++;
    const params = new URL(route.request().url()).searchParams;
    const bounds = { minX: Number(params.get('minX')), minY: Number(params.get('minY')),
      maxX: Number(params.get('maxX')), maxY: Number(params.get('maxY')) };
    const groups = grouped.map((features) => features.filter((feature) => geometryIntersectsBounds(feature.geometry, [bounds])));
    return route.fulfill({ contentType: 'multipart/mixed; boundary=fgb-test', body: bodyFor(groups) });
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('https://zoom.example');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('540 features in view');
  await expect(page.locator('.layer-list small', { hasText: /^Styled$/ })).toHaveCount(2);
  await moveOnMap(page, .5, .5);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(700);
  if (mode === 'static') {
    await page.getByLabel('Brannvesen', { exact: true }).selectOption('All');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('540 features matching filter');
  } else {
    if (mode === 'bbox') await page.getByRole('button', { name: 'BBox', exact: true }).click();
    await page.getByRole('button', { name: 'Buffer', exact: true }).click();
    await expect(page.getByRole('status')).not.toContainText('Loading');
  }
  await moveOnMap(page, .5, .5);
  await page.waitForTimeout(500);
  const before = requests;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  await page.evaluate(() => { window.zoomState.measuring = true; window.zoomState.previousFrame = 0; });
  // Expand beyond completed request coverage repeatedly, then exercise retained geometry while zooming in.
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, i < 9 ? 45 : -45);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.zoomState.measuring = false; });
  const { profile } = await cdp.send('Profiler.stop');
  const metrics = await page.evaluate(() => {
    for (const { diff, payload } of window.zoomPayloads) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
      window.zoomMetrics.payloadBytes += bytes;
      if (diff) window.zoomMetrics.diffBytes += bytes;
    }
    return window.zoomMetrics;
  });
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const activeCpuMs = (profile.samples ?? []).reduce((sum, id, i) => sum + (['(idle)', '(program)'].includes(nodes.get(id) ?? '') ? 0 : (profile.timeDeltas?.[i] ?? 0)), 0) / 1000;
  const sorted = [...metrics.frames].sort((a, b) => a - b);
  const result = { mode, baseline: !!process.env.ZOOM_BASELINE, requests: requests - before, activeCpuMs,
    ...metrics, frameP95: sorted[Math.floor(sorted.length * .95)], maxFrame: Math.max(...sorted) };
  await writeFile(testInfo.outputPath('zoom-profile.json'), JSON.stringify(result, null, 2));
  await testInfo.attach('zoom-profile', { body: JSON.stringify(result), contentType: 'application/json' });
  await testInfo.attach('zoom-cpu-profile', { body: JSON.stringify(profile), contentType: 'application/json' });
  await writeFile(testInfo.outputPath('zoom.cpuprofile'), JSON.stringify(profile));
  console.log({ mode, activeCpuMs, frameP95: result.frameP95, uploads: metrics.uploads, diffBytes: metrics.diffBytes,
    fullUploads: metrics.fullUploads, preparations: metrics.preparations, requests: result.requests });
  if (!process.env.ZOOM_BASELINE) {
    expect(metrics.fullUploads).toBe(0);
    expect(metrics.sourceCreations).toBe(0);
    expect(metrics.layerCreations).toBe(0);
    expect(metrics.removedSources).toBe(0);
    if (mode === 'static') { expect(result.requests).toBe(0); expect(metrics.uploads).toBe(0); }
    else { expect(result.requests).toBeGreaterThan(2); expect(metrics.uploads).toBeGreaterThan(0); expect(metrics.diffBytes).toBeGreaterThan(0); }
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Compare live counts with exact geometry tests and inspect a real rendered frame.
  await expect.poll(() => page.evaluate(() => window.zoomState.query?.sequence === window.zoomState.result?.sequence)).toBe(true);
  const query = await page.evaluate(() => window.zoomState.query!);
  const count = grouped.flat().filter((feature) => query.text || geometryIntersectsBounds(feature.geometry, query.bounds)).length;
  await expect(page.getByRole('status')).toHaveText(`${count} features ${mode === 'static' ? 'matching filter' : mode === 'bbox' ? 'in bbox' : 'in view'}`);
  const frame = await page.locator('.maplibregl-canvas').screenshot();
  await writeFile(testInfo.outputPath('rendered-zoom.png'), frame);
  await testInfo.attach('rendered-zoom-frame', { body: frame, contentType: 'image/png' });
});

test('retains rendered multipart geometry through identical, reordered and overlapping completed responses', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const uploads: { diff: boolean; added: number; removed: number }[] = [];
    Object.assign(window, { retainedUploads: uploads });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'LD' && message.data?.source?.startsWith('flatserve-')) uploads.push({
        diff: !!message.data.dataDiff, added: message.data.dataDiff?.add?.length ?? 0, removed: message.data.dataDiff?.remove?.length ?? 0,
      });
      return post.call(this, message, args[0] as StructuredSerializeOptions);
    };
  });
  await page.route('https://tiles.openfreemap.org/**', (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0c0c0c' } },
  ] } }));
  await page.route('https://retained.example/fgb/style', (route) => route.fulfill({ json: style }));
  await page.route('https://retained.example/fgb/indexes', (route) => route.fulfill({ json: { layers: [{ id: datasets[0],
    indexes: [{ attribute: 'brannvesen', values: ['All'] }] }] } }));
  const replacement = grouped.map((features) => {
    const retained = features.filter((f) => Number(String(f.properties?.gml_id).split('-')[1]) < 120);
    const added = features.filter((f) => Number(String(f.properties?.gml_id).split('-')[1]) < 30)
      .map((f) => ({ ...f, properties: { ...f.properties, gml_id: `new-${f.properties?.gml_id}` } }));
    return [...retained, ...added];
  });
  let phase = 0;
  let release: (() => void) | undefined;
  let ready: (() => void) | undefined;
  const received = new Promise<void>((resolve) => { ready = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://retained.example/fgb/collection?**', (route) => route.fulfill({ contentType: 'multipart/mixed; boundary=fgb-test', body: fullBody }));
  await page.route('https://retained.example/fgb/filter?**', async (route) => {
    if (phase === 2) { ready!(); await held; }
    const groups = phase === 2 ? replacement : phase === 1 ? grouped.map((features) => [...features].reverse()) : grouped;
    return route.fulfill({ contentType: 'multipart/mixed; boundary=fgb-test', body: bodyFor(groups) });
  });
  await page.goto('./');
  await page.getByLabel('API URL', { exact: true }).fill('https://retained.example');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Select user', { exact: true }).selectOption('2');
  await expect(page.getByRole('status')).toHaveText('540 features in view');
  await expect(page.locator('.layer-list small', { hasText: /^Styled$/ })).toHaveCount(2);
  await page.getByLabel('Brannvesen', { exact: true }).selectOption('All');
  await page.waitForTimeout(200);
  const uploads = () => page.evaluate(() => (window as unknown as { retainedUploads: { diff: boolean; added: number; removed: number }[] }).retainedUploads);
  const initial = (await uploads()).length;
  const filter = page.getByRole('button', { name: 'Filter', exact: true });
  for (phase = 0; phase < 2; phase++) {
    await filter.click();
    await expect(page.getByRole('status')).toHaveText('540 features matching filter');
    await page.waitForTimeout(100);
    expect((await uploads()).length).toBe(initial);
    await filter.click();
    await expect(page.getByRole('status')).toHaveText('540 features in view');
  }
  await filter.click(); await received;
  const hasGeometry = async () => {
    const png = await page.locator('.maplibregl-canvas').screenshot();
    return page.evaluate(async (base64) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > pixels[i + 1] * 1.5 && pixels[i] > pixels[i + 2] * 1.5) red++;
      return red;
    }, png.toString('base64'));
  };
  expect(await hasGeometry()).toBeGreaterThan(100);
  release!();
  // Sample actual frames around the upload, then verify that only absent/new features crossed to MapLibre.
  for (let i = 0; i < 4; i++) expect(await hasGeometry()).toBeGreaterThan(100);
  await expect(page.getByRole('status')).toHaveText('450 features matching filter');
  const changed = (await uploads()).slice(initial);
  expect(changed).toHaveLength(2);
  expect(changed.every((upload) => upload.diff)).toBe(true);
  expect(changed.reduce((sum, upload) => sum + upload.added, 0)).toBe(90);
  expect(changed.reduce((sum, upload) => sum + upload.removed, 0)).toBe(180);
  const frame = await page.locator('.maplibregl-canvas').screenshot();
  await writeFile(testInfo.outputPath('retained-multipart.png'), frame);
  await testInfo.attach('retained-multipart-frame', { body: frame, contentType: 'image/png' });
});
