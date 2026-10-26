import type { RequestTiming } from './api';

export interface TimingRecord extends RequestTiming { id: number }

/** Called on completion, so concurrent requests retain their completion order. */
export function timingHistory(records: TimingRecord[], timing: RequestTiming | null): TimingRecord[] {
  if (!timing) return [];
  return [...records.slice(-9), { ...timing, id: (records.at(-1)?.id ?? 0) + 1 }];
}
