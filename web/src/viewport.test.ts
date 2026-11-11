import { afterEach, expect, it, vi } from 'vitest';
import type { Feature, Geometry } from 'geojson';
import { viewportBounds } from './bounds';
import { prepareBatch } from './dataset';
import { SpatialIndex } from './spatialIndex';
import type { DataMessage, ViewQuery, ViewResult } from './spatialIndex';
import { ViewportStatistics } from './viewport';
import type { StatisticsWorker } from './viewport';
import { station } from '../tests/fixtures';

const bounds = viewportBounds(0, 50, 10, 60);
afterEach(() => vi.useRealTimers());

function harness(connection = 1) {
  const publish = vi.fn();
  const messages: (DataMessage | ViewQuery)[] = [];
  const worker: StatisticsWorker = {
    onmessage: null, postMessage: vi.fn((message) => messages.push(message)), terminate: vi.fn(),
  };
  const client = new ViewportStatistics(connection, publish, worker);
  const queries = () => messages.filter((message): message is ViewQuery => message.type === 'bounds');
  const respond = (query = queries().at(-1)!, overrides: Partial<ViewResult> = {}) => {
    const data = messages.find((message): message is DataMessage => message.type === 'data' && message.version === query.version)!;
    const result = new SpatialIndex(data.features).query(query);
    worker.onmessage?.({ data: { ...result, ...overrides } } as MessageEvent<ViewResult>);
  };
  client.setView(bounds, false, false);
  return { client, worker, publish, messages, queries, respond };
}

it('assigns unique numeric batch IDs without changing properties, geometries or dataset identity', () => {
  const features = [{ ...station('a'), id: 'original', fgbLayerId: 'first' }, { ...station('b'), id: 'original', fgbLayerId: 'second' }];
  const batch = prepareBatch(features, 7);
  expect(batch.version).toBe(7);
  expect(batch.groups.get('first')![0]).toMatchObject({ id: 0, fgbLayerId: 'first', properties: { brannvesen: 'a' } });
  expect(batch.groups.get('second')![0].id).toBe(1);
  expect(batch.groups.get('first')![0].geometry).toBe(features[0].geometry);
  expect(features[0].id).toBe('original');
});

it('sends geometry once per data version, throttles movement, coalesces pending bounds and flushes moveend', () => {
  vi.useFakeTimers();
  const { client, publish, messages, queries, respond } = harness();
  client.setData([station('a', 8), station('b', 12)]);
  respond();
  expect(publish.mock.lastCall![0].counts).toEqual({ dataset: 1 });
  for (let i = 0; i < 10; i++) client.setView(viewportBounds(i / 10, 50, 10 + i / 10, 60), false, false);
  expect(queries()).toHaveLength(1);
  vi.advanceTimersByTime(100);
  expect(queries()).toHaveLength(2);
  expect(queries()[1].bounds).toEqual(viewportBounds(.9, 50, 10.9, 60));
  respond();
  client.setView(viewportBounds(2, 50, 12, 60), false, false, true);
  expect(queries()).toHaveLength(3);
  respond();
  expect(publish.mock.lastCall![0].counts).toEqual({ dataset: 2 });
  expect(messages.filter((message) => message.type === 'data')).toHaveLength(1);
  client.dispose();
});

it('keeps only the latest pending camera during a slow calculation and rejects duplicate or foreign results', () => {
  vi.useFakeTimers();
  const { client, publish, queries, respond } = harness();
  client.setData([station('a')]);
  const old = queries()[0];
  client.setView(viewportBounds(20, 50, 30, 60), false, false);
  client.setView(viewportBounds(40, 50, 50, 60), false, false, true);
  respond(old, { connection: 2 });
  expect(publish).not.toHaveBeenCalled();
  expect(queries()).toHaveLength(1);
  respond(old);
  expect(queries()).toHaveLength(2);
  expect(queries()[1].bounds).toEqual(viewportBounds(40, 50, 50, 60));
  publish.mockClear();
  respond(old);
  expect(publish).not.toHaveBeenCalled();
  respond();
  expect(publish.mock.lastCall![0].counts).toEqual({ dataset: 0 });
  client.dispose();
});

it('prepares BBox membership before publishing replacement batches and ignores obsolete versions', () => {
  const { client, publish, queries, respond } = harness();
  client.setData([station('old')]);
  respond();
  client.setView(bounds, true, false);
  expect(publish.mock.lastCall![0].membership).toEqual({});
  const old = queries().at(-1)!;
  client.setData([station('new', 4), station('outside', 50)]);
  publish.mockClear();
  respond(old);
  expect(publish).not.toHaveBeenCalled();
  respond();
  expect(publish.mock.lastCall![0]).toMatchObject({ batch: { version: 2 }, counts: { dataset: 1 }, membership: { dataset: [1] } });
  client.dispose();
});

it('invalidates results across rapid mode changes, counts all text matches and clears on user changes', () => {
  const { client, publish, queries, respond } = harness();
  client.setData([station('a'), station('outside', 50)]);
  const stale = queries()[0];
  client.setView(bounds, true, false);
  client.setView(bounds, false, false);
  publish.mockClear();
  respond(stale);
  expect(publish).not.toHaveBeenCalled();
  respond();
  client.setView(bounds, false, true);
  respond();
  expect(publish.mock.lastCall![0].counts).toEqual({ dataset: 2 });
  client.setData([]);
  expect(publish.mock.lastCall![0]).toMatchObject({ counts: {}, batch: { groups: new Map() } });
  client.dispose();
});

it('terminates workers and scheduled work on disposal, including callbacks already queued for an old connection', () => {
  vi.useFakeTimers();
  const { client, worker, publish, queries, respond } = harness();
  client.setData([station('a')]);
  respond();
  client.setView(bounds, false, false);
  const receive = worker.onmessage!;
  client.dispose();
  publish.mockClear();
  vi.advanceTimersByTime(1000);
  client.setData([station('late')]);
  client.setView(bounds, false, false, true);
  receive(new MessageEvent<ViewResult>('message', { data: { connection: 1, version: 1, sequence: 1, counts: { dataset: 123 }, membership: null } }));
  expect(publish).not.toHaveBeenCalled();
  expect(queries()).toHaveLength(1);
  expect(worker.terminate).toHaveBeenCalledOnce();
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
