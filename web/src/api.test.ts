import { describe, expect, it, vi } from 'vitest';
import { collectionUrl, decodeResponse, filterUrl, normalizeApiUrl } from './api';
import { WORLD } from './bounds';
import { chunked, encoded, headerOnly } from '../tests/fixtures';

describe('API URLs', () => {
  it('accepts absolute HTTP(S) and preserves a base path', () => {
    expect(normalizeApiUrl(' http://localhost:5220 ')).toBe('http://localhost:5220/');
    expect(normalizeApiUrl('https://example.org/proxy/v1///')).toBe('https://example.org/proxy/v1/');
    const url = collectionUrl('https://example.org/proxy/v1', WORLD);
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
