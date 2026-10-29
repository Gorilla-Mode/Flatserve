import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizedAreaUrl, collectionUrl, decodeResponse, fetchAuthorizedArea, fetchFeatures, filterUrl, httpDuration, normalizeApiUrl } from './api';
import { WORLD } from './bounds';
import { chunked, encoded, headerOnly } from '../tests/fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const polygon = {
  type: 'Feature', properties: { userId: 0 },
  geometry: { type: 'Polygon', coordinates: [[[7, 58], [9, 58], [9, 60], [7, 58]]] },
};

describe('authorized area', () => {
  it.each([0, 1, 2])('preserves the base path for user %s and requests GeoJSON without credentials', async (id) => {
    const url = authorizedAreaUrl('https://example.org/proxy/v1///', id);
    expect(url.href).toBe(`https://example.org/proxy/v1/fgb/auth-polygon/${id}`);
    expect(authorizedAreaUrl('http://localhost:5220', id).pathname).toBe(`/fgb/auth-polygon/${id}`);
    const fetchMock = vi.fn(async () => Response.json(polygon));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(await fetchAuthorizedArea('https://example.org/proxy/v1', id, signal)).toEqual(polygon);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
      signal, credentials: 'omit', headers: { Accept: 'application/geo+json' },
    });
  });

  it.each([
    null, {}, { ...polygon, type: 'FeatureCollection' }, { ...polygon, geometry: null },
    { ...polygon, properties: [] },
    ...[
      { type: 'MultiPolygon', coordinates: [polygon.geometry.coordinates] },
      { type: 'Point', coordinates: [7, 58] },
      { type: 'Polygon', coordinates: [] },
      { type: 'Polygon', coordinates: null },
      { type: 'Polygon', coordinates: [[]] },
      { type: 'Polygon', coordinates: [[[7, 58], [9, 58], [7, 58]]] },
      { type: 'Polygon', coordinates: [[[7, 58], [9, 58], [9, 60], [8, 58]]] },
      { type: 'Polygon', coordinates: [[[7, 58], [9, '58'], [9, 60], [7, 58]]] },
      { type: 'Polygon', coordinates: [[[7, 58], [9, null], [9, 60], [7, 58]]] },
      { type: 'Polygon', coordinates: [[[7, 58], [9], [9, 60], [7, 58]]] },
    ].map((geometry) => ({ ...polygon, geometry })),
  ])('rejects malformed GeoJSON (%j)', async (feature) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(feature)));
    await expect(fetchAuthorizedArea('https://example.org', 0, new AbortController().signal))
      .rejects.toThrow('valid Polygon and finite coordinates');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite coordinates (%s)', async (coordinate) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...polygon,
      geometry: { type: 'Polygon', coordinates: [[[7, 58], [9, coordinate], [9, 60], [7, 58]]] },
    }) })));
    await expect(fetchAuthorizedArea('https://example.org', 0, new AbortController().signal)).rejects.toThrow('finite coordinates');
  });

  it('accepts holes and finite altitude coordinates', async () => {
    const feature = { ...polygon, properties: null, geometry: { type: 'Polygon', coordinates: [
      [[7, 58, 0], [9, 58, 0], [9, 60, 0], [7, 58, 0]],
      [[8, 58.5, 0], [8.5, 58.5, 0], [8.5, 59, 0], [8, 58.5, 0]],
    ] } };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(feature)));
    expect(await fetchAuthorizedArea('https://example.org', 0, new AbortController().signal)).toEqual(feature);
  });

  it('reports HTTP and invalid JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unavailable', { status: 503 })));
    await expect(fetchAuthorizedArea('https://example.org', 1, new AbortController().signal)).rejects.toThrow('HTTP 503');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid json')));
    await expect(fetchAuthorizedArea('https://example.org', 1, new AbortController().signal)).rejects.toThrow('not valid JSON');
  });

  it('honors abort before fetching and after reading the body even when fetch ignores cancellation', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => Response.json(polygon));
    vi.stubGlobal('fetch', fetchMock);
    controller.abort();
    await expect(fetchAuthorizedArea('https://example.org', 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    const pending = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { pending.abort(); return polygon; } })));
    await expect(fetchAuthorizedArea('https://example.org', 0, pending.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetch options', () => {
  it.each([undefined, 'no-store'] as const)('forwards cache mode %s without changing the URL', async (cache) => {
    const fetchMock = vi.fn(async () => chunked(encoded()));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const url = filterUrl('https://example.org', 'Oslo');
    await fetchFeatures(url, { signal, cache });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
      signal, cache, credentials: 'omit', headers: { Accept: 'application/octet-stream' },
    });
    expect([...url.searchParams.keys()]).toEqual(['attribute', 'value']);
  });
});

describe('request timing', () => {
  it.each([[false, 0], [true, 0], [false, 500]] as const)('uses network timestamps independently of decoding delays (empty: %s, delay: %s)', async (empty, delay) => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let headers!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { headers = resolve; })));
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
    const onTiming = vi.fn();
    const onHeader = vi.fn();
    const url = filterUrl('https://example.org/proxy', 'Sør & Øst');
    vi.spyOn(performance, 'getEntriesByName').mockImplementation(() => {
      clock += 1000; // Timing lookup must not inflate browser total.
      return [resource(url.href, 110, 210)];
    }).mockReturnValueOnce([]);
    const result = fetchFeatures(url, { signal: new AbortController().signal, onTiming, onHeader,
      onBatch: () => { clock += delay; } });
    clock = 125;
    headers(response);
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    clock = 175;
    body.enqueue(empty ? headerOnly(encoded()) : encoded());
    await vi.waitFor(() => expect(onHeader).toHaveBeenCalledOnce());
    expect(onTiming).not.toHaveBeenCalled();
    clock = 245;
    body.close();
    expect(await result).toHaveLength(empty ? 0 : 3);
    expect(onTiming).toHaveBeenCalledExactlyOnceWith({ url: url.href, httpMs: 100, downloadDecodeMs: 120 + delay, totalMs: 145 + delay });
  });

  it.each(['http', 'decode', 'network', 'abort-fetch', 'abort-body', 'already-aborted'])(
    'does not publish timing for %s failures', async (failure) => {
      const controller = new AbortController();
      const onTiming = vi.fn();
      const fetchMock = vi.fn(async () => {
        if (failure === 'network') throw new TypeError('Offline');
        if (failure === 'abort-fetch') { controller.abort(); controller.signal.throwIfAborted(); }
        if (failure === 'http') return new Response('error', { status: 503 });
        if (failure === 'decode') return new Response('invalid FlatGeobuf');
        return chunked(encoded());
      });
      vi.stubGlobal('fetch', fetchMock);
      if (failure === 'already-aborted') controller.abort();
      await expect(fetchFeatures(collectionUrl('https://example.org', WORLD, 2), {
        signal: controller.signal, onTiming,
        onHeader: () => { if (failure === 'abort-body') controller.abort(); },
      })).rejects.toThrow();
      expect(onTiming).not.toHaveBeenCalled();
      if (failure === 'already-aborted') expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('API URLs', () => {
  it.each([0, 1, 2])('includes demo user %s in collection requests only', (userId) => {
    expect(collectionUrl('https://example.org', WORLD, userId).searchParams.get('userId')).toBe(String(userId));
    expect([...filterUrl('https://example.org', 'Oslo').searchParams.keys()]).toEqual(['attribute', 'value']);
  });
  it('accepts absolute HTTP(S) and preserves a base path', () => {
    expect(normalizeApiUrl(' http://localhost:5220 ')).toBe('http://localhost:5220/');
    expect(normalizeApiUrl('https://example.org/proxy/v1///')).toBe('https://example.org/proxy/v1/');
    const url = collectionUrl('https://example.org/proxy/v1', WORLD, 2);
    expect(url.pathname).toBe('/proxy/v1/fgb/collection');
    expect(url.searchParams.get('minX')).toBe('-180');
    const filtered = filterUrl('https://example.org/proxy', 'A & B / Sør + Øst');
    expect(filtered.pathname).toBe('/proxy/fgb/filter');
    expect(filtered.searchParams.get('value')).toBe('A & B / Sør + Øst');
    expect(filtered.searchParams.get('attribute')).toBe('brannvesen');
  });
  it.each(['/api', 'localhost:5220', 'https:example.org', 'http:/example.org', 'ftp://example.org', 'javascript:alert(1)',
    'https://user:pass@example.org', 'https://example.org/?x=1', 'https://example.org/#api'])(
    'rejects ambiguous or unsupported URL %s', (url) => expect(() => normalizeApiUrl(url)).toThrow(),
  );
});

describe('progressive FlatGeobuf decoding', () => {
  it('decodes headers, UTF-8 properties, and features split into tiny chunks', async () => {
    const onHeader = vi.fn();
    const onBatch = vi.fn();
    const features = await decodeResponse(chunked(encoded(), 1), {
      signal: new AbortController().signal, onHeader, onBatch, batchSize: 2,
    });
    expect(features).toHaveLength(3);
    expect(features[0].properties?.brannvesen).toBe('Oslo');
    expect(features[1].properties?.brannvesen).toBe('Kristiansand – Sør');
    expect(features[0].id).toBeUndefined();
    expect(onHeader).toHaveBeenCalledOnce();
    expect(onHeader.mock.calls[0][0].crs.code).toBe(4326);
    expect(onBatch.mock.calls.map(([batch]) => batch.length)).toContain(2);
    expect(onBatch.mock.lastCall?.[0]).toHaveLength(3);
  });
  it('publishes a batch before the stream ends', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const onBatch = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
    const result = decodeResponse(response, { signal: new AbortController().signal, onBatch, batchSize: 1 });
    controller.enqueue(encoded());
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalled());
    controller.close();
    expect(await result).toHaveLength(3);
  });
  it('accepts a header-only response and publishes an empty batch', async () => {
    const onBatch = vi.fn();
    const onHeader = vi.fn();
    expect(await decodeResponse(chunked(headerOnly(encoded())), {
      signal: new AbortController().signal, onHeader, onBatch,
    })).toEqual([]);
    expect(onHeader).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledWith([]);
  });
  it('cancels the underlying reader and rejects an aborted partial stream', async () => {
    const cancel = vi.fn();
    const signal = new AbortController();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoded().slice(0, 10)); }, cancel,
    }));
    const result = decodeResponse(response, { signal: signal.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    signal.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  it('reports HTTP errors and invalid files', async () => {
    await expect(decodeResponse(new Response('error', { status: 503 }), {
      signal: new AbortController().signal,
    })).rejects.toThrow('HTTP 503');
    await expect(decodeResponse(new Response('this is not FlatGeobuf'), {
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });
});

function resource(name: string, startTime: number, responseEnd: number, initiatorType = 'fetch'): PerformanceResourceTiming {
  return { name, entryType: 'resource', startTime, responseEnd, initiatorType,
    requestStart: 0, responseStart: 0, connectStart: 0, domainLookupStart: 0,
  } as PerformanceResourceTiming;
}

describe('HTTP Resource Timing attribution', () => {
  const url = 'https://cross-origin.example/fgb/filter?value=A';
  it('uses start and end even when cross-origin detailed fields are restricted', () => {
    expect(httpDuration([resource(url, 110, 210)], url, 100, 245)).toBe(100);
  });
  it('excludes entries already present even when timestamps have been rounded', () => {
    const old = resource(url, 100, 120);
    expect(httpDuration([old], url, 100, 245, new Set([old]))).toBeNull();
    expect(httpDuration([old, resource(url, 100, 210)], url, 100, 245, new Set([old]))).toBe(110);
  });
  it('excludes earlier entries for repeated URLs and other URLs or initiators', () => {
    expect(httpDuration([resource(url, 10, 90), resource(url, 110, 210),
      resource(url + 'B', 120, 220), resource(url, 120, 220, 'xmlhttprequest')], url, 100, 245)).toBe(100);
  });
  it.each([[], [resource(url, 10, 90)], [resource(url, 110, 210), resource(url, 120, 220)],
    [resource(url, 110, 0)], [resource(url, 110, 110)], [resource(url, 110, 109)],
    [resource(url, 110, Infinity)], [resource(url, NaN, 210)], [resource(url, 110, 246)]].map((entries) => ({ entries })))(
    'returns unavailable for missing, ambiguous or invalid entries (%j)', ({ entries }) => {
      expect(httpDuration(entries, url, 100, 245)).toBeNull();
    },
  );
  it('marks both overlapping same-URL calls unavailable even when only one entry is complete', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([resource(url, 110, 210)]);
    const releases: ((response: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve))));
    const onTiming = vi.fn();
    const first = fetchFeatures(new URL(url), { signal: new AbortController().signal, onTiming });
    clock = 120;
    const second = fetchFeatures(new URL(url), { signal: new AbortController().signal, onTiming });
    clock = 245;
    releases[0](chunked(encoded()));
    await first;
    releases[1](chunked(encoded()));
    await second;
    expect(onTiming.mock.calls.map(([timing]) => timing.httpMs)).toEqual([null, null]);
    // A later request can be attributed normally after overlapping calls finish.
    clock = 300;
    vi.stubGlobal('fetch', vi.fn(async () => { clock = 400; return chunked(encoded()); }));
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([resource(url, 310, 390)]).mockReturnValueOnce([]);
    await fetchFeatures(new URL(url), { signal: new AbortController().signal, onTiming });
    expect(onTiming.mock.lastCall?.[0].httpMs).toBe(80);
  });
});
