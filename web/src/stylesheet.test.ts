import { afterEach, expect, it, vi } from 'vitest';
import type { Map, StyleSpecification } from 'maplibre-gl';
import { fetchStylesheet, renderStyledLayers } from './stylesheet';
import { prepareBatch } from './dataset';
import { emptySnapshot, materialize, SnapshotDiffer } from './snapshot';
import { station } from '../tests/fixtures';

afterEach(() => { vi.unstubAllGlobals(); });
const style: StyleSpecification = {
  version: 8, sources: { roads: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    points: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
  layers: [
    { id: 'background', type: 'background' },
    { id: 'road-line', type: 'line', source: 'roads', filter: ['==', ['get', 'kind'], 'road'],
      paint: { 'line-color': '#ff0000' }, minzoom: 2 },
    { id: 'points', type: 'circle', source: 'points' },
    { id: 'road-symbol', type: 'symbol', source: 'roads', layout: { 'icon-image': 'star' } },
  ],
};

function fakeMap(failLayer = '') {
  const sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn>; updateData: ReturnType<typeof vi.fn> }>([['stations', { setData: vi.fn(), updateData: vi.fn().mockResolvedValue(undefined) }]]);
  const layers = new Set<string>();
  const images = new Set<string>();
  const map = {
    addSource: vi.fn((id: string) => { sources.set(id, { setData: vi.fn(), updateData: vi.fn().mockResolvedValue(undefined) }); }),
    getSource: vi.fn((id: string) => sources.get(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    addLayer: vi.fn((layer: { id: string }) => { if (layer.id.includes(failLayer) && failLayer) throw new Error('Bad layer'); layers.add(layer.id); }),
    getLayer: vi.fn((id: string) => layers.has(id)), removeLayer: vi.fn((id: string) => layers.delete(id)),
    setFilter: vi.fn(), setLayoutProperty: vi.fn(), moveLayer: vi.fn(),
    addImage: vi.fn((id: string) => images.add(id)), hasImage: vi.fn((id: string) => images.has(id)),
    removeImage: vi.fn((id: string) => images.delete(id)),
  };
  return { map, sources, asMap: map as unknown as Map };
}

it('fetches uncached styles using the API base path, validates JSON, and supports styles without embedded icons', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(style));
  vi.stubGlobal('fetch', fetchMock);
  const { signal } = new AbortController();
  expect((await fetchStylesheet('https://example.org/proxy', signal)).style).toEqual(style);
  expect(fetchMock.mock.calls[0][0].href).toBe('https://example.org/proxy/fgb/style');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal, cache: 'no-store', credentials: 'omit' });
});

it.each([new Response('', { status: 404 }), new Response('invalid'), Response.json({ version: 7 })])(
  'rejects missing or invalid styles', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchStylesheet('https://example.org', new AbortController().signal)).rejects.toThrow();
  },
);

it('preserves cross-source ordering, filters and layout, diffs source data, and cleans up owned resources', async () => {
  const { map, asMap, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['points', 'roads', 'unmatched'], {
    style, icons: { images: new globalThis.Map([['star', {} as HTMLImageElement]]), errors: [] },
  });
  expect([...renderer.styled]).toEqual(['points', 'roads']);
  expect(renderer.warnings.join(' ')).toContain('unmatched');
  expect(map.addLayer.mock.calls.map(([layer]) => layer.id)).toEqual([
    'flatserve-style-layer:road-line', 'flatserve-style-layer:points', 'flatserve-style-layer:road-symbol',
    'flatserve-fallback-layer:unmatched:fill', 'flatserve-fallback-layer:unmatched:line', 'flatserve-fallback-layer:unmatched:circle',
  ]);
  expect(map.addLayer.mock.calls[0]).toEqual([expect.objectContaining({
    filter: ['==', ['get', 'kind'], 'road'], minzoom: 2, source: 'flatserve-style-source:roads',
  }), 'authorized-area-fill']);
  expect(map.addLayer.mock.calls[2][0]).toMatchObject({ layout: { 'icon-image': 'flatserve-style-icon:star' } });
  const road = { ...station('road'), fgbLayerId: 'roads' };
  const fallback = { ...station('fallback'), fgbLayerId: 'unmatched' };
  const batch = prepareBatch([road, fallback], 1);
  await renderer.apply(batch);
  renderer.update(batch);
  expect(sources.get('flatserve-style-source:roads')!.updateData).toHaveBeenLastCalledWith({ removeAll: true, add: batch.groups.get('roads') });
  expect(sources.get('flatserve-fallback-source:unmatched')!.updateData).toHaveBeenLastCalledWith({ removeAll: true, add: batch.groups.get('unmatched') });
  await renderer.apply(prepareBatch([], 2));
  renderer.update(prepareBatch([], 2));
  expect(sources.get('flatserve-style-source:roads')!.updateData).toHaveBeenLastCalledWith({ removeAll: true, add: [] });
  expect(map.addSource).toHaveBeenCalledTimes(3);
  renderer.cleanup();
  expect([...sources.keys()]).toEqual(['stations']);
  expect(map.removeImage).toHaveBeenCalledWith('flatserve-style-icon:star');
});

it('removes failed icon references and falls back only for datasets whose style layers fail', () => {
  const { asMap, map } = fakeMap('road-line');
  const renderer = renderStyledLayers(asMap, ['roads', 'points'], {
    style, icons: { images: new globalThis.Map([['star', null]]), errors: ['Invalid SVG'] },
  });
  expect([...renderer.styled]).toEqual(['points']);
  expect(renderer.warnings.join(' ')).toContain('Invalid SVG');
  expect(map.removeSource).toHaveBeenCalledWith('flatserve-style-source:roads');
  const good = fakeMap();
  renderStyledLayers(good.asMap, ['roads'], { style, icons: { images: new globalThis.Map([['star', null]]), errors: [] } });
  expect(good.map.addLayer.mock.calls.at(-1)![0]).toMatchObject({ layout: {} });
});

it('changes BBox filters only when IDs change, restores stylesheet filters, and never resends unchanged geometry', async () => {
  const { map, asMap, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['roads', 'fallback'], { style,
    icons: { images: new globalThis.Map(), errors: [] } });
  const features = [{ ...station('a'), fgbLayerId: 'roads' }, { ...station('b'), fgbLayerId: 'fallback' }];
  const batch = prepareBatch(features, 1);
  await renderer.apply(batch);
  renderer.update(batch, { roads: [0] });
  expect(map.setFilter).toHaveBeenCalledWith('flatserve-style-layer:road-line', [
    'all', ['==', ['get', 'kind'], 'road'], ['in', ['id'], ['literal', [0]]],
  ]);
  expect(map.setFilter).toHaveBeenCalledWith('flatserve-fallback-layer:fallback:circle', [
    'all', ['==', ['geometry-type'], 'Point'], ['in', ['id'], ['literal', []]],
  ]);
  map.setFilter.mockClear();
  renderer.update(batch, { roads: [0] });
  expect(map.setFilter).not.toHaveBeenCalled();
  renderer.update(batch, { roads: [0], fallback: [1] });
  expect(map.setFilter).toHaveBeenCalledTimes(3);
  map.setFilter.mockClear();
  renderer.update(batch);
  expect(map.setFilter).toHaveBeenCalledWith('flatserve-style-layer:road-line', ['==', ['get', 'kind'], 'road']);
  expect(map.setFilter).toHaveBeenCalledWith('flatserve-style-layer:road-symbol', null);
  for (const [id, source] of sources) if (id !== 'stations') expect(source.setData).not.toHaveBeenCalled();
});

it('uses layout visibility for toggles and respects originally hidden stylesheet layers', async () => {
  const { map, asMap, sources } = fakeMap();
  const hiddenStyle: StyleSpecification = { ...style, layers: [
    { id: 'hidden', source: 'roads', type: 'line', layout: { visibility: 'none' } },
    { id: 'visible', source: 'roads', type: 'line' },
  ] };
  const renderer = renderStyledLayers(asMap, ['roads', 'fallback'], { style: hiddenStyle,
    icons: { images: new globalThis.Map(), errors: [] } });
  const batch = prepareBatch([], 1);
  await renderer.apply(batch);
  renderer.update(batch);
  renderer.update(batch, null, new Set(['roads', 'fallback']));
  expect(map.setLayoutProperty).toHaveBeenCalledWith('flatserve-style-layer:visible', 'visibility', 'none');
  expect(map.setLayoutProperty).toHaveBeenCalledWith('flatserve-fallback-layer:fallback:circle', 'visibility', 'none');
  map.setLayoutProperty.mockClear();
  renderer.update(batch);
  expect(map.setLayoutProperty).toHaveBeenCalledWith('flatserve-style-layer:visible', 'visibility', 'visible');
  expect(map.setLayoutProperty).toHaveBeenCalledWith('flatserve-style-layer:hidden', 'visibility', 'none');
  for (const [id, source] of sources) if (id !== 'stations') expect(source.setData).not.toHaveBeenCalled();
});

it('normalizes source ID generation and promotion so numeric runtime IDs survive stylesheet settings', () => {
  const { map, asMap } = fakeMap();
  renderStyledLayers(asMap, ['roads'], { style: { ...style, sources: {
    roads: { type: 'geojson', data: '', generateId: true, promoteId: 'externalId' },
  } }, icons: { images: new globalThis.Map(), errors: [] } });
  expect(map.addSource).toHaveBeenCalledWith('flatserve-style-source:roads', expect.objectContaining({ generateId: false, promoteId: undefined }));
});

it('combines legacy filters with runtime IDs and commits membership after the source update completes', async () => {
  const { asMap, map, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['roads'], { style: { ...style, layers: [
    { id: 'legacy', source: 'roads', type: 'line', filter: ['==', 'kind', 'road'] },
  ] }, icons: { images: new globalThis.Map(), errors: [] } });
  const features = [{ ...station('old'), fgbLayerId: 'roads' }];
  await renderer.apply(prepareBatch(features, 1));
  renderer.update(prepareBatch(features, 1), { roads: [0] });
  const next = prepareBatch(features, 2, 1);
  await renderer.apply(next);
  renderer.update(next, { roads: [1] });
  expect(map.setFilter).toHaveBeenLastCalledWith('flatserve-style-layer:legacy', [
    'all', ['==', ['get', 'kind'], 'road'], ['in', ['id'], ['literal', [1]]],
  ]);
  const upload = sources.get('flatserve-style-source:roads')!.updateData;
  expect(map.setFilter.mock.invocationCallOrder.at(-1)).toBeGreaterThan(upload.mock.invocationCallOrder.at(-1)!);
  expect(next.groups.get('roads')![0].id).not.toBe(0);
});


it('sends only worker diffs, skips identical responses and never replaces dataset data', async () => {
  const { asMap, sources, map } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['dataset']);
  const differ = new SnapshotDiffer();
  const first = differ.prepare([station('a'), station('b')], 1, emptySnapshot());
  await renderer.apply(materialize(first.delta, emptySnapshot().batch));
  const source = sources.get('flatserve-fallback-source:dataset')!;
  expect(source.updateData).toHaveBeenCalledWith(first.delta.diffs.get('dataset'));
  const same = differ.prepare([station('b'), station('a')], 2, first.snapshot);
  await renderer.apply(materialize(same.delta, first.snapshot.batch));
  expect(source.updateData).toHaveBeenCalledOnce();
  const next = differ.prepare([station('b'), station('c')], 3, same.snapshot);
  await renderer.apply(materialize(next.delta, same.snapshot.batch));
  expect(source.updateData).toHaveBeenLastCalledWith(next.delta.diffs.get('dataset'));
  expect(source.updateData.mock.lastCall![0]).toMatchObject({ remove: [0], add: [{ properties: { brannvesen: 'c' } }] });
  expect(source.setData).not.toHaveBeenCalled();
  expect(map.addSource).toHaveBeenCalledOnce();
});

it('serializes slow uploads and restores acknowledged data after a rejecting worker update', async () => {
  const { asMap, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['dataset']);
  const source = sources.get('flatserve-fallback-source:dataset')!;
  let resolve!: () => void;
  source.updateData.mockReturnValueOnce(new Promise<void>((yes) => { resolve = yes; }));
  const first = renderer.apply(prepareBatch([station('a')], 1));
  const next = renderer.apply(prepareBatch([station('b')], 2));
  await Promise.resolve();
  expect(source.updateData).toHaveBeenCalledOnce();
  resolve(); await Promise.all([first, next]);
  expect(source.updateData).toHaveBeenCalledTimes(2);
  source.updateData.mockRejectedValueOnce(new Error('worker rejected'));
  await expect(renderer.apply(prepareBatch([station('bad')], 3))).rejects.toThrow('worker rejected');
  expect(source.updateData.mock.lastCall![0]).toMatchObject({ removeAll: true, add: [{ properties: { brannvesen: 'b' } }] });
  expect(source.setData).not.toHaveBeenCalled();
});


it('creates sources on demand before discovery and retains them when dataset metadata arrives', async () => {
  const { asMap, map, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, []);
  const batch = prepareBatch([station('a')], 1);
  renderer.update(prepareBatch([], 0), {}, new Set(['dataset']));
  await renderer.apply(batch);
  renderer.ensureDatasets(['dataset']);
  expect(map.addSource).toHaveBeenCalledOnce();
  expect(map.addLayer).toHaveBeenCalledTimes(3);
  expect(map.setLayoutProperty).toHaveBeenCalledWith('flatserve-fallback-layer:dataset:circle', 'visibility', 'none');
  expect(sources.get('flatserve-fallback-source:dataset')!.setData).not.toHaveBeenCalled();
});

it('isolates acknowledged records from MapLibre mutations so failed diffs can restore their original properties', async () => {
  const { asMap, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['dataset']);
  const batch = prepareBatch([station('original')], 1);
  await renderer.apply(batch);
  const source = sources.get('flatserve-fallback-source:dataset')!;
  const installed = source.updateData.mock.calls[0][0].add[0];
  installed.properties.brannvesen = 'mutated by source';
  installed.geometry = null;
  expect(batch.groups.get('dataset')![0]).toMatchObject({ properties: { brannvesen: 'original' }, geometry: { type: 'Point' } });
  source.updateData.mockRejectedValueOnce(new Error('rejected'));
  await expect(renderer.apply(prepareBatch([station('bad')], 2))).rejects.toThrow('rejected');
  expect(source.updateData.mock.lastCall![0].add[0]).toMatchObject({ properties: { brannvesen: 'original' }, geometry: { type: 'Point' } });
});
