import { afterEach, expect, it, vi } from 'vitest';
import { fetchIndexes, filterUrl } from './api';
import { DatasetSession } from './session';

afterEach(() => { vi.unstubAllGlobals(); });

it('discovers and merges real indexes across layers, preserving empty and Unicode values', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ layers: [
    { id: 'one', indexes: [{ attribute: 'name', values: ['Øst', '', 'West'] }] },
    { id: 'two', indexes: [{ attribute: 'name', values: ['West'] }, { attribute: 'category', values: [] }] },
    { id: 'three', indexes: [] },
  ] }));
  vi.stubGlobal('fetch', fetchMock);
  const signal = new AbortController().signal;
  const indexes = await fetchIndexes('https://example.org/proxy', signal);
  expect(indexes).toEqual([
    { attribute: 'category', values: [], layers: ['two'] },
    { attribute: 'name', values: ['', 'West', 'Øst'], layers: ['one', 'two'] },
  ]);
  expect(fetchMock.mock.calls[0][0].href).toBe('https://example.org/proxy/fgb/indexes');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal, credentials: 'omit', cache: 'no-store' });
  expect(filterUrl('https://example.org/proxy', 'Øst & West', 'name').searchParams.get('attribute')).toBe('name');
});

it('does not invent indexes when the server reports none', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ layers: [{ id: 'one', indexes: [] }] })));
  expect(await fetchIndexes('https://example.org', new AbortController().signal)).toEqual([]);
});

it.each([{}, { layers: [{}] }, { layers: [{ id: 'one', indexes: [{ attribute: 'name', values: [1] }] }] }])(
  'rejects invalid metadata %j', async (metadata) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(metadata)));
    await expect(fetchIndexes('https://example.org', new AbortController().signal)).rejects.toThrow('Invalid index metadata');
  },
);

it('reports HTTP errors and discards metadata returned after cancellation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Offline', { status: 503 })));
  await expect(fetchIndexes('https://example.org', new AbortController().signal)).rejects.toThrow('HTTP 503');
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => {
    controller.abort();
    return Response.json({ layers: [] });
  }));
  await expect(fetchIndexes('https://example.org', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('queries arbitrary attributes and empty values, and cancels stale filters on index changes', async () => {
  const requests: { url: URL; signal: AbortSignal; resolve: (features: []) => void }[] = [];
  const observer = { onFeatures: vi.fn(), onHeader: vi.fn(), onStatus: vi.fn(), onDiscovery: vi.fn() };
  const read = vi.fn((url: URL, options: { signal: AbortSignal }) => new Promise<[]>((resolve) => {
    requests.push({ url, signal: options.signal, resolve });
  }));
  const session = new DatasetSession('https://example.org', observer, read);
  await session.setUser(2);
  const first = session.setTextFilter({ attribute: 'name', value: '' });
  expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({ attribute: 'name', value: '' });
  const second = session.setTextFilter({ attribute: 'category', value: 'A & B' });
  expect(requests[0].signal.aborted).toBe(true);
  expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({ attribute: 'category', value: 'A & B' });
  requests[1].resolve([]);
  requests[0].resolve([]);
  await Promise.all([first, second]);
  expect(observer.onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  session.dispose();
});
