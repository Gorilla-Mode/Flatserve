import { afterEach, expect, it, vi } from 'vitest';
import type { Map, StyleSpecification } from 'maplibre-gl';
import { fetchStylesheet, renderStyledLayers } from './stylesheet';
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
  const sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn> }>([['stations', { setData: vi.fn() }]]);
  const layers = new Set<string>();
  const images = new Set<string>();
  const map = {
    addSource: vi.fn((id: string) => { sources.set(id, { setData: vi.fn() }); }),
    getSource: vi.fn((id: string) => sources.get(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    addLayer: vi.fn((layer: { id: string }) => { if (layer.id.includes(failLayer) && failLayer) throw new Error('Bad layer'); layers.add(layer.id); }),
    getLayer: vi.fn((id: string) => layers.has(id)), removeLayer: vi.fn((id: string) => layers.delete(id)),
    addImage: vi.fn((id: string) => images.add(id)), hasImage: vi.fn((id: string) => images.has(id)),
    removeImage: vi.fn((id: string) => images.delete(id)),
  };
  return { map, sources, asMap: map as unknown as Map };
}

it('fetches using the API base path, validates JSON, and supports styles without embedded icons', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(style));
  vi.stubGlobal('fetch', fetchMock);
  expect((await fetchStylesheet('https://example.org/proxy', new AbortController().signal)).style).toEqual(style);
  expect(fetchMock.mock.calls[0][0].href).toBe('https://example.org/proxy/fgb/style');
});

it.each([new Response('', { status: 404 }), new Response('invalid'), Response.json({ version: 7 })])(
  'rejects missing or invalid styles', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchStylesheet('https://example.org', new AbortController().signal)).rejects.toThrow();
  },
);

it('preserves cross-source ordering, filters and layout, replaces source data, and cleans up owned resources', () => {
  const { map, asMap, sources } = fakeMap();
  const renderer = renderStyledLayers(asMap, ['points', 'roads', 'unmatched'], {
    style, icons: { images: new globalThis.Map([['star', {} as HTMLImageElement]]), errors: [] },
  });
  expect([...renderer.styled]).toEqual(['points', 'roads']);
  expect(renderer.warnings.join(' ')).toContain('unmatched');
  expect(map.addLayer.mock.calls.map(([layer]) => layer.id)).toEqual([
    'flatserve-style-layer:road-line', 'flatserve-style-layer:points', 'flatserve-style-layer:road-symbol',
  ]);
  expect(map.addLayer.mock.calls[0]).toEqual([expect.objectContaining({
    filter: ['==', ['get', 'kind'], 'road'], minzoom: 2, source: 'flatserve-style-source:roads',
  }), 'authorized-area-fill']);
  expect(map.addLayer.mock.calls[2][0]).toMatchObject({ layout: { 'icon-image': 'flatserve-style-icon:star' } });
  const road = { ...station('road'), fgbLayerId: 'roads' };
  const fallback = { ...station('fallback'), fgbLayerId: 'unmatched' };
  renderer.update([road, fallback]);
  expect(sources.get('flatserve-style-source:roads')!.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [road] });
  expect(sources.get('stations')!.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [fallback] });
  renderer.update([]);
  expect(sources.get('flatserve-style-source:roads')!.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
  expect(map.addSource).toHaveBeenCalledTimes(2);
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
