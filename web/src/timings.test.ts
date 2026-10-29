import { expect, it } from 'vitest';
import { timingHistory } from './timings';
import type { TimingRecord } from './timings';

it('retains the ten latest completions with stable IDs and resets for a new connection', () => {
  let records: TimingRecord[] = [];
  const snapshots: TimingRecord[] = [];
  for (let i = 0; i < 15; i++) {
    records = timingHistory(records, { url: `https://example.org/${i}`, httpMs: 10, downloadDecodeMs: 20, totalMs: 30 });
    snapshots.push(records.at(-1)!);
  }
  expect(records.map((record) => record.id)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  expect(records).toEqual(snapshots.slice(-10));
  expect(snapshots[0]).toEqual({ id: 1, url: 'https://example.org/0', httpMs: 10, downloadDecodeMs: 20, totalMs: 30 });
  expect(timingHistory(records, null)).toEqual([]);
});

it('retains unavailable HTTP calls and identical successful completions', () => {
  const timing = { url: 'https://example.org/empty', httpMs: null, downloadDecodeMs: 20, totalMs: 30 };
  const records = timingHistory(timingHistory([], timing), timing);
  expect(records).toEqual([{ ...timing, id: 1 }, { ...timing, id: 2 }]);
});
