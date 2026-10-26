import { describe, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';
import type { DecodeOptions } from './api';
import { DatasetSession, distinctBrannvesen } from './session';
import { expandBounds, viewportBounds, WORLD } from './bounds';
import { station } from '../tests/fixtures';

const observers = () => ({
  onFeatures: vi.fn(), onStatus: vi.fn(), onHeader: vi.fn(), onValues: vi.fn(), onDiscovery: vi.fn(),
});

const area = (west = 0, east = 10) => viewportBounds(west, 50, east, 60);

describe('buffered live updates', () => {
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
  it('caches selected filters (including empty results) and keeps matches while the camera moves', async () => {
    const observer = observers();
    const read = vi.fn(async (url: URL) => url.searchParams.get('value') === 'empty' ? [] : [station('Oslo')]);
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
    expect(read).toHaveBeenCalledTimes(filteredCount + 1);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([]);
    await session.setFilter('');
    expect(read.mock.lastCall?.[0].pathname).toBe('/fgb/collection');
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('-180');
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
  it('reports failures and retries without caching partial filter results', async () => {
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
