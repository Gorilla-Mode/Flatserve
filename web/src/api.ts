import { deserialize } from 'flatgeobuf/geojson';
import type { HeaderMeta } from 'flatgeobuf/lib/mjs/header-meta.js';
import type { Feature } from 'geojson';
import type { Bounds } from './bounds';

export type { HeaderMeta };

export function normalizeApiUrl(input: string): string {
  let url: URL;
  try {
    if (!/^https?:\/\//i.test(input.trim())) throw new Error('Missing HTTP(S) scheme.');
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter an absolute HTTP(S) API URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Enter an absolute HTTP(S) API URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use an API URL without credentials, a query, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}

export function collectionUrl(base: string, bounds: Bounds): URL {
  const url = new URL('fgb/collection', normalizeApiUrl(base));
  for (const [key, value] of Object.entries(bounds)) url.searchParams.set(key, String(value));
  return url;
}

export function filterUrl(base: string, value: string): URL {
  const url = new URL('fgb/filter', normalizeApiUrl(base));
  url.searchParams.set('attribute', 'brannvesen');
  url.searchParams.set('value', value);
  return url;
}

export interface DecodeOptions {
  signal: AbortSignal;
  cache?: RequestCache;
  onBatch?: (features: Feature[]) => void;
  onHeader?: (header: HeaderMeta) => void;
  batchSize?: number;
  onTiming?: (timing: RequestTiming) => void;
}

export interface RequestTiming {
  url: string;
  httpMs: number | null;
  downloadDecodeMs: number;
  totalMs: number;
}

/** Decode the response as it arrives, including headers/features split across chunks. */
export async function decodeResponse(response: Response, options: DecodeOptions): Promise<Feature[]> {
  const { signal, onBatch, onHeader, batchSize = 100 } = options;
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}.`);
  if (!response.body) throw new Error('The API returned no response stream.');

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
      },
    })) {
      signal.throwIfAborted();
      // Decoder IDs start at zero in every response, including split viewport requests.
      const { id: _id, ...data } = feature;
      features.push(data);
      if (features.length % batchSize === 0 || performance.now() - lastBatch >= 50) {
        onBatch?.(features.slice());
        published = features.length;
        lastBatch = performance.now();
      }
    }
    signal.throwIfAborted();
    if (published !== features.length) onBatch?.(features.slice());
    return features;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Match only a completed fetch in this call's window; never guess between entries. */
export function httpDuration(
  entries: PerformanceEntry[], url: string, started: number, finished: number,
  earlier: ReadonlySet<PerformanceEntry> = new Set(),
): number | null {
  const matches = entries.filter((entry) => !earlier.has(entry) && entry.entryType === 'resource' && entry.name === url
    && (entry as PerformanceResourceTiming).initiatorType === 'fetch'
    && entry.startTime >= started && entry.startTime <= finished) as PerformanceResourceTiming[];
  if (matches.length !== 1) return null;
  const { startTime, responseEnd } = matches[0];
  return Number.isFinite(startTime) && Number.isFinite(responseEnd)
    && responseEnd > startTime && responseEnd <= finished ? responseEnd - startTime : null;
}

// Entries alone cannot disambiguate a same-URL fetch whose body is still in flight.
const activeTimings = new Map<string, Set<{ ambiguous: boolean }>>();

export async function fetchFeatures(url: URL, options: DecodeOptions): Promise<Feature[]> {
  options.signal.throwIfAborted();
  const requestUrl = url.href;
  const active = activeTimings.get(requestUrl) ?? new Set<{ ambiguous: boolean }>();
  const attribution = { ambiguous: active.size > 0 };
  for (const other of active) other.ambiguous = true;
  active.add(attribution);
  activeTimings.set(requestUrl, active);
  try {
    // Exclude existing entries even if the browser rounds adjacent calls to the same timestamp.
    const earlier = new Set(performance.getEntriesByName(requestUrl, 'resource'));
    const started = performance.now();
    const response = await fetch(url, {
      signal: options.signal,
      cache: options.cache,
      credentials: 'omit',
      headers: { Accept: 'application/octet-stream' },
    });
    const headersReceived = performance.now();
    const features = await decodeResponse(response, options);
    const finished = performance.now();
    options.signal.throwIfAborted();
    const httpMs = attribution.ambiguous ? null : httpDuration(
      performance.getEntriesByName(requestUrl, 'resource'), requestUrl, started, finished, earlier,
    );
    options.onTiming?.({
      url: requestUrl,
      httpMs,
      downloadDecodeMs: finished - headersReceived,
      totalMs: finished - started,
    });
    return features;
  } finally {
    active.delete(attribution);
    if (active.size === 0) activeTimings.delete(requestUrl);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
