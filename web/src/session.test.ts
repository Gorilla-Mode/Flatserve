import { describe, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';
import type { DecodeOptions } from './api';
import { DatasetSession, distinctBrannvesen } from './session';
import { WORLD } from './bounds';
import { station } from '../tests/fixtures';

const observers = () => ({
  onFeatures: vi.fn(), onStatus: vi.fn(), onHeader: vi.fn(), onValues: vi.fn(), onDiscovery: vi.fn(),
});
function pendingReader() {
  const calls: { url: URL; options: DecodeOptions; resolve: (features: Feature[]) => void }[] = [];
  const read = vi.fn((url: URL, options: DecodeOptions) => new Promise<Feature[]>((resolve) => {
    calls.push({ url, options, resolve });
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
  it('aborts superseded bounds and ignores late callbacks/results even if transport ignores abort', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
    const old = session.setBounds([WORLD]);
    session.cancelViewport();
    const latest = session.setBounds([{ ...WORLD, minX: 0 }]);
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
    session.cancelViewport();
    await session.setBounds([{ ...WORLD, minX: 0 }]);
    expect(read).toHaveBeenCalledTimes(filteredCount);
    await session.setFilter('empty');
    await session.setFilter('Oslo');
    await session.setFilter('empty');
    expect(read).toHaveBeenCalledTimes(filteredCount + 1);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([]);
    await session.setFilter('');
    expect(read.mock.lastCall?.[0].pathname).toBe('/fgb/collection');
    expect(read.mock.lastCall?.[0].searchParams.get('minX')).toBe('0');
  });
  it('does not cancel an in-flight selected filter when the camera moves', async () => {
    const observer = observers();
    const { read, calls } = pendingReader();
    const session = new DatasetSession('https://example.org', observer, read);
    const query = session.setFilter('Oslo');
    session.cancelViewport();
    await session.setBounds([WORLD]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal.aborted).toBe(false);
    calls[0].resolve([station('Oslo')]);
    await query;
  });
  it('combines batches from both halves of an antimeridian viewport', async () => {
    const observer = observers();
    const read = vi.fn(async (url: URL, options: DecodeOptions) => {
      const features = [station(url.searchParams.get('minX')!)];
      options.onBatch?.(features);
      return features;
    });
    const session = new DatasetSession('https://example.org', observer, read);
    await session.setBounds([{ ...WORLD, minX: 170 }, { ...WORLD, maxX: -170 }]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.onFeatures.mock.lastCall?.[0]).toEqual([station('170'), station('-180')]);
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
