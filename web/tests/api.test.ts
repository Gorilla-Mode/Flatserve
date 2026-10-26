import { readFile } from 'node:fs/promises';
import { deserialize } from 'flatgeobuf/geojson';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HeaderMeta } from '../src/api';
import { collectionUrl, decodeResponse, filterUrl, normalizeApiUrl } from '../src/api';
import { WORLD } from '../src/bounds';

const base = normalizeApiUrl(process.env.FLATSERVE_API_URL ?? 'http://localhost:5220');
let originalHeader: HeaderMeta;
beforeAll(async () => {
  const bytes = new Uint8Array(await readFile(new URL(
    '../../Flatserve/test/fgb/Samfunnssikkerhet_0000_Norge_25833_Brannstasjoner_GML.fgb', import.meta.url,
  )));
  let count = 0;
  for await (const _feature of deserialize(bytes, { headerMetaFn: (header) => { originalHeader = header; } })) count++;
  expect(count).toBe(639);
  expect(originalHeader.indexNodeSize).toBeGreaterThan(0);
});

async function check(url: URL, count: number) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let header: HeaderMeta | undefined;
  const features = await decodeResponse(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
      controller.close();
    },
  })), { signal: new AbortController().signal, onHeader: (h) => { header = h; } });
  expect(header).toEqual({ ...originalHeader, featuresCount: 0, indexNodeSize: 0 });
  expect(features).toHaveLength(count);
  expect(Array.from(bytes.slice(0, 4))).toEqual([0x66, 0x67, 0x62, 0x03]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let offset = 12 + view.getUint32(8, true);
  let records = 0;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true);
    expect(length).toBeGreaterThan(0);
    offset += 4 + length;
    records++;
  }
  expect(offset).toBe(bytes.length);
  expect(records).toBe(count);
  return features;
}

describe('live backend FlatGeobuf exports', () => {
  it('decodes all 639 features', async () => { await check(collectionUrl(base, WORLD), 639); });
  it.each([
    ['Kristiansand centre', 7.95, 58.10, 8.08, 58.20, 1],
    ['Greater Kristiansand', 7.75, 58.0, 8.30, 58.35, 4],
    ['Oslo', 10.5, 59.8, 10.95, 60.05, 12],
    ['existing full extent', 4, 58, 32, 72, 639],
  ])('decodes %s', async (_name, minX, minY, maxX, maxY, count) => {
    await check(collectionUrl(base, { minX, minY, maxX, maxY }), count);
  });
  it.each(['Oslo brann- og redningsetat', 'Kristiansandsregionen BR'])(
    'decodes seven matches for %s', async (name) => {
      const features = await check(filterUrl(base, name), 7);
      expect(features.every((feature) => feature.properties?.brannvesen === name)).toBe(true);
    },
  );
  it('decodes a single feature with its length prefix', async () => {
    await check(new URL('fgb/feature/0', base), 1);
  });
  it('returns header-only responses for empty spatial/text/unknown-attribute results', async () => {
    await check(collectionUrl(base, { minX: -1, minY: -1, maxX: 1, maxY: 1 }), 0);
    await check(filterUrl(base, 'No such brannvesen'), 0);
    const unknown = filterUrl(base, 'anything');
    unknown.searchParams.set('attribute', 'missing');
    await check(unknown, 0);
    // Exporting subsets must not change the original spatial-index search parameters.
    await check(collectionUrl(base, WORLD), 639);
  });
  it('allows browser GETs without credentials, and does not allow POST', async () => {
    const response = await fetch(new URL('fgb/feature/0', base), { headers: { Origin: 'https://example.github.io' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    const preflight = await fetch(new URL('fgb/collection', base), {
      method: 'OPTIONS', headers: {
        Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'POST',
      },
    });
    expect(preflight.headers.get('access-control-allow-methods')?.split(',')).not.toContain('POST');
  });
  it('keeps validation errors and returns 404 for invalid feature indexes', async () => {
    expect((await fetch(new URL('fgb/collection', base))).status).toBe(400);
    expect((await fetch(collectionUrl(base, { minX: 20, minY: 0, maxX: 10, maxY: 10 }))).status).toBe(400);
    expect((await fetch(new URL('fgb/feature/-1', base))).status).toBe(404);
    expect((await fetch(new URL('fgb/feature/639', base))).status).toBe(404);
  });
});
