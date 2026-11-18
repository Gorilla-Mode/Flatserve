import { afterEach, expect, it, vi } from 'vitest';
import type { Feature } from 'geojson';
import { fetchBinary } from './api';
import type { BinaryResponse } from './api';
import { directionalBuffers, viewportBounds, WORLD } from './bounds';
import { DatasetSession } from './session';
import { SnapshotWorker } from './snapshotWorker';
import type { WorkerRequest, WorkerResponse } from './snapshotWorker';
import { ViewportStatistics } from './viewport';
import type { StatisticsWorker } from './viewport';
import { encoded, headerOnly, multipartEncoded, station } from '../tests/fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const binary = (bytes = encoded(), contentType = 'application/vnd.fgb'): BinaryResponse => ({
  buffer: bytes.slice().buffer, contentType, url: 'https://example.org/fgb/collection',
  started: performance.timeOrigin + performance.now() - 20,
  headersReceived: performance.timeOrigin + performance.now() - 10, httpMs: 5,
});
const query = (version: number) => ({ type: 'bounds' as const, connection: 1, version, sequence: version,
  bounds: [WORLD], bbox: false, text: true });
const decode = (request: number, responses = [binary()], discovery = false): WorkerRequest => ({
  type: 'decode', connection: 1, request, responses, discovery,
});
const prepare = (handle: number, version = 1): WorkerRequest => ({ type: 'data', connection: 1, handle, version, view: query(version) });
function harness() {
  const engine = new SnapshotWorker(async () => {});
  const messages: WorkerRequest[] = [], detached: ArrayBuffer[] = [];
  const errors: unknown[] = [];
  const worker: StatisticsWorker = { onmessage: null, terminate: vi.fn(), postMessage(message, transfer = []) {
    // Use real structured-clone transfer semantics, including detached original buffers.
    const copy = structuredClone(message, { transfer });
    if (message.type === 'decode') detached.push(...message.responses.map((response) => response.buffer));
    messages.push(copy);
    Promise.resolve(engine.receive(copy)).then((response) => {
      if (response) worker.onmessage?.({ data: structuredClone(response) } as unknown as MessageEvent<WorkerResponse>);
    }).catch((error) => errors.push(error));
  } };
  const publish = vi.fn(), onError = vi.fn();
  const viewport = new ViewportStatistics(1, publish, worker, onError);
  viewport.setView([WORLD], false, true, true);
  const renderer = { apply: vi.fn().mockResolvedValue(undefined), hide: vi.fn() };
  return { engine, worker, viewport, publish, renderer, messages, detached, errors, onError };
}

it('decodes single files and empty multipart layers, returning only handles and metadata', async () => {
  const engine = new SnapshotWorker(async () => {});
  const first = await engine.receive(decode(1));
  expect(first).toMatchObject({ type: 'decoded', request: 1, dataset: { handle: 1, layers: [{ id: 'dataset' }] } });
  expect(first).not.toHaveProperty('dataset.features');
  const result = await engine.receive(prepare(1));
  expect(result).toMatchObject({ type: 'prepared', view: { counts: { dataset: 3 } } });
  await engine.receive({ type: 'commit', connection: 1, version: 1 });
  const bytes = multipartEncoded([{ id: 'empty', bytes: headerOnly(encoded()) }]);
  expect(await engine.receive(decode(2, [binary(bytes, 'multipart/mixed; boundary=fgb-test')]))).toMatchObject({
    type: 'decoded', dataset: { layers: [{ id: 'empty' }] },
  });
  expect(await engine.receive(prepare(2, 2))).toMatchObject({ type: 'prepared', view: { counts: {} } });
});

it.each(['invalid file', 'truncated multipart', 'invalid part'])('rejects %s without advancing the acknowledged snapshot', async (failure) => {
  const engine = new SnapshotWorker(async () => {});
  await engine.receive(decode(1)); await engine.receive(prepare(1));
  await engine.receive({ type: 'commit', connection: 1, version: 1 });
  let response = binary(new TextEncoder().encode('broken'));
  if (failure !== 'invalid file') {
    let bytes = multipartEncoded([{ id: 'one', bytes: failure === 'invalid part' ? new TextEncoder().encode('broken') : encoded() }]);
    if (failure === 'truncated multipart') bytes = bytes.slice(0, -12);
    response = binary(bytes, 'multipart/mixed; boundary=fgb-test');
  }
  expect(await engine.receive(decode(2, [response]))).toMatchObject({ type: 'decode-error', request: 2 });
  await engine.receive(decode(3));
  expect(await engine.receive(prepare(3, 2))).toMatchObject({ type: 'prepared', delta: { baseVersion: 1, diffs: new Map() } });
});

it('processes cancellation and camera messages between decoding batches', async () => {
  let resume!: () => void;
  const yielded = vi.fn(() => new Promise<void>((resolve) => { resume = resolve; }));
  const engine = new SnapshotWorker(yielded);
  const pending = engine.receive(decode(1, [binary(encoded(Array.from({ length: 2000 }, (_, i) => station(String(i)))))]));
  await vi.waitFor(() => expect(yielded).toHaveBeenCalled());
  expect(await engine.receive(query(0))).toMatchObject({ counts: {} });
  engine.receive({ type: 'cancel', connection: 1, request: 1 });
  resume();
  expect(await pending).toMatchObject({ type: 'decode-error', request: 1 });
  expect(await engine.receive(prepare(1))).toMatchObject({ type: 'error' });
});

it('rejects stale request and connection IDs and consumes or releases handles exactly once', async () => {
  const engine = new SnapshotWorker(async () => {});
  await engine.receive(decode(2));
  expect(await engine.receive(decode(1))).toMatchObject({ type: 'decode-error' });
  expect(await engine.receive({ ...decode(3), connection: 2 })).toBeUndefined();
  engine.receive({ type: 'release', connection: 2, handle: 2 });
  expect(await engine.receive(prepare(2))).toMatchObject({ type: 'prepared' });
  engine.receive({ type: 'discard', connection: 1, version: 1 });
  expect(await engine.receive(prepare(2, 2))).toMatchObject({ type: 'error' });
  await engine.receive(decode(4));
  engine.receive({ type: 'release', connection: 1, handle: 4 });
  expect(await engine.receive(prepare(4, 3))).toMatchObject({ type: 'error' });
});

it('transfers binary buffers before renderer readiness and releases superseded, stale and disposed results', async () => {
  const h = harness();
  const first = await h.viewport.decode([binary()], new AbortController().signal);
  h.viewport.setData(first.handle);
  const second = await h.viewport.decode([binary()], new AbortController().signal);
  h.viewport.setData(second.handle);
  expect(h.messages).toContainEqual({ type: 'release', connection: 1, handle: first.handle });
  expect(h.detached.every((buffer) => buffer.byteLength === 0)).toBe(true);
  expect(h.messages.some((message) => message.type === 'data')).toBe(false);
  h.viewport.setRenderer(h.renderer);
  await vi.waitFor(() => expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ counts: { dataset: 3 } })));
  for (const message of h.messages) expect(message).not.toHaveProperty('features');
  // A completion already queued at cancellation still needs release on arrival.
  h.worker.onmessage?.({ data: { type: 'decoded', connection: 1, request: 999,
    dataset: { handle: 999, layers: [], timings: [], decodeMs: 0 } } } as unknown as MessageEvent<WorkerResponse>);
  expect(h.messages).toContainEqual({ type: 'release', connection: 1, handle: 999 });
  const third = await h.viewport.decode([binary()], new AbortController().signal);
  h.viewport.setRenderer(undefined);
  h.viewport.setData(third.handle);
  h.viewport.dispose();
  expect(h.messages).toContainEqual({ type: 'release', connection: 1, handle: third.handle });
  expect(h.worker.terminate).toHaveBeenCalledOnce();
  expect(h.errors).toEqual([]);
});

it('aborts pending decodes, rejects disposed work, and ignores foreign completions', async () => {
  const worker: StatisticsWorker = { onmessage: null, postMessage: vi.fn(), terminate: vi.fn() };
  const viewport = new ViewportStatistics(1, vi.fn(), worker);
  const controller = new AbortController();
  const pending = viewport.decode([binary()], controller.signal);
  worker.onmessage?.({ data: { type: 'decode-error', connection: 2, request: 1, error: 'foreign' } } as unknown as MessageEvent<WorkerResponse>);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejected;
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel', connection: 1, request: 1 });
  const disposed = viewport.decode([binary()], new AbortController().signal);
  const disposedAssertion = expect(disposed).rejects.toMatchObject({ name: 'AbortError' });
  viewport.dispose(); await disposedAssertion;
  await expect(viewport.decode([binary()], new AbortController().signal)).rejects.toThrow('disposed');
});

it('shares the worker between discovery and view decoding, emits timing before preparation and releases discovery features', async () => {
  const h = harness();
  const onTiming = vi.fn(), onLayers = vi.fn(), onValues = vi.fn();
  const session = new DatasetSession('https://example.org', {
    onDataset: (handle) => h.viewport.setData(handle), onInvalidate: () => h.viewport.invalidate(),
    onStatus: vi.fn(), onHeader: vi.fn(), onDiscovery: vi.fn(), onLayers, onValues,
    onTiming: (timing) => { expect(h.messages.some((message) => message.type === 'data')).toBe(false); onTiming(timing); },
  }, h.viewport, async () => binary());
  const discovery = session.discover();
  await session.setBounds([WORLD]);
  await session.setUser(2);
  await discovery;
  expect(onTiming).toHaveBeenCalledTimes(2);
  expect(onLayers).toHaveBeenCalledWith([expect.objectContaining({ id: 'dataset' })]);
  expect(onValues).toHaveBeenCalledWith(['Kristiansand – Sør', 'Oslo']);
  const discoveryMessage = h.messages.find((message) => message.type === 'decode' && message.discovery)!;
  if (discoveryMessage.type !== 'decode') throw new Error('Missing discovery');
  expect(h.messages).toContainEqual({ type: 'release', connection: 1, handle: discoveryMessage.request });
  h.viewport.setRenderer(h.renderer);
  await vi.waitFor(() => expect(h.publish.mock.lastCall?.[0].counts).toEqual({ dataset: 3 }));
  session.dispose(); h.viewport.dispose();
});

it('retains both boundaries throughout slow decoding and fetches the latest viewport on completion', async () => {
  const h = harness();
  const onCoverage = vi.fn(), onPrefetchCoverage = vi.fn();
  const read = vi.fn(async () => binary());
  const session = new DatasetSession('https://example.org', {
    onDataset: (handle) => h.viewport.setData(handle), onInvalidate: () => h.viewport.invalidate(),
    onStatus: vi.fn(), onHeader: vi.fn(), onDiscovery: vi.fn(), onCoverage, onPrefetchCoverage,
  }, h.viewport, read);
  const area = (west = 0) => viewportBounds(west, 50, west + 10, 60);
  await session.setBounds(area());
  await session.setUser(2);
  onCoverage.mockClear(); onPrefetchCoverage.mockClear();
  let resume!: () => void;
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const originalDecode = h.viewport.decode.bind(h.viewport);
  let decoding = false;
  vi.spyOn(h.viewport, 'decode').mockImplementationOnce(async (...args) => {
    const decoded = await originalDecode(...args);
    decoding = true;
    await held;
    return decoded;
  });
  const pending = session.setBounds(area(2));
  await vi.waitFor(() => expect(decoding).toBe(true));
  session.setBounds(area(3));
  session.setBounds(area(5));
  expect(read).toHaveBeenCalledTimes(2);
  expect(onCoverage).not.toHaveBeenCalled();
  expect(onPrefetchCoverage).not.toHaveBeenCalled();
  resume();
  await pending;
  expect(read).toHaveBeenCalledTimes(3);
  expect(onCoverage.mock.calls).toEqual([[viewportBounds(0, 47, 16, 63)], [viewportBounds(3, 47, 19, 63)]]);
  expect(onPrefetchCoverage.mock.calls).toEqual([[viewportBounds(1, 48, 15, 62)], [viewportBounds(4, 48, 18, 62)]]);
  session.dispose(); h.viewport.dispose();
});

it('retains both boundaries and data if a split response fails to decode, then replaces them together on success', async () => {
  const h = harness();
  const onCoverage = vi.fn(), onPrefetchCoverage = vi.fn(), onDataset = vi.fn((handle: number) => h.viewport.setData(handle));
  const read = vi.fn(async () => binary(read.mock.calls.length === 3 ? new TextEncoder().encode('broken') : encoded()));
  const session = new DatasetSession('https://example.org', {
    onDataset, onInvalidate: () => h.viewport.invalidate(), onStatus: vi.fn(), onHeader: vi.fn(),
    onDiscovery: vi.fn(), onCoverage, onPrefetchCoverage,
  }, h.viewport, read);
  const initial = viewportBounds(0, 50, 10, 60);
  const crossing = viewportBounds(170, 50, 190, 60);
  await session.setBounds(initial);
  await session.setUser(2);
  onCoverage.mockClear(); onPrefetchCoverage.mockClear();
  await session.setBounds(crossing);
  expect(read).toHaveBeenCalledTimes(3);
  expect(onCoverage).not.toHaveBeenCalled();
  expect(onPrefetchCoverage).not.toHaveBeenCalled();
  expect(onDataset).toHaveBeenCalledOnce();
  await session.setBounds(crossing);
  expect(read).toHaveBeenCalledTimes(3);
  const latest = viewportBounds(171, 60, 191, 70);
  await session.setBounds(latest);
  expect(read).toHaveBeenCalledTimes(5);
  expect(onDataset).toHaveBeenCalledTimes(2);
  expect(onCoverage.mock.calls).toEqual([[directionalBuffers(latest, initial).fetched]]);
  expect(onPrefetchCoverage.mock.calls).toEqual([[directionalBuffers(latest, initial).prefetch]]);
  session.dispose(); h.viewport.dispose();
});

it('publishes 250,000 ordered, tagged features across multipart layers and split session downloads', async () => {
  const h = harness();
  const count = 250_000;
  const layer = (id: string, start: number, length: number) => ({ id,
    bytes: encoded(Array.from({ length }, (_, i): Feature => ({ ...station(String(start + i)), properties: { ordinal: start + i } }))),
  });
  // A single layer exceeds common JS argument limits; both aggregation paths must use loops.
  const bodies = [multipartEncoded([layer('first', 0, 150_000), layer('middle', 150_000, 1)]),
    multipartEncoded([layer('second', 150_001, 99_999)])];
  let reads = 0;
  const onStatus = vi.fn(), onDataset = vi.fn((handle: number) => h.viewport.setData(handle));
  const session = new DatasetSession('https://example.org', {
    onDataset, onInvalidate: () => h.viewport.invalidate(), onStatus, onHeader: vi.fn(), onDiscovery: vi.fn(),
  }, h.viewport, async () => binary(bodies[reads++], 'multipart/mixed; boundary=fgb-test'));
  await session.setBounds(viewportBounds(170, 50, 190, 60));
  await session.setUser(2);
  expect(reads).toBe(2); expect(onDataset).toHaveBeenCalledOnce();
  expect(h.messages.some((message) => message.type === 'data')).toBe(false);
  h.viewport.setRenderer(h.renderer);
  await vi.waitFor(() => expect(h.publish.mock.lastCall?.[0].counts).toEqual({ first: 150_000, middle: 1, second: 99_999 }), { timeout: 20_000 });
  const groups = h.publish.mock.lastCall![0].batch.groups;
  expect([...groups.values()].reduce((sum, features) => sum + features.length, 0)).toBe(count);
  expect(groups.get('first').every((feature: Feature, i: number) => feature.properties?.ordinal === i)).toBe(true);
  expect(groups.get('second').every((feature: Feature, i: number) => feature.properties?.ordinal === 150_001 + i)).toBe(true);
  expect(groups.get('second')[0]).toHaveProperty('fgbLayerId', 'second');
  expect(onStatus.mock.lastCall?.[0]).toEqual({ loading: false, error: null });
  expect(h.detached.every((buffer) => buffer.byteLength === 0)).toBe(true);
  expect(h.errors).toEqual([]);
  session.dispose(); h.viewport.dispose();
}, 60_000);

it('keeps HTTP fetching on the main thread and cancels an aborted binary reader', async () => {
  const controller = new AbortController(), cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([1, 2])); }, cancel,
  }))));
  const pending = fetchBinary(new URL('https://example.org'), { signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  controller.abort(); await assertion;
  expect(cancel).toHaveBeenCalledOnce();
});

it('normalizes decode completion across time origins and freezes timings before snapshot preparation', async () => {
  vi.stubGlobal('performance', { timeOrigin: 10_000, now: () => 100 });
  const response = { ...binary(), started: 10_050, headersReceived: 10_060 };
  const engine = new SnapshotWorker(async () => {});
  const decoded = await engine.receive(decode(1, [response]));
  expect(decoded).toMatchObject({ type: 'decoded', dataset: { timings: [{ httpMs: 5, totalMs: 50, downloadDecodeMs: 40 }] } });
  vi.stubGlobal('performance', { timeOrigin: 10_000, now: () => 900 });
  await engine.receive(prepare(1));
  expect(decoded).toMatchObject({ dataset: { timings: [{ totalMs: 50, downloadDecodeMs: 40 }] } });
});

it('drops a superseded decode at its next yield while allowing the newer request to finish', async () => {
  let resume!: () => void;
  let firstYield = true;
  const engine = new SnapshotWorker(() => {
    if (!firstYield) return Promise.resolve();
    firstYield = false;
    return new Promise<void>((resolve) => { resume = resolve; });
  });
  const old = engine.receive(decode(1));
  await vi.waitFor(() => expect(resume).toBeDefined());
  expect(await engine.receive(decode(2))).toMatchObject({ type: 'decoded', request: 2 });
  resume();
  expect(await old).toMatchObject({ type: 'decode-error', request: 1 });
  expect(await engine.receive(prepare(1))).toMatchObject({ type: 'error' });
  expect(await engine.receive(prepare(2, 2))).toMatchObject({ type: 'prepared' });
});
