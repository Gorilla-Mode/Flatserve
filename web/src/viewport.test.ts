import { afterEach, expect, it, vi } from 'vitest';
import type { Feature, Geometry } from 'geojson';
import { viewportBounds } from './bounds';
import { SpatialIndex } from './spatialIndex';
import type { ViewQuery } from './spatialIndex';
import { SnapshotWorker } from './snapshotWorker';
import type { WorkerRequest, WorkerResponse } from './snapshotWorker';
import { ViewportStatistics } from './viewport';
import type { StatisticsWorker } from './viewport';
import { station } from '../tests/fixtures';

const bounds = viewportBounds(0, 50, 10, 60);
afterEach(() => vi.useRealTimers());
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const publish = vi.fn(), onError = vi.fn();
  const engine = new SnapshotWorker();
  const messages: WorkerRequest[] = [];
  const queue: WorkerRequest[] = [];
  const worker: StatisticsWorker = { onmessage: null, postMessage: vi.fn((message) => {
    messages.push(message); queue.push(message);
  }), terminate: vi.fn() };
  const renderer = { apply: vi.fn().mockResolvedValue(undefined), hide: vi.fn() };
  const client = new ViewportStatistics(1, publish, worker, onError);
  client.setRenderer(renderer);
  client.setView(bounds, false, false);
  const drain = async (beforeResponse?: (response: WorkerResponse) => void) => {
    await tick();
    for (let iteration = 0; queue.length && iteration < 100; iteration++) {
      const response = engine.receive(queue.shift()!);
      if (response) beforeResponse?.(response);
      if (response) worker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
      await tick();
    }
    expect(queue.length).toBe(0);
  };
  return { client, renderer, worker, publish, messages, queue, drain, onError };
}

it('prepares completed responses in the worker and commits only after renderer completion', async () => {
  const h = harness(); await h.drain();
  const upload = deferred(); h.renderer.apply.mockReturnValueOnce(upload.promise);
  h.client.setData([station('a'), station('outside', 50)]);
  await h.drain();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.messages.some((m) => m.type === 'commit')).toBe(false);
  upload.resolve(); await h.drain();
  expect(h.publish.mock.lastCall![0]).toMatchObject({ counts: { dataset: 1 }, batch: { version: 1 } });
  h.client.dispose();
});

it('coalesces slow replacements to the latest response and diffs against acknowledged data', async () => {
  const h = harness(); await h.drain();
  h.client.setData([station('a')]); await h.drain();
  const upload = deferred(); h.renderer.apply.mockReturnValueOnce(upload.promise);
  h.client.setData([station('a'), station('b')]); await h.drain();
  h.client.setData([station('discarded')]);
  h.client.setData([station('b'), station('c')]);
  expect(h.messages.filter((m) => m.type === 'data')).toHaveLength(2);
  upload.resolve(); await h.drain();
  expect(h.messages.filter((m) => m.type === 'data')).toHaveLength(3);
  const batch = h.renderer.apply.mock.lastCall![0];
  expect(batch.delta.baseVersion).toBe(2);
  expect(batch.delta.diffs.get('dataset')).toMatchObject({ remove: [0], add: [{ properties: { brannvesen: 'c' } }] });
  expect(h.publish.mock.lastCall![0].batch.version).toBe(4);
  h.client.dispose();
});

it('keeps committed counts and BBox updates live during upload and commits the latest camera membership', async () => {
  vi.useFakeTimers();
  const h = harness(); await h.drain();
  h.client.setView(bounds, true, false, true);
  h.client.setData([station('a', 4), station('b', 15)]); await h.drain();
  const upload = deferred(); h.renderer.apply.mockReturnValueOnce(upload.promise);
  h.client.setData([station('a', 4), station('b', 15), station('new', 16)]); await h.drain();
  h.client.setView(viewportBounds(10, 50, 20, 60), true, false, true); await h.drain();
  expect(h.publish.mock.lastCall![0]).toMatchObject({ batch: { version: 1 }, counts: { dataset: 1 }, membership: { dataset: [1] } });
  upload.resolve(); await h.drain();
  expect(h.publish.mock.lastCall![0]).toMatchObject({ batch: { version: 2 }, counts: { dataset: 2 }, membership: { dataset: [1, 2] } });
  h.client.dispose();
});

it('throttles camera queries, coalesces movement, and flushes final movement', async () => {
  vi.useFakeTimers();
  const h = harness(); h.client.setData([station('a')]); await h.drain();
  h.messages.length = 0;
  for (let i = 0; i < 10; i++) h.client.setView(viewportBounds(i, 50, i + 10, 60), false, false);
  expect(h.messages).toHaveLength(0);
  vi.advanceTimersByTime(100); await h.drain();
  expect(h.messages.filter((m) => m.type === 'bounds')).toHaveLength(1);
  h.client.setView(bounds, false, false, true); await h.drain();
  expect(h.messages.filter((m) => m.type === 'bounds')).toHaveLength(2);
  h.client.dispose();
});

it('rejects failed updates without advancing applied state, and prepares the next response from the applied version', async () => {
  const h = harness(); h.client.setData([station('a')]); await h.drain();
  h.renderer.apply.mockRejectedValueOnce(new Error('upload failed'));
  h.client.setData([station('bad')]); await h.drain();
  expect(h.onError).toHaveBeenCalledOnce();
  expect(h.publish.mock.lastCall![0].batch.version).toBe(1);
  h.client.setData([station('a')]); await h.drain();
  expect(h.renderer.apply.mock.lastCall![0].delta.baseVersion).toBe(1);
  expect(h.renderer.apply.mock.lastCall![0].delta.diffs.size).toBe(0);
  h.client.dispose();
});

it('hides immediately on authorization changes, clears after in-flight uploads, and then applies the latest authorized response', async () => {
  const h = harness(); h.client.setData([station('a')]); await h.drain();
  const upload = deferred(); h.renderer.apply.mockReturnValueOnce(upload.promise);
  h.client.setData([station('old user')]); await h.drain();
  h.client.invalidate();
  expect(h.renderer.hide).toHaveBeenCalledOnce();
  h.client.setData([station('new user')]); await h.drain();
  h.publish.mockClear();
  upload.resolve(); await h.drain();
  const committed = h.publish.mock.calls.map(([state]) => [...state.batch.groups.values()].flat().map((f: Feature) => f.properties?.brannvesen));
  expect(committed).not.toContainEqual(['old user']);
  expect(committed).toContainEqual([]);
  expect(committed.at(-1)).toEqual(['new user']);
  const uploads = h.renderer.apply.mock.calls.map(([batch]) => [...batch.groups.values()].flat());
  expect(uploads.at(-2)).toEqual([]);
  const versions = h.messages.filter((message) => message.type === 'commit').map((message) => message.version);
  expect(versions).toEqual([...versions].sort((a, b) => a - b));
  h.client.dispose();
});

it('successful empty responses remove existing features and late/foreign completions are ignored after disposal', async () => {
  const h = harness(); h.client.setData([station('a')]); await h.drain();
  h.client.setData([]); await h.drain();
  expect(h.publish.mock.lastCall![0]).toMatchObject({ counts: {}, batch: { groups: new Map() } });
  const receive = h.worker.onmessage!;
  h.client.dispose(); h.publish.mockClear();
  receive(new MessageEvent<WorkerResponse>('message', { data: { connection: 1, version: 1, sequence: 1, counts: { dataset: 123 }, membership: null } }));
  h.client.setData([station('late')]);
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.worker.terminate).toHaveBeenCalledOnce();
});

it('commits snapshots during continuous camera movement instead of waiting for zoom to stop', async () => {
  const h = harness();
  h.client.setView(bounds, true, false, true);
  h.client.setData([station('a')]); await h.drain();
  let movements = 0;
  h.client.setData([station('a'), station('b')]);
  await h.drain((response) => {
    if (!('type' in response) && response.version === 2 && h.publish.mock.lastCall![0].batch.version === 1) {
      movements++;
      h.client.setView(viewportBounds(movements / 10, 50, 10 + movements / 10, 60), true, false, true);
    }
  });
  expect(movements).toBeGreaterThan(1);
  expect(h.publish.mock.lastCall![0].batch.version).toBe(2);
  h.client.dispose();
});

it('keeps BBox membership order stable for reordered identical responses', async () => {
  const h = harness();
  h.client.setView(bounds, true, false, true);
  h.client.setData([station('a'), station('b')]); await h.drain();
  const membership = h.publish.mock.lastCall![0].membership;
  h.client.setData([station('b'), station('a')]); await h.drain();
  expect(h.publish.mock.lastCall![0].membership).toEqual(membership);
  expect(h.renderer.apply.mock.lastCall![0].delta.diffs.size).toBe(0);
  h.client.dispose();
});

it('keeps failed authorization clears hidden without retry loops and retries on the next complete response', async () => {
  const h = harness(); h.client.setData([station('old')]); await h.drain();
  h.renderer.apply.mockRejectedValueOnce(new Error('clear rejected'));
  h.client.invalidate(); await h.drain();
  expect(h.onError).toHaveBeenCalledOnce();
  expect(h.publish.mock.lastCall![0].counts).toEqual({});
  h.client.setData([station('authorized')]); await h.drain();
  expect(h.publish.mock.lastCall![0].counts).toEqual({ dataset: 1 });
  expect(h.publish.mock.lastCall![0].batch.groups.get('dataset')[0].properties.brannvesen).toBe('authorized');
  h.client.dispose();
});

it('uses envelopes only as a rejection step, preserving exact holes, crossings, multipart, collections and wrapped points', () => {
  const ring = (min: number, max: number) => [[min, min], [max, min], [max, max], [min, max], [min, min]];
  const features: Feature<Geometry | null>[] = [
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(-20, 20), ring(-1, 11)] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-5, 5], [15, 5]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[ring(30, 40)], [ring(2, 3)]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: [50, 50] }, { type: 'MultiPoint', coordinates: [[5, 5], [100, 10]] },
    ] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [535, 5] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [180, 5] } },
    { type: 'Feature', properties: {}, geometry: null },
  ];
  const index = new SpatialIndex(features.map((feature, id) => ({ id, dataset: id < 2 ? 'first' : 'second', geometry: feature.geometry })));
  const query: ViewQuery = { type: 'bounds', connection: 1, version: 1, sequence: 1, bounds: viewportBounds(0, 0, 10, 10), bbox: true, text: false };
  expect(index.query(query)).toMatchObject({ counts: { first: 1, second: 2 }, membership: { first: [1], second: [2, 3] } });
  expect(index.query({ ...query, bounds: viewportBounds(170, 0, 190, 10) }).membership).toEqual({ second: [4, 5] });
  expect(index.query({ ...query, bounds: viewportBounds(-180, 0, -170, 10) }).membership).toEqual({ second: [5] });
  expect(index.query({ ...query, bounds: [], text: true, bbox: false })).toMatchObject({ counts: { first: 2, second: 5 }, membership: null });
});
