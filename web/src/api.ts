import type { HeaderMeta } from 'flatgeobuf/lib/mjs/header-meta.js';
import type { Feature, Polygon } from 'geojson';
import type { Bounds } from './bounds';
import { readResponseBytes } from './multipart';
import { decodeResponse } from './decode';
export { decodeResponse } from './decode';

export type { HeaderMeta };

export interface FgbLayer { id: string; header: HeaderMeta; lod?: number }
export type LayerFeature = Feature & { fgbLayerId?: string };
export const featureLayer = (feature: Feature): string => (feature as LayerFeature).fgbLayerId ?? 'dataset';

export interface TextIndex { attribute: string; values: string[]; layers: string[] }

/** Discover indexes the server built, rather than inferring them from FGB columns. */
export async function fetchIndexes(base: string, signal: AbortSignal): Promise<TextIndex[]> {
  signal.throwIfAborted();
  const response = await fetch(new URL('fgb/indexes', normalizeApiUrl(base)), {
    signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}.`);
  const metadata = await response.json();
  signal.throwIfAborted();
  if (!metadata || !Array.isArray(metadata.layers)) throw new Error('Invalid index metadata.');
  const indexes = new Map<string, { values: Set<string>; layers: string[] }>();
  for (const layer of metadata.layers) {
    if (!layer || typeof layer.id !== 'string' || !Array.isArray(layer.indexes)) throw new Error('Invalid index metadata.');
    for (const index of layer.indexes) {
      if (!index || typeof index.attribute !== 'string' || !index.attribute || !Array.isArray(index.values)
        || !index.values.every((value: unknown) => typeof value === 'string')) throw new Error('Invalid index metadata.');
      const entry = indexes.get(index.attribute) ?? { values: new Set<string>(), layers: [] };
      for (const value of index.values) entry.values.add(value);
      if (!entry.layers.includes(layer.id)) entry.layers.push(layer.id);
      indexes.set(index.attribute, entry);
    }
  }
  return [...indexes].sort(([a], [b]) => a.localeCompare(b)).map(([attribute, index]) => ({
    attribute, values: [...index.values].sort((a, b) => a.localeCompare(b, 'nb')), layers: index.layers,
  }));
}

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

export function collectionUrl(base: string, bounds: Bounds, userId: number, zoom = 14): URL {
  const url = new URL('fgb/collection', normalizeApiUrl(base));
  url.searchParams.set('userId', String(userId));
  for (const [key, value] of Object.entries(bounds)) url.searchParams.set(key, String(value));
  url.searchParams.set('zoom', String(Math.floor(zoom)));
  return url;
}

export function filterUrl(base: string, value: string, attribute = 'brannvesen'): URL {
  const url = new URL('fgb/filter', normalizeApiUrl(base));
  url.searchParams.set('attribute', attribute);
  url.searchParams.set('value', value);
  return url;
}

export function authorizedAreaUrl(base: string, userId: number): URL {
  return new URL(`fgb/auth-polygon/${userId}`, normalizeApiUrl(base));
}

export async function fetchAuthorizedArea(base: string, userId: number, signal: AbortSignal): Promise<Feature<Polygon>> {
  signal.throwIfAborted();
  const response = await fetch(authorizedAreaUrl(base, userId), {
    signal, credentials: 'omit', headers: { Accept: 'application/geo+json' },
  });
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`Authorized area API returned HTTP ${response.status}.`);
  let feature: unknown;
  try {
    feature = await response.json();
  } catch {
    signal.throwIfAborted();
    throw new Error('The authorized area response is not valid JSON.');
  }
  signal.throwIfAborted();
  if (!isPolygonFeature(feature)) {
    throw new Error('The authorized area must be a GeoJSON Feature with a valid Polygon and finite coordinates.');
  }
  return feature;
}

function isPolygonFeature(value: unknown): value is Feature<Polygon> {
  if (!value || typeof value !== 'object') return false;
  const feature = value as Feature<Polygon>;
  if (feature.type !== 'Feature' || feature.geometry?.type !== 'Polygon'
    || !(feature.properties === null || (typeof feature.properties === 'object' && !Array.isArray(feature.properties)))) return false;
  const rings = feature.geometry.coordinates;
  return Array.isArray(rings) && rings.length > 0 && rings.every((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    if (!ring.every((position) => Array.isArray(position) && position.length >= 2
      && position.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)))) return false;
    const first = ring[0], last = ring[ring.length - 1];
    return first.length === last.length && first.every((coordinate, index) => coordinate === last[index]);
  });
}

export interface DecodeOptions {
  signal: AbortSignal;
  cache?: RequestCache;
  onBatch?: (features: Feature[]) => void;
  onHeader?: (header: HeaderMeta) => void;
  onLayer?: (layer: FgbLayer) => void;
  batchSize?: number;
  onTiming?: (timing: RequestTiming) => void;
  /** Yield to worker messages between bounded decoding batches. */
  yieldControl?: () => Promise<void>;
}

export interface RequestTiming {
  url: string;
  httpMs: number | null;
  downloadDecodeMs: number;
  totalMs: number;
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
  const { startTime, requestStart, responseEnd } = matches[0];
  // Cross-origin timing restrictions mask requestStart as zero, even when responseEnd is visible.
  return Number.isFinite(startTime) && Number.isFinite(requestStart) && Number.isFinite(responseEnd)
    && requestStart > 0 && requestStart >= startTime && responseEnd > requestStart
    && responseEnd <= finished ? responseEnd - requestStart : null;
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
      headers: { Accept: 'multipart/mixed, application/vnd.fgb' },
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

export type LodCutoffs = readonly [number, number, number];
/** Binary body and absolute timestamps are safe to transfer across performance contexts. */
export interface BinaryResponse {
  buffer: ArrayBuffer;
  contentType: string;
  lodCutoffs?: LodCutoffs;
  url: string;
  started: number;
  headersReceived: number;
  httpMs: number | null;
}
export interface DownloadOptions { signal: AbortSignal; cache?: RequestCache }

function parseLodCutoffs(header: string | null): LodCutoffs | undefined {
  const values = header?.split(',').map((value) => value.trim());
  if (values?.length !== 3 || !values.every((value) => /^-?\d+$/.test(value))) return;
  const [first, second, third] = values.map(Number);
  if ([first, second, third].every(Number.isSafeInteger) && first < second && second < third)
    return [first, second, third];
}

export async function fetchBinary(url: URL, options: DownloadOptions): Promise<BinaryResponse> {
  options.signal.throwIfAborted();
  const requestUrl = url.href;
  const active = activeTimings.get(requestUrl) ?? new Set<{ ambiguous: boolean }>();
  const attribution = { ambiguous: active.size > 0 };
  for (const other of active) other.ambiguous = true;
  active.add(attribution);
  activeTimings.set(requestUrl, active);
  try {
    const earlier = new Set(performance.getEntriesByName(requestUrl, 'resource'));
    const started = performance.now();
    const response = await fetch(url, { signal: options.signal, cache: options.cache,
      credentials: 'omit', headers: { Accept: 'multipart/mixed, application/vnd.fgb' } });
    const headersReceived = performance.now();
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}.`);
    const bytes = await readResponseBytes(response, options.signal);
    const finished = performance.now();
    options.signal.throwIfAborted();
    return { buffer: bytes.buffer, contentType: response.headers.get('content-type') ?? '',
      lodCutoffs: parseLodCutoffs(response.headers.get('x-flatserve-lod-cutoffs')), url: requestUrl,
      started: performance.timeOrigin + started, headersReceived: performance.timeOrigin + headersReceived,
      httpMs: attribution.ambiguous ? null : httpDuration(
        performance.getEntriesByName(requestUrl, 'resource'), requestUrl, started, finished, earlier),
    };
  } finally {
    active.delete(attribution);
    if (!active.size) activeTimings.delete(requestUrl);
  }
}
