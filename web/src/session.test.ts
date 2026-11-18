import { describe, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';
import type { DecodeOptions, HeaderMeta, RequestTiming } from './api';
import { DatasetSession } from '../tests/sessionHarness';
import { expandBounds, viewportBounds, WORLD } from './bounds';
import { station } from '../tests/fixtures';
import { timingHistory } from './timings';
import type { TimingRecord } from './timings';

const observers = () => ({
  onFeatures: vi.fn(), onStatus: vi.fn(), onHeader: vi.fn(), onValues: vi.fn(), onDiscovery: vi.fn(),
  onCoverage: vi.fn(), onPrefetchCoverage: vi.fn(),
});

// Existing spatial/filter cases start with an explicitly selected demo user.
function norwaySession(...args: ConstructorParameters<typeof DatasetSession>) {
  const session = new DatasetSession(...args);
  void session.setUser(2);
  vi.mocked(args[1].onCoverage)?.mockClear();
  vi.mocked(args[1].onPrefetchCoverage)?.mockClear();
  vi.mocked(args[1].onStatus).mockClear();
  return session;
}

const area = (west = 0, east = 10) => viewportBounds(west, 50, east, 60);

it('discovers all layer metadata and fits their combined extent, preserving layer IDs in view data', async () => {
  const observer = { ...observers(), onLayers: vi.fn() };
  const headers = [
    { envelope: new Float64Array([4, 50, 8, 60]) },
    { envelope: new Float64Array([7, 52, 12, 65]) },
  ] as HeaderMeta[];
  const features = [
    { ...station('First', 8), fgbLayerId: 'first' },
    { ...station('Second', 8), fgbLayerId: 'second' },
  ];
  const read = vi.fn(async (_url: URL, options: DecodeOptions) => {
    headers.forEach((header, index) => {
      options.onHeader?.(header);
      options.onLayer?.({ id: index === 0 ? 'first' : 'second', header });
    });
    return features;
  });
  const session = new DatasetSession('https://example.org', observer, read);
  await session.discover();
  expect(observer.onLayers.mock.lastCall?.[0].map((layer: { id: string }) => layer.id)).toEqual(['first', 'second']);
  expect(observer.onHeader).toHaveBeenCalledOnce();
  expect(Array.from(observer.onHeader.mock.lastCall![0].envelope)).toEqual([4, 50, 12, 65]);
  await session.setBounds(area());
  await session.setUser(2);
  expect(observer.onFeatures.mock.lastCall?.[0]).toEqual(features);
  session.dispose();
});

describe('buffered dataset publishing', () => {
  it('publishes complete buffered batches and never republishes geometry during covered movement', async () => {
    const features: Feature[] = [
      station('point', 1),
      { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[1, 55], [20, 55]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-1, 55], [11, 55]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[3, 54], [7, 56]], [[20, 54], [25, 56]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[4, 52], [8, 52], [8, 56], [4, 56], [4, 52]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[[4, 52], [8, 52], [8, 56], [4, 52]]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [
        { type: 'Point', coordinates: [9, 55] }, { type: 'LineString', coordinates: [[8, 52], [9, 53]] },
      ] } },
    ];
    const invisible: Feature[] = [station('outside', 30),
      { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [] } }];
    const observer = observers();
    const read = vi.fn().mockResolvedValue([...features, ...invisible]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(area());
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([...features, ...invisible]);
    await session.setBounds(area(1.4, 11.4));
    expect(read).toHaveBeenCalledTimes(1);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([...features, ...invisible]);
    expect(observer.onFeatures).toHaveBeenCalledTimes(1);
    await session.setBounds(area());
    expect(read).toHaveBeenCalledTimes(1);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([...features, ...invisible]);
    await session.setFilter('all');
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([...features, ...invisible]);
    await session.setBounds(area(50, 60));
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([...features, ...invisible]);
  });
});

describe('session timings', () => {
  const timing = (url: URL): RequestTiming => ({ url: url.href, httpMs: 10, downloadDecodeMs: 20, totalMs: 30 });

  it('records concurrent discovery, multipart calls and repeated filters, excluding spatial reuse', async () => {
    let records: TimingRecord[] = [];
    const observer = { ...observers(), onTiming: (value: ReturnType<typeof timing>) => { records = timingHistory(records, value); } };
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const discovery = session.discover();
    const bounds = viewportBounds(170, 50, 190, 60);
    const view = session.setBounds(bounds);
    const complete = (index: number) => {
      calls[index].options.onTiming?.(timing(calls[index].url));
      calls[index].resolve([]);
    };
    complete(1);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    complete(0);
    complete(2);
    await Promise.all([discovery, view]);
    expect(records.map((record) => record.url)).toEqual([calls[1].url.href, calls[0].url.href, calls[2].url.href]);
    await session.setBounds(bounds);
    expect(calls).toHaveLength(3);
    const filter = session.setFilter('Oslo');
    complete(3);
    await filter;
    const repeated = session.setFilter('Oslo');
    complete(4);
    await repeated;
    expect(calls).toHaveLength(5);
    expect(records).toHaveLength(5);
    expect(records[4].url).toBe(records[3].url);
  });

  it('rejects late callbacks from cancelled and disposed requests, including discovery', async () => {
    const onTiming = vi.fn();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', { ...observers(), onTiming }, read);
    const promises = [session.discover(), session.discover(), session.setBounds(area()), session.setFilter('Oslo')];
    for (const index of [0, 2]) {
      calls[index].options.onTiming?.(timing(calls[index].url));
      calls[index].resolve([]);
    }
    expect(onTiming).not.toHaveBeenCalled();
    session.dispose();
    for (const index of [1, 3]) {
      calls[index].options.onTiming?.(timing(calls[index].url));
      calls[index].resolve([]);
    }
    await Promise.all(promises);
    await session.discover();
    expect(calls).toHaveLength(4);
    expect(onTiming).not.toHaveBeenCalled();
  });
});

describe('coverage notifications', () => {
  it('fetches on prefetch contact and catches up inside fetched coverage, anchoring both boundaries to each original request', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const initial = session.setBounds(area());
    calls[0].resolve([]);
    await initial;
    await session.setBounds(area(1.9, 11.9));
    expect(calls).toHaveLength(1);
    const next = session.setBounds(area(2, 12));
    expect(calls).toHaveLength(2);
    session.setBounds(area(3, 13));
    session.setBounds(area(5, 15));
    expect(calls).toHaveLength(2);
    expect(calls[1].options.signal.aborted).toBe(false);
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area())]]);
    expect(observer.onPrefetchCoverage.mock.calls).toEqual([[expandBounds(area(), 0.2)]]);
    calls[1].resolve([]);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(observer.onCoverage.mock.lastCall).toEqual([viewportBounds(0, 47, 16, 63)]);
    expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([viewportBounds(1, 48, 15, 62)]);
    expect(calls[2].url.searchParams.get('minX')).toBe('3');
    session.setBounds(area(5.5, 15.5));
    calls[2].resolve([]);
    await next;
    expect(calls).toHaveLength(3);
    expect(observer.onCoverage.mock.lastCall).toEqual([viewportBounds(3, 47, 19, 63)]);
    expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([viewportBounds(4, 48, 18, 62)]);
    session.dispose();
  });

  it('keeps the successful query anchor through covered movement and a failed request', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(viewportBounds(0, 0, 10, 10));
    await session.setBounds(viewportBounds(1, 0, 11, 10)); // Reuse must not move the anchor.
    await session.setBounds(viewportBounds(20, 0, 30, 10)); // Failure must not move it either.
    await session.setBounds(viewportBounds(0, 20, 10, 30));
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onCoverage.mock.lastCall).toEqual([viewportBounds(-3, 18, 13, 34)]);
    expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([viewportBounds(-2, 19, 12, 33)]);
    session.dispose();
  });

  it('reverses from the successful original query rather than the shifted buffer center', async () => {
    const observer = observers();
    const session = norwaySession('https://example.org', observer, vi.fn().mockResolvedValue([]));
    await session.setBounds(area());
    await session.setBounds(area(2, 12));
    await session.setBounds(area(1, 11)); // Touch the trailing 10% prefetch margin.
    expect(observer.onCoverage.mock.lastCall).toEqual([viewportBounds(-3, 47, 13, 63)]);
    expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([viewportBounds(-2, 48, 12, 62)]);
    session.dispose();
  });

  it('centers a stationary zoom request after directional movement', async () => {
    const observer = observers();
    const session = norwaySession('https://example.org', observer, vi.fn().mockResolvedValue([]));
    await session.setBounds(area());
    await session.setBounds(area(2, 12));
    await session.setBounds(area(-3, 17));
    expect(observer.onCoverage.mock.lastCall).toEqual([viewportBounds(-9, 47, 23, 63)]);
    expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([viewportBounds(-7, 48, 21, 62)]);
    session.dispose();
  });

  it.each(['refresh', 'user', 'configuration', 'buffer', 'filter', 'reconnect'])(
    'clears a directional anchor on %s', async (reset) => {
      const observer = observers();
      const read = vi.fn().mockResolvedValue([]);
      let session = norwaySession('https://example.org', observer, read);
      await session.setBounds(area());
      await session.setBounds(area(2, 12));
      if (reset === 'refresh') await session.refresh();
      if (reset === 'user') await session.setUser(1);
      if (reset === 'configuration') await session.setFilter('', area(20, 30));
      if (reset === 'buffer') {
        await session.setFilter('', area(20, 30), false);
        await session.setFilter('', area(20, 30), true);
      }
      if (reset === 'filter') {
        await session.setFilter('Oslo');
        await session.setFilter('', area(20, 30));
      }
      if (reset === 'reconnect') {
        session.dispose();
        session = norwaySession('https://example.org', observer, read);
        await session.setBounds(area(20, 30));
      }
      const query = reset === 'refresh' || reset === 'user' ? area(2, 12) : area(20, 30);
      expect(observer.onCoverage.mock.lastCall).toEqual([expandBounds(query)]);
      expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([expandBounds(query, .2)]);
      session.dispose();
    },
  );

  it.each([
    [WORLD], viewportBounds(-150, -90, 150, 90), viewportBounds(0, 80, 10, 90),
    viewportBounds(0, -90, 10, -80), viewportBounds(180, 55, 180, 55),
    viewportBounds(180, 50, 180, 60), viewportBounds(0, 55, 10, 55),
    viewportBounds(0, 50, 1e-8, 50 + 1e-8),
  ])('does not loop on stationary world, clamped, degenerate or tiny bounds %j', async (...bounds) => {
    const observer = observers();
    const read = vi.fn(async () => {
      if (read.mock.calls.length > 4) throw new Error('Repeated stationary request');
      return [];
    });
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(bounds);
    await session.setBounds(bounds);
    expect(read).toHaveBeenCalledTimes(expandBounds(bounds).length);
    expect(observer.onCoverage).toHaveBeenCalledOnce();
    expect(observer.onPrefetchCoverage).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('reports empty spatial success, reuses it silently, and keeps it during movement and failures', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const initial = session.setBounds(area());
    expect(observer.onCoverage).not.toHaveBeenCalled();
    calls[0].resolve([]);
    await initial;
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area())]]);
    await session.setBounds(area(1, 11));
    expect(calls).toHaveLength(1);
    const next = session.setBounds(area(3, 13));
    expect(observer.onCoverage).toHaveBeenCalledTimes(1);
    calls[1].reject(new Error('Offline'));
    await next;
    expect(observer.onCoverage).toHaveBeenCalledTimes(1);
    const replacement = session.setBounds(area(4, 14));
    calls[2].resolve([]);
    await replacement;
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area())], [viewportBounds(2, 47, 18, 63)]]);
    expect(observer.onPrefetchCoverage.mock.calls).toEqual([
      [expandBounds(area(), 0.2)], [viewportBounds(3, 48, 17, 62)],
    ]);
  });

  it('clears coverage on refresh, query configuration changes, filters, and disposal', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(area());
    observer.onCoverage.mockClear();
    observer.onPrefetchCoverage.mockClear();
    await session.refresh();
    await session.setFilter('', area(4, 6));
    await session.setFilter('', area(4, 6), false);
    await session.setFilter('Oslo');
    await session.setFilter('Oslo'); // Repeated filters still have no spatial coverage.
    await session.setFilter('');
    session.dispose();
    expect(observer.onCoverage.mock.calls).toEqual([
      [undefined], [expandBounds(area())],
      [undefined], [expandBounds(area(4, 6))],
      [undefined], [area(4, 6)],
      [undefined], [undefined],
      [undefined], [area(4, 6)], [undefined],
    ]);
    expect(observer.onPrefetchCoverage.mock.calls).toEqual([
      [undefined], [expandBounds(area(), 0.2)],
      [undefined], [expandBounds(area(4, 6), 0.2)],
      [undefined], [undefined], [undefined], [undefined],
      [undefined], [undefined], [undefined],
    ]);
  });

  it('publishes multipart coverage only on complete success, retaining previous coverage on partial failure', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const initial = session.setBounds(area());
    calls[0].resolve([]);
    await initial;
    const crossing = viewportBounds(170, 50, 190, 60);
    const failed = session.setBounds(crossing);
    calls[1].resolve([]);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area())]]);
    calls[2].reject(new Error('Second half failed'));
    await failed;
    expect(observer.onCoverage).toHaveBeenCalledTimes(1);
    expect(observer.onPrefetchCoverage.mock.calls).toEqual([[expandBounds(area(), 0.2)]]);
    const retry = session.refresh();
    expect(observer.onCoverage.mock.lastCall).toEqual([undefined]);
    calls[3].resolve([]);
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(observer.onCoverage).toHaveBeenCalledTimes(2);
    calls[4].resolve([]);
    await retry;
    expect(observer.onCoverage.mock.lastCall).toEqual([expandBounds(crossing)]);
    expect(observer.onPrefetchCoverage.mock.calls).toEqual([
      [expandBounds(area(), 0.2)], [undefined], [expandBounds(crossing, 0.2)],
    ]);
  });

  it('ignores aborted and stale responses, including after disposal', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const stale = session.setBounds(area());
    const latest = session.setFilter('', area(20, 30));
    observer.onCoverage.mockClear();
    observer.onPrefetchCoverage.mockClear();
    calls[0].resolve([]);
    await stale;
    expect(observer.onCoverage).not.toHaveBeenCalled();
    expect(observer.onPrefetchCoverage).not.toHaveBeenCalled();
    expect(calls[0].options.signal.aborted).toBe(true);
    calls[1].resolve([]);
    await latest;
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area(20, 30))]]);
    expect(observer.onPrefetchCoverage.mock.calls).toEqual([[expandBounds(area(20, 30), 0.2)]]);
    const disposed = session.setBounds(area(40, 50));
    session.dispose();
    observer.onCoverage.mockClear();
    observer.onPrefetchCoverage.mockClear();
    calls[2].resolve([]);
    await disposed;
    expect(observer.onCoverage).not.toHaveBeenCalled();
    expect(observer.onPrefetchCoverage).not.toHaveBeenCalled();
  });
});

describe('buffered live updates', () => {
  it('requests exact bounds with Buffer off and reuses containing coverage without republishing geometry', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('inside', 8), station('edge', 10)]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setFilter('', area(), false);
    expect(Object.fromEntries(read.mock.calls[0][0].searchParams)).toEqual({
      userId: '2', minX: '0', minY: '50', maxX: '10', maxY: '60',
    });
    await session.setBounds(area(7, 9));
    expect(read).toHaveBeenCalledTimes(1);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('inside', 8), station('edge', 10)]);
    await session.setBounds(area(7, 11));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.lastCall?.[0].searchParams.get('maxX')).toBe('11');
  });

  it('preserves Buffer through repeated filters and bbox changes and Retry', async () => {
    const read = vi.fn().mockResolvedValue([station('Oslo', 8)]);
    const session = norwaySession('https://example.org', observers(), read);
    await session.setFilter('', area(), false);
    await session.setFilter('Oslo');
    await session.setFilter('', area(7, 9));
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('7');
    await session.refresh();
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('7');
    const before = read.mock.calls.length;
    await session.setFilter('Oslo');
    expect(read).toHaveBeenCalledTimes(before + 1);
    await session.setFilter('', area());
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('0');
    await session.setFilter('', area(), true);
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('-3');
  });

  it.each([false, true])('cancels pending work when Buffer becomes %s and rejects stale success and errors', async (enabled) => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const initial = session.setFilter('', area(), !enabled);
    calls[0].resolve([station('saved', 8)]);
    await initial;
    const staleSuccess = session.refresh();
    const staleFailure = session.setFilter('', area(), enabled);
    const latest = session.setFilter('', area(), !enabled);
    expect(calls[1].options.signal.aborted).toBe(true);
    expect(calls[2].options.signal.aborted).toBe(true);
    expect(observer.onFeatures).toHaveBeenCalledTimes(1);
    observer.onCoverage.mockClear();
    calls[1].resolve([station('stale', 9)]);
    calls[2].reject(new Error('Stale failure'));
    await Promise.all([staleSuccess, staleFailure]);
    expect(observer.onCoverage).not.toHaveBeenCalled();
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('saved', 8)]);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: true, error: null });
    calls[3].resolve([station('current', 9)]);
    await latest;
    expect(observer.onCoverage.mock.calls).toEqual([[!enabled ? expandBounds(area()) : area()]]);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('current', 9)]);
  });

  it('invalidates successful coverage and failed targets even if toggling leaves request bounds identical', async () => {
    const read = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([]);
    const observer = observers();
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds([WORLD]);
    await session.setFilter('', [WORLD], false);
    expect(read).toHaveBeenCalledTimes(2);
    await session.setBounds([WORLD]);
    expect(read).toHaveBeenCalledTimes(2);
    await session.setFilter('', [WORLD], true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });

  it('publishes each completed batch once and does no feature serialization during movement', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('inside', 8), station('buffer', 12), station('outside', 20)]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(area());
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(Object.fromEntries(read.mock.calls[0][0].searchParams)).toEqual({
      userId: '2', minX: '-3', minY: '47', maxX: '13', maxY: '63',
    });
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('inside', 8), station('buffer', 12), station('outside', 20)]);
    await session.setBounds(area(1, 11));
    expect(observer.onFeatures).toHaveBeenCalledTimes(1);
    await session.setBounds(area(1.4, 11.4));
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('inside', 8), station('buffer', 12), station('outside', 20)]);
    await session.setBounds(area(1.4, 11.4));
    expect(observer.onFeatures).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    await session.setBounds(area(3, 13));
    expect(read).toHaveBeenCalledTimes(2);
    // A completed request is a new data version, without comparing full feature content.
    expect(observer.onFeatures).toHaveBeenCalledTimes(2);
  });

  it('keeps one logical request, catches up to the latest bounds, and publishes complete batches for worker processing', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const first = session.setBounds(area());
    const moving = session.setBounds(area(10, 20));
    session.setBounds(area(20, 30));
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal.aborted).toBe(false);
    calls[0].options.onBatch?.([station('partial', 8)]);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    calls[0].resolve([station('old', 8)]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].url.searchParams.get('minX')).toBe('18');
    expect(observer.onFeatures).toHaveBeenCalledExactlyOnceWith([station('old', 8)]);
    // A newer camera position strictly inside the pending prefetch boundary needs no third request.
    session.setBounds(area(21, 31));
    calls[1].resolve([station('hidden', 21), station('visible', 28)]);
    await Promise.all([first, moving]);
    expect(calls).toHaveLength(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('hidden', 21), station('visible', 28)]);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });

  it('keeps the last successful dataset while loading and replaces it only on full success', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const initial = session.setBounds(area());
    calls[0].resolve([station('old', 8)]);
    await initial;
    const next = session.setBounds(area(3, 13));
    expect(observer.onFeatures).toHaveBeenCalledTimes(1);
    calls[1].options.onBatch?.([station('partial', 9)]);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('old', 8)]);
    calls[1].resolve([station('new', 9)]);
    await next;
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('new', 9)]);
    // Only the latest successful buffer is retained.
    const back = session.setBounds(area(-2, 8));
    expect(calls).toHaveLength(3);
    calls[2].resolve([]);
    await back;
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([]);
  });

  it('treats empty success as coverage', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(area());
    await session.setBounds(area(1, 11));
    await session.setBounds(area());
    expect(read).toHaveBeenCalledTimes(1);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });

  it('preserves successful data after failure, suppresses unchanged failed targets, and supports Retry', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValueOnce([station('old', 8)])
      .mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([station('new', 9)]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(area());
    await session.setBounds(area(3, 13));
    await session.setBounds(area(3, 13));
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: 'Offline' });
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('old', 8)]);
    await session.refresh();
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('new', 9)]);
  });

  it('immediately tries the latest desired target after an older target fails', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const pending = session.setBounds(area());
    session.setBounds(area(20, 30));
    calls[0].reject(new Error('Offline'));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve([station('new', 25)]);
    await pending;
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('new', 25)]);
  });

  it('establishes antimeridian coverage only after every part succeeds', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const bounds = viewportBounds(170, 50, 190, 60);
    const pending = session.setBounds(bounds);
    calls[0].resolve([station('east', 175)]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(observer.onFeatures).not.toHaveBeenCalled();
    calls[1].reject(new Error('Second half failed'));
    await pending;
    await session.setBounds(bounds);
    expect(calls).toHaveLength(2);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    const retry = session.refresh();
    calls[2].resolve([station('east', 175)]);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3].resolve([station('west', -175)]);
    await retry;
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('east', 175), station('west', -175)]);
    await session.setBounds(bounds);
    expect(calls).toHaveLength(4);
  });

  it('invalidates coverage on bbox mode changes and returning from a filter', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('Oslo', 8)]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds(area());
    await session.setFilter('', area(4, 6));
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('Oslo', 8)]);
    await session.setFilter('Oslo');
    await session.setBounds(area(7, 9));
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('Oslo', 8)]);
    await session.setFilter('');
    expect(read).toHaveBeenCalledTimes(4);
    expect(Number(read.mock.lastCall?.[0].searchParams.get('minX'))).toBeCloseTo(6.4);
  });
});
function pendingReader() {
  const calls: { url: URL; options: DecodeOptions; resolve: (features: Feature[]) => void; reject: (error: Error) => void }[] = [];
  const read = vi.fn((url: URL, options: DecodeOptions) => new Promise<Feature[]>((resolve, reject) => {
    calls.push({ url, options, resolve, reject });
  }));
  return { calls, read };
}

describe('user selection', () => {
  it('allows only discovery before selection, even after setting a filter or retrying', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('Norway catalog')]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds(area());
    await session.setFilter('Oslo');
    await session.refresh();
    expect(read).not.toHaveBeenCalled();
    await session.discover();
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.lastCall?.[0].searchParams.get('userId')).toBe('2');
    expect(observer.onValues).toHaveBeenCalledExactlyOnceWith(['Norway catalog']);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    await session.setUser(0);
    expect(read.mock.lastCall?.[0].pathname).toBe('/fgb/filter');
  });

  it.each([0, 1])('uses Norway for discovery and retries with user %s already selected', async (userId) => {
    const observer = observers();
    const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([station('A'), station('B')]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setUser(userId);
    await session.discover();
    expect(observer.onDiscovery.mock.lastCall?.[0].error).toBe('Offline');
    await session.discover();
    expect(read.mock.calls.map(([url]) => Object.fromEntries(url.searchParams))).toEqual([
      { userId: '2', ...Object.fromEntries(Object.entries(WORLD).map(([key, value]) => [key, String(value)])) },
      { userId: '2', ...Object.fromEntries(Object.entries(WORLD).map(([key, value]) => [key, String(value)])) },
    ]);
    expect(observer.onValues).toHaveBeenCalledExactlyOnceWith(['A', 'B']);
    expect(observer.onFeatures).not.toHaveBeenCalled();
  });

  it('keeps discovery alive while cancelling map work and rejecting late success, errors and timings', async () => {
    const observer = { ...observers(), onTiming: vi.fn() };
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
    const discovery = session.discover();
    await session.setBounds(area());
    const agder = session.setUser(0);
    const oslo = session.setUser(1);
    const norway = session.setUser(2);
    expect(calls.map((call) => call.url.searchParams.get('userId'))).toEqual(['2', '0', '1', '2']);
    expect(calls.map((call) => call.options.signal.aborted)).toEqual([false, true, true, false]);
    observer.onFeatures.mockClear();
    observer.onCoverage.mockClear();
    observer.onStatus.mockClear();
    calls[1].options.onTiming?.({ url: calls[1].url.href, httpMs: 1, totalMs: 2, downloadDecodeMs: 1 });
    calls[1].resolve([station('stale')]);
    calls[2].reject(new Error('Stale failure'));
    await Promise.all([agder, oslo]);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    expect(observer.onCoverage).not.toHaveBeenCalled();
    expect(observer.onStatus).not.toHaveBeenCalled();
    expect(observer.onTiming).not.toHaveBeenCalled();
    calls[0].resolve([station('Catalog')]);
    await discovery;
    expect(observer.onValues).toHaveBeenCalledExactlyOnceWith(['Catalog']);
    calls[3].resolve([station('current')]);
    await norway;
    expect(observer.onFeatures).toHaveBeenCalledExactlyOnceWith([station('current')]);
  });

  it.each([false, true])('clears stations and coverage and retains bounds and Buffer=%s across all IDs and retries', async (buffer) => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setFilter('', area(), buffer);
    for (const userId of [0, 1, 2]) {
      const index = calls.length;
      const changed = session.setUser(userId);
      expect(calls[index].url.searchParams.get('userId')).toBe(String(userId));
      expect(Number(calls[index].url.searchParams.get('minX'))).toBeCloseTo(userId === 0 ? (buffer ? -3 : 0) : (buffer ? -1.4 : 1));
      expect(observer.onCoverage.mock.lastCall).toEqual([undefined]);
      expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([undefined]);
      if (userId !== 0) expect(observer.onFeatures.mock.lastCall).toEqual([[]]);
      calls[index].resolve([station(String(userId))]);
      await changed;
      await session.setBounds(area(1, 9));
      await session.setUser(userId);
      expect(calls).toHaveLength(index + 1);
      const retry = session.refresh();
      expect(calls[index + 1].url.searchParams.get('userId')).toBe(String(userId));
      calls[index + 1].resolve([station(String(userId))]);
      await retry;
    }
    await session.setUser(null);
    expect(observer.onFeatures.mock.lastCall).toEqual([[]]);
    expect(observer.onCoverage.mock.lastCall).toEqual([undefined]);
    expect(observer.onPrefetchCoverage.mock.lastCall).toEqual([undefined]);
    expect(observer.onStatus.mock.lastCall).toEqual([{ loading: false, error: null }]);
    await session.refresh();
    expect(calls).toHaveLength(6);
  });

  it.each([0, 1, 2])('scopes split requests and retries to user %s', async (userId) => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setUser(userId);
    await session.setBounds(viewportBounds(170, 50, 190, 60));
    await session.refresh();
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.every(([url]) => url.searchParams.get('userId') === String(userId))).toBe(true);
  });

  it('preserves active filter across users and restores spatial settings when deactivated', async () => {
    const read = vi.fn().mockResolvedValue([station('Oslo')]);
    const session = new DatasetSession('https://example.org', observers(), read);
    await session.setUser(2);
    await session.setFilter('Oslo', area(7, 9), false);
    for (const userId of [0, 1, 2]) await session.setUser(userId);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.every(([url, options]) => url.pathname === '/fgb/filter'
      && url.search === '?attribute=brannvesen&value=Oslo' && options.cache === 'no-store')).toBe(true);
    await session.setFilter('');
    expect(Object.fromEntries(read.mock.lastCall?.[0].searchParams)).toEqual({
      userId: '2', minX: '7', minY: '50', maxX: '9', maxY: '60',
    });
  });
});

describe('connection sessions', () => {
  it.each(['Oslo', 'empty'])('fetches repeated %s filters and refreshes as new batches without comparing feature content', async (selection) => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const initial = session.setFilter('previous');
    calls[0].resolve([station('previous')]);
    await initial;
    const features = selection === 'empty' ? [] : [station('Oslo')];
    for (let index = 1; index <= 4; index++) {
      observer.onFeatures.mockClear();
      const request = index <= 2 ? session.setFilter(selection) : session.refresh();
      expect(calls).toHaveLength(index + 1);
      expect(calls[index].options.cache).toBe('no-store');
      expect(calls[index].url.href).toBe(calls[1].url.href);
      expect([...calls[index].url.searchParams.keys()]).toEqual(['attribute', 'value']);
      expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: true, error: null });
      expect(observer.onFeatures).not.toHaveBeenCalled();
      calls[index].resolve(structuredClone(features));
      await request;
      expect(observer.onFeatures).toHaveBeenCalledExactlyOnceWith(features);
      expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
    }
  });

  it.each(['selection', 'refresh'])('recovers from a failed repeat using %s while retaining displayed features', async (retry) => {
    const observer = observers();
    const read = vi.fn()
      .mockResolvedValueOnce([station('Oslo')])
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce([station('updated Oslo')]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setFilter('Oslo');
    observer.onFeatures.mockClear();
    await session.setFilter('Oslo');
    expect(observer.onFeatures).not.toHaveBeenCalled();
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: 'Offline' });
    await (retry === 'selection' ? session.setFilter('Oslo') : session.refresh());
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onFeatures).toHaveBeenCalledExactlyOnceWith([station('updated Oslo')]);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });

  it('cancels spatial and filter requests through rapid toggles without publishing stale results', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const spatial = session.setFilter('', area(), false);
    const oslo = session.setFilter('Oslo');
    const other = session.setFilter('Other');
    const restored = session.setFilter('', area(20, 30));
    expect(calls.slice(0, 3).every((call) => call.options.signal.aborted)).toBe(true);
    expect(calls[3].url.searchParams.get('minX')).toBe('20');
    calls[3].resolve([station('current', 25)]);
    await restored;
    observer.onFeatures.mockClear();
    observer.onStatus.mockClear();
    observer.onCoverage.mockClear();
    calls[0].resolve([station('stale spatial', 25)]);
    calls[1].resolve([station('stale Oslo', 25)]);
    calls[2].reject(new Error('Stale filter failure'));
    await Promise.all([spatial, oslo, other]);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    expect(observer.onStatus).not.toHaveBeenCalled();
    expect(observer.onCoverage).not.toHaveBeenCalled();
    const retry = session.setFilter('Oslo');
    expect(calls).toHaveLength(5);
    calls[4].resolve([station('fresh Oslo', 8)]);
    await retry;
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('fresh Oslo', 8)]);
  });

  it('discovers sorted distinct nonempty values in a separate full-world request', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org/base/', observer, read);
    const discovering = session.discover();
    const viewport = session.setBounds([{ minX: 7, minY: 58, maxX: 8, maxY: 59 }]);
    expect(calls[0].url.searchParams.get('minX')).toBe('-180');
    expect(calls[0].options.signal.aborted).toBe(false);
    calls[0].resolve([station('Z'), station('A'), station('Z')]);
    await discovering;
    expect(observer.onValues).toHaveBeenCalledWith(['A', 'Z']);
    calls[1].resolve([]);
    await viewport;
    expect(observer.onFeatures).not.toHaveBeenCalledWith([station('Z'), station('A'), station('Z')]);
  });
  it('aborts incompatible modes and ignores late callbacks/results even if transport ignores abort', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const old = session.setBounds([WORLD]);
    const latest = session.setFilter('', area());
    expect(calls[0].options.signal.aborted).toBe(true);
    observer.onFeatures.mockClear();
    calls[0].options.onBatch?.([station('stale')]);
    calls[0].resolve([station('stale')]);
    await old;
    expect(observer.onFeatures).not.toHaveBeenCalled();
    calls[1].options.onBatch?.([station('current')]);
    calls[1].resolve([station('current')]);
    await latest;
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('current')]);
  });
  it('refetches previous filters (including empty results) and keeps matches while the camera moves', async () => {
    const observer = observers();
    const read = vi.fn(async (url: URL, _options: DecodeOptions) => url.searchParams.get('value') === 'empty' ? [] : [station('Oslo')]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds([WORLD]);
    await session.setFilter('Oslo');
    expect(read.mock.lastCall?.[0].pathname).toBe('/fgb/filter');
    expect(read.mock.lastCall?.[0].searchParams.get('value')).toBe('Oslo');
    const filteredCount = read.mock.calls.length;
    await session.setBounds([{ ...WORLD, minX: 0 }]);
    expect(read).toHaveBeenCalledTimes(filteredCount);
    await session.setFilter('empty');
    await session.setFilter('Oslo');
    await session.setFilter('empty');
    expect(read).toHaveBeenCalledTimes(filteredCount + 3);
    expect(read.mock.calls.filter(([url]) => url.pathname === '/fgb/filter')
      .every(([, options]) => options.cache === 'no-store')).toBe(true);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([]);
    await session.setFilter('');
    expect(read.mock.lastCall?.[0].pathname).toBe('/fgb/collection');
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('-180');
    expect(read.mock.lastCall?.[1].cache).toBeUndefined();
  });
  it('does not cancel an in-flight selected filter when the camera moves', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://example.org', observer, read);
    const query = session.setFilter('Oslo');
    await session.setBounds([WORLD]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal.aborted).toBe(false);
    calls[0].resolve([station('Oslo')]);
    await query;
  });
  it('restores the latest bbox atomically when leaving a text filter', async () => {
    const observer = observers();
    const read = vi.fn(async (_url: URL) => [station('Oslo')]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds([WORLD]);
    await session.setFilter('Oslo');
    const before = read.mock.calls.length;
    const bbox = { minX: 7, minY: 58, maxX: 9, maxY: 60 };
    await session.setFilter('', [bbox]);
    expect(read).toHaveBeenCalledTimes(before + 1);
    const expected = expandBounds([bbox])[0];
    expect(Object.fromEntries(read.mock.lastCall![0].searchParams)).toEqual({ userId: '2',
      ...Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, String(value)])) });
    expect(observer.onStatus.mock.lastCall?.[0].loading).toBe(false);
  });
  it('atomically combines both halves of an antimeridian viewport', async () => {
    const observer = observers();
    const read = vi.fn(async (url: URL, options: DecodeOptions) => {
      const features = [station(url.searchParams.get('minX')!, Number(url.searchParams.get('minX')) < 0 ? -175 : 175)];
      options.onBatch?.(features);
      return features;
    });
    const session = norwaySession('https://example.org', observer, read);
    await session.setBounds([{ ...WORLD, minX: 170 }, { ...WORLD, maxX: -170 }]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('164', 175), station('-180', -175)]);
  });
  it('aborts discovery and feature requests on a connection change, without publishing late results', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = norwaySession('https://old.example.org', observer, read);
    const discovering = session.discover();
    const viewing = session.setFilter('Oslo');
    session.dispose();
    observer.onFeatures.mockClear();
    for (const call of calls) {
      expect(call.options.signal.aborted).toBe(true);
      call.options.onBatch?.([station('old')]);
      call.resolve([station('old')]);
    }
    await Promise.all([discovering, viewing]);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    expect(observer.onValues).not.toHaveBeenCalled();
    const fresh = norwaySession('https://new.example.org', observer, read);
    const query = fresh.setFilter('Oslo');
    expect(calls[2].url.hostname).toBe('new.example.org');
    calls[2].resolve([]);
    await query;
  });
  it('reports failures and retries filter requests', async () => {
    const observer = observers();
    const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([station('Oslo')]);
    const session = norwaySession('https://example.org', observer, read);
    await session.setFilter('Oslo');
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: 'Offline' });
    await session.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });
});
