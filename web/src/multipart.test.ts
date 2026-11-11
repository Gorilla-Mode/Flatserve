import { describe, expect, it, vi } from 'vitest';
import { decodeResponse, featureLayer } from './api';
import { chunked, encoded, headerOnly, multipartEncoded, multipartResponse, station } from '../tests/fixtures';

const signal = () => new AbortController().signal;
const layers = () => [
  { id: 'map.Roads', bytes: encoded([station('Roads')]) },
  { id: 'Øst', bytes: encoded([station('Sør')]) },
  { id: 'Empty', bytes: headerOnly(encoded()) },
];

describe('multipart FGB decoding', () => {
  it.each([1, 7, 65536])('decodes binary parts with %s-byte chunks, retaining IDs and empty layers', async (size) => {
    const onLayer = vi.fn();
    const onBatch = vi.fn();
    const features = await decodeResponse(multipartResponse(layers(), size), { signal: signal(), onLayer, onBatch, batchSize: 1 });
    expect(features.map(featureLayer)).toEqual(['map.Roads', 'Øst']);
    expect(features.map((feature) => feature.properties?.brannvesen)).toEqual(['Roads', 'Sør']);
    expect(features.every((feature) => feature.id === undefined)).toBe(true);
    expect(onLayer.mock.calls.map(([layer]) => layer.id)).toEqual(['map.Roads', 'Øst', 'Empty']);
    expect(onBatch.mock.lastCall?.[0]).toEqual(features);
  });

  it.each(['truncated', 'duplicate', 'invalid-fgb', 'missing-boundary', 'wrong-type'])(
    'rejects %s responses', async (failure) => {
      let bytes = multipartEncoded(failure === 'duplicate' ? [layers()[0], layers()[0]] : layers());
      if (failure === 'truncated') bytes = bytes.slice(0, -12);
      if (failure === 'invalid-fgb') bytes = multipartEncoded([{ id: 'bad', bytes: new TextEncoder().encode('broken') }]);
      if (failure === 'wrong-type') bytes = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('application/vnd.fgb', 'text/plain'));
      const response = chunked(bytes);
      response.headers.set('Content-Type', failure === 'missing-boundary' ? 'multipart/mixed' : 'multipart/mixed; boundary=fgb-test');
      await expect(decodeResponse(response, { signal: signal() })).rejects.toThrow();
    },
  );

  it('cancels a partial multipart download and releases its reader', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(multipartEncoded(layers()).slice(0, 120)); }, cancel,
    }), { headers: { 'Content-Type': 'multipart/mixed; boundary=fgb-test' } });
    const pending = decodeResponse(response, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
