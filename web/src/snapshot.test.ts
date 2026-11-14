import { expect, it } from 'vitest';
import type { Feature } from 'geojson';
import { emptySnapshot, materialize, SnapshotDiffer } from './snapshot';
import { station } from '../tests/fixtures';

const identified = (id: string, x = 8, extra = {}): Feature => ({ ...station(id, x), properties: { gml_id: id, ...extra } });
function harness() {
  const differ = new SnapshotDiffer();
  let applied = emptySnapshot();
  let version = 0;
  return {
    prepare: (features: Feature[]) => differ.prepare(features, ++version, applied),
    apply: (features: Feature[]) => {
      const result = differ.prepare(features, ++version, applied);
      applied = result.snapshot;
      return result;
    },
  };
}

it('retains objects and IDs for identical and reordered completed snapshots, ignoring runtime styling', () => {
  const h = harness();
  const first = h.apply([identified('a'), identified('b')]);
  const next = h.apply([identified('b'), identified('a', 8, { __flatserveColor: 'ignored' })]);
  expect(next.delta.diffs.size).toBe(0);
  expect(next.snapshot.batch.groups.get('dataset')).toEqual([...first.snapshot.batch.groups.get('dataset')!].reverse());
  expect(next.snapshot.entries.get(0)!.feature).toBe(first.snapshot.entries.get(0)!.feature);
  expect(next.delta.records.size).toBe(0);
});

it('diffs overlapping snapshots and removes absent records, including successful empty responses', () => {
  const h = harness();
  h.apply([identified('a'), identified('b')]);
  const next = h.apply([identified('b'), identified('c')]);
  expect(next.delta.diffs.get('dataset')).toMatchObject({ remove: [0], add: [{ id: 2 }], update: [] });
  expect(h.apply([]).delta.diffs.get('dataset')).toEqual({ add: [], update: [], remove: [1, 2] });
  expect(h.apply([]).delta.diffs.size).toBe(0);
});

it('updates geometry and changed properties, explicitly deleting removed properties', () => {
  const h = harness();
  h.apply([identified('a', 8, { removed: 1, changed: 1 })]);
  const next = h.apply([identified('a', 9, { changed: 2 })]);
  expect(next.delta.diffs.get('dataset')).toEqual({ add: [], remove: [], update: [{ id: 0,
    newGeometry: { type: 'Point', coordinates: [9, 58.15] }, removeProperties: ['removed'],
    addOrUpdateProperties: [{ key: 'changed', value: 2 }],
  }] });
});

it('separates repeated gml IDs by dataset, geometry type and vertex role', () => {
  const h = harness();
  const point = identified('shared');
  const polygon: Feature = { ...point, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } };
  const vertex = identified('shared', 8, { __geoflatpack_vertices: true });
  const other = { ...point, fgbLayerId: 'other' };
  h.apply([point, polygon, vertex, other]);
  const next = h.apply([{ ...point, geometry: { type: 'Point', coordinates: [9, 58] } }, polygon, vertex, other]);
  expect(next.delta.diffs.size).toBe(1);
  expect(next.delta.diffs.get('dataset')!.update).toHaveLength(1);
  expect([...next.snapshot.entries.keys()]).toEqual([0, 1, 2, 3]);
});

it.each([false, true])('uses verified canonical content and duplicate occurrence ordinals for ambiguous/missing IDs (%s)', (ambiguous) => {
  const h = harness();
  const a = ambiguous ? identified('duplicate') : station('a');
  const b = ambiguous ? identified('duplicate', 10) : station('b');
  h.apply([a, b, a]);
  const next = h.apply([b, a, a]);
  expect(next.delta.diffs.size).toBe(0);
  expect([...next.snapshot.entries.keys()]).toEqual([1, 0, 2]);
  expect(h.apply([a]).delta.diffs.get('dataset')!.remove).toEqual([1, 2]);
});

it('does not confuse ambiguous records with unique identified records or property key ordering', () => {
  const h = harness();
  h.apply([{ ...identified('a'), properties: { gml_id: 'a', nested: { b: 2, a: 1 } } }]);
  expect(h.apply([{ ...identified('a'), properties: { nested: { a: 1, b: 2 }, gml_id: 'a' } }]).delta.diffs.size).toBe(0);
});

it('compares uncommitted/rejected candidates against the last applied snapshot', () => {
  const h = harness();
  h.apply([identified('a')]);
  h.prepare([identified('b')]);
  const next = h.prepare([identified('a'), identified('c')]);
  expect(next.delta.baseVersion).toBe(1);
  expect(next.delta.diffs.get('dataset')).toMatchObject({ remove: [], update: [], add: [{ properties: { gml_id: 'c' } }] });
});

it('retains UI objects and worker geometry/envelopes for property-only updates', () => {
  const h = harness();
  const first = h.apply([identified('a'), identified('b')]);
  const next = h.apply([identified('a'), identified('b', 8, { value: 1 })]);
  expect(next.snapshot.entries.get(1)!.feature.geometry).toBe(first.snapshot.entries.get(1)!.feature.geometry);
  const batch = materialize(next.delta, first.snapshot.batch);
  expect(batch.groups.get('dataset')![0]).toBe(first.snapshot.batch.groups.get('dataset')![0]);
  expect(batch.groups.get('dataset')![1]).not.toBe(first.snapshot.batch.groups.get('dataset')![1]);
});
