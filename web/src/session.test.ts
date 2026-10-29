import { describe, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';
import type { DecodeOptions, RequestTiming } from './api';
import { DatasetSession, distinctBrannvesen } from './session';
import { expandBounds, viewportBounds, WORLD } from './bounds';
import { station } from '../tests/fixtures';
import { timingHistory } from './timings';
import type { TimingRecord } from './timings';

const observers = () => ({
  onFeatures: vi.fn(), onStatus: vi.fn(), onHeader: vi.fn(), onValues: vi.fn(), onDiscovery: vi.fn(),
  onCoverage: vi.fn(),
});

const area = (west = 0, east = 10) => viewportBounds(west, 50, east, 60);

describe('session timings', () => {
  const timing = (url: URL): RequestTiming => ({ url: url.href, httpMs: 10, downloadDecodeMs: 20, totalMs: 30 });

  it('records concurrent discovery, multipart calls and repeated filters, excluding spatial reuse', async () => {
    let records: TimingRecord[] = [];
    const observer = { ...observers(), onTiming: (value: ReturnType<typeof timing>) => { records = timingHistory(records, value); } };
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', { ...observers(), onTiming }, read);
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
  it('reports empty spatial success, reuses it silently, and keeps it during movement and failures', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
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
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area())], [expandBounds(area(4, 14))]]);
  });

  it('clears coverage on refresh, query configuration changes, filters, and disposal', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds(area());
    observer.onCoverage.mockClear();
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
  });

  it('publishes multipart coverage only on complete success, retaining previous coverage on partial failure', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
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
    const retry = session.refresh();
    expect(observer.onCoverage.mock.lastCall).toEqual([undefined]);
    calls[3].resolve([]);
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(observer.onCoverage).toHaveBeenCalledTimes(2);
    calls[4].resolve([]);
    await retry;
    expect(observer.onCoverage.mock.lastCall).toEqual([expandBounds(crossing)]);
  });

  it('ignores aborted and stale responses, including after disposal', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
    const stale = session.setBounds(area());
    const latest = session.setFilter('', area(20, 30));
    observer.onCoverage.mockClear();
    calls[0].resolve([]);
    await stale;
    expect(observer.onCoverage).not.toHaveBeenCalled();
    expect(calls[0].options.signal.aborted).toBe(true);
    calls[1].resolve([]);
    await latest;
    expect(observer.onCoverage.mock.calls).toEqual([[expandBounds(area(20, 30))]]);
    const disposed = session.setBounds(area(40, 50));
    session.dispose();
    observer.onCoverage.mockClear();
    calls[2].resolve([]);
    await disposed;
    expect(observer.onCoverage).not.toHaveBeenCalled();
  });
});

describe('buffered live updates', () => {
  it('requests exact bounds with Buffer off and reuses containing coverage with live filtering', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('inside', 8), station('edge', 10)]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setFilter('', area(), false);
    expect(Object.fromEntries(read.mock.calls[0][0].searchParams)).toEqual({
      minX: '0', minY: '50', maxX: '10', maxY: '60',
    });
    await session.setBounds(area(7, 9));
    expect(read).toHaveBeenCalledTimes(1);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('inside', 8)]);
    await session.setBounds(area(7, 11));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.lastCall?.[0].searchParams.get('maxX')).toBe('11');
  });

  it('preserves Buffer through repeated filters and bbox changes and Retry', async () => {
    const read = vi.fn().mockResolvedValue([station('Oslo', 8)]);
    const session = new DatasetSession('https://example.org', observers(), read);
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
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('-2.5');
  });

  it.each([false, true])('cancels pending work when Buffer becomes %s and rejects stale success and errors', async (enabled) => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds([WORLD]);
    await session.setFilter('', [WORLD], false);
    expect(read).toHaveBeenCalledTimes(2);
    await session.setBounds([WORLD]);
    expect(read).toHaveBeenCalledTimes(2);
    await session.setFilter('', [WORLD], true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });

  it('requests a buffer, filters locally during movement, and publishes only changed subsets', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('inside', 8), station('buffer', 12), station('outside', 20)]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds(area());
    expect(Object.fromEntries(read.mock.calls[0][0].searchParams)).toEqual({
      minX: '-2.5', minY: '47.5', maxX: '12.5', maxY: '62.5',
    });
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('inside', 8)]);
    await session.setBounds(area(1, 11));
    expect(observer.onFeatures).toHaveBeenCalledTimes(1);
    await session.setBounds(area(2.5, 12.5));
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('inside', 8), station('buffer', 12)]);
    await session.setBounds(area(2.5, 12.5));
    expect(observer.onFeatures).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    await session.setBounds(area(3, 13));
    expect(read).toHaveBeenCalledTimes(2);
    // Even a new response with identical content should not update the map source.
    expect(observer.onFeatures).toHaveBeenCalledTimes(2);
  });

  it('keeps one logical request, catches up to the latest bounds, and filters completion against them', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
    const first = session.setBounds(area());
    const moving = session.setBounds(area(10, 20));
    session.setBounds(area(20, 30));
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal.aborted).toBe(false);
    calls[0].options.onBatch?.([station('partial', 8)]);
    expect(observer.onFeatures).not.toHaveBeenCalled();
    calls[0].resolve([station('old', 8)]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].url.searchParams.get('minX')).toBe('17.5');
    expect(observer.onFeatures).not.toHaveBeenCalled();
    // A newer camera position inside the pending buffer needs no third request.
    session.setBounds(area(22, 32));
    calls[1].resolve([station('hidden', 21), station('visible', 28)]);
    await Promise.all([first, moving]);
    expect(calls).toHaveLength(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('visible', 28)]);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });

  it('keeps the last successful dataset while loading and replaces it only on full success', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    await session.setBounds(expandBounds(bounds));
    expect(calls).toHaveLength(4);
  });

  it('invalidates coverage on bbox mode changes and returning from a filter', async () => {
    const observer = observers();
    const read = vi.fn().mockResolvedValue([station('Oslo', 8)]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds(area());
    await session.setFilter('', area(4, 6));
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([]);
    await session.setFilter('Oslo');
    await session.setBounds(area(7, 9));
    expect(read).toHaveBeenCalledTimes(3);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('Oslo', 8)]);
    await session.setFilter('');
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('6.5');
  });
});
function pendingReader() {
  const calls: { url: URL; options: DecodeOptions; resolve: (features: Feature[]) => void; reject: (error: Error) => void }[] = [];
  const read = vi.fn((url: URL, options: DecodeOptions) => new Promise<Feature[]>((resolve, reject) => {
    calls.push({ url, options, resolve, reject });
  }));
  return { calls, read };
}

describe('connection sessions', () => {
  it.each(['Oslo', 'empty'])('fetches repeated %s filters and refreshes without republishing identical results', async (selection) => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
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
      if (index === 1) expect(observer.onFeatures).toHaveBeenCalledExactlyOnceWith(features);
      else expect(observer.onFeatures).not.toHaveBeenCalled();
      expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
    }
  });

  it.each(['selection', 'refresh'])('recovers from a failed repeat using %s while retaining displayed features', async (retry) => {
    const observer = observers();
    const read = vi.fn()
      .mockResolvedValueOnce([station('Oslo')])
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce([station('updated Oslo')]);
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    expect(distinctBrannvesen([station('Z'), station('A'), station('A'), station(' '),
      { ...station(''), properties: null }])).toEqual(['A', 'Z']);
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org/base/', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
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
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds([WORLD]);
    await session.setFilter('Oslo');
    const before = read.mock.calls.length;
    const bbox = { minX: 7, minY: 58, maxX: 9, maxY: 60 };
    await session.setFilter('', [bbox]);
    expect(read).toHaveBeenCalledTimes(before + 1);
    expect(Object.fromEntries(read.mock.lastCall![0].searchParams)).toEqual({ minX: '6.5', minY: '57.5', maxX: '9.5', maxY: '60.5' });
    expect(observer.onStatus.mock.lastCall?.[0].loading).toBe(false);
  });
  it('atomically combines both halves of an antimeridian viewport', async () => {
    const observer = observers();
    const read = vi.fn(async (url: URL, options: DecodeOptions) => {
      const features = [station(url.searchParams.get('minX')!, Number(url.searchParams.get('minX')) < 0 ? -175 : 175)];
      options.onBatch?.(features);
      return features;
    });
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds([{ ...WORLD, minX: 170 }, { ...WORLD, maxX: -170 }]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('165', 175), station('-180', -175)]);
  });
  it('aborts discovery and feature requests on a connection change, without publishing late results', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://old.example.org', observer, read);
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
    const fresh = new DatasetSession('https://new.example.org', observer, read);
    const query = fresh.setFilter('Oslo');
    expect(calls[2].url.hostname).toBe('new.example.org');
    calls[2].resolve([]);
    await query;
  });
  it('reports failures and retries filter requests', async () => {
    const observer = observers();
    const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([station('Oslo')]);
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setFilter('Oslo');
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: 'Offline' });
    await session.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  });
});
