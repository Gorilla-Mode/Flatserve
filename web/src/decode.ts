import { deserialize } from 'flatgeobuf/geojson';
import type { Feature } from 'geojson';
import type { DecodeOptions } from './api';
import { readFgbParts } from './multipart';

/** Decode the response as it arrives, including headers/features split across chunks. */
export async function decodeResponse(response: Response, options: DecodeOptions): Promise<Feature[]> {
  const { signal, onBatch, onHeader, batchSize = 100 } = options;
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}.`);
  if (!response.body) throw new Error('The API returned no response stream.');

  if (/^multipart\/mixed\b/i.test(response.headers.get('content-type') ?? '')) {
    const parts = await readFgbParts(response, signal, options.yieldControl);
    const all: Feature[] = [];
    for (const part of parts) {
      signal.throwIfAborted();
      const tag = (features: Feature[]) => features.map((feature) => ({ ...feature, fgbLayerId: part.id }));
      const features = await decodeResponse(new Response(part.bytes), {
        ...options,
        onLayer: undefined,
        onHeader: (header) => {
          onHeader?.(header);
          options.onLayer?.({ id: part.id, header, ...(part.lod === undefined ? {} : { lod: part.lod }) });
        },
        onBatch: onBatch ? (batch) => onBatch([...all, ...tag(batch)]) : undefined,
      });
      for (const [index, feature] of features.entries()) {
        (feature as import('./api').LayerFeature).fgbLayerId = part.id;
        all.push(feature);
        if (index % 1000 === 999 && options.yieldControl) {
          await options.yieldControl(); signal.throwIfAborted();
        }
      }
    }
    return all;
  }

  // Own the reader so abort/early-exit also releases the decoder's underlying stream.
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const features: Feature[] = [];
  let published = -1;
  let lastBatch = performance.now();
  try {
    for await (const feature of deserialize(stream, {
      headerMetaFn: (header) => {
        signal.throwIfAborted();
        onHeader?.(header);
        options.onLayer?.({ id: 'dataset', header });
      },
    })) {
      signal.throwIfAborted();
      // Decoder IDs start at zero in every response, including split viewport requests.
      const { id: _id, ...data } = feature;
      features.push(data);
      if (features.length % batchSize === 0 || performance.now() - lastBatch >= 16) {
        if (onBatch) onBatch(features.slice());
        await options.yieldControl?.();
        signal.throwIfAborted();
        published = features.length;
        lastBatch = performance.now();
      }
    }
    signal.throwIfAborted();
    if (onBatch && published !== features.length) onBatch(features.slice());
    return features;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

