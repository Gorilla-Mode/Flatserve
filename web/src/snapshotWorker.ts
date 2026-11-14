import type { Feature } from 'geojson';
import type { ViewQuery, ViewResult } from './spatialIndex';
import { SpatialIndex } from './spatialIndex';
import { emptySnapshot, SnapshotDiffer } from './snapshot';
import type { Snapshot, SnapshotDelta } from './snapshot';

export type WorkerRequest =
  | { type: 'data'; connection: number; version: number; features: Feature[]; view: ViewQuery }
  | { type: 'commit' | 'discard'; connection: number; version: number }
  | ViewQuery;
export type WorkerResponse =
  | { type: 'prepared'; delta: SnapshotDelta; view: ViewResult }
  | { type: 'error'; connection: number; version: number; error: string }
  | ViewResult;

/** Kept independent of self so tests exercise the real worker protocol. */
export class SnapshotWorker {
  private connection?: number;
  private applied = emptySnapshot();
  private index = new SpatialIndex([]);
  private candidate?: { snapshot: Snapshot; index: SpatialIndex };
  private differ = new SnapshotDiffer();
  receive(message: WorkerRequest): WorkerResponse | undefined {
    if (this.connection !== undefined && this.connection !== message.connection) return;
    this.connection = message.connection;
    if (message.type === 'data') {
      try {
        const { snapshot, delta } = this.differ.prepare(message.features, message.version, this.applied, message.connection);
        const features = [...snapshot.batch.groups].flatMap(([dataset, group]) => group.map((feature) => ({
          id: feature.id as number, dataset, geometry: feature.geometry,
        })));
        const index = new SpatialIndex(features, this.index);
        this.candidate = { snapshot, index };
        return { type: 'prepared', delta, view: index.query(message.view) };
      } catch (error) {
        return { type: 'error', connection: message.connection, version: message.version, error: String(error) };
      }
    }
    if (message.type === 'commit' || message.type === 'discard') {
      if (this.candidate?.snapshot.batch.version !== message.version) return;
      if (message.type === 'commit') { this.applied = this.candidate.snapshot; this.index = this.candidate.index; }
      this.candidate = undefined;
      return;
    }
    if (message.type !== 'bounds') return;
    if (message.version === this.applied.batch.version) return this.index.query(message);
    if (message.version === this.candidate?.snapshot.batch.version) return this.candidate.index.query(message);
  }
}
