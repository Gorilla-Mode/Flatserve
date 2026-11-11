import type { Feature } from 'geojson';
import type { Bounds } from './bounds';
import { prepareBatch } from './dataset';
import type { DataBatch } from './dataset';
import type { DataMessage, ViewQuery, ViewResult } from './spatialIndex';

export interface ViewState {
  batch: DataBatch;
  counts: Record<string, number>;
  membership: Record<string, number[]> | null;
}
export interface StatisticsWorker {
  onmessage: ((event: MessageEvent<ViewResult>) => void) | null;
  postMessage(message: DataMessage | ViewQuery): void;
  terminate(): void;
}

/** One worker per connection, one calculation in flight, and only the latest pending bounds. */
export class ViewportStatistics {
  private batch = prepareBatch([], 0);
  private state: ViewState = { batch: this.batch, counts: {}, membership: null };
  private bounds: Bounds[] = [];
  private bbox = false;
  private text = false;
  private nextFeatureId = 0;
  private sequence = 0;
  private minimumSequence = 0;
  private inFlight?: ViewQuery;
  private pending = false;
  private immediate = false;
  private lastSent = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly connection: number, private readonly publish: (state: ViewState) => void,
    private readonly worker: StatisticsWorker = new Worker(new URL('./viewport.worker.ts', import.meta.url), { type: 'module' })) {
    worker.onmessage = ({ data }) => this.receive(data);
  }

  setData(features: Feature[]): void {
    if (this.disposed) return;
    // Disjoint IDs also keep the old source hidden while MapLibre asynchronously installs a replacement.
    this.batch = prepareBatch(features, this.batch.version + 1, this.nextFeatureId);
    this.nextFeatureId += features.length;
    this.worker.postMessage({ type: 'data', connection: this.connection, version: this.batch.version,
      features: [...this.batch.groups].flatMap(([dataset, group]) => group.map((feature) => ({
        id: feature.id as number, dataset, geometry: feature.geometry,
      }))),
    });
    if (!features.length) {
      this.state = { batch: this.batch, counts: {}, membership: this.bbox ? {} : null };
      this.publish(this.state);
    }
    this.request(true);
  }

  setView(bounds: Bounds[], bbox: boolean, text: boolean, final = false): void {
    if (this.disposed) return;
    const changedMode = bbox !== this.bbox || text !== this.text;
    this.bounds = bounds;
    this.bbox = bbox;
    this.text = text;
    if (changedMode) {
      this.minimumSequence = this.sequence + 1;
      // An old viewport result must never briefly expose features outside a newly enabled BBox.
      this.state = { ...this.state, membership: bbox ? {} : null };
      this.publish(this.state);
    }
    this.request(final || changedMode);
  }

  private request(immediate: boolean): void {
    this.pending = true;
    this.immediate ||= immediate;
    this.flush();
  }

  private flush(): void {
    if (this.disposed || this.inFlight || !this.pending || !this.batch.version) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const delay = this.immediate ? 0 : Math.max(0, 100 - (performance.now() - this.lastSent));
    if (delay > 0) { this.timer = setTimeout(() => this.flush(), delay); return; }
    this.pending = false;
    this.immediate = false;
    this.lastSent = performance.now();
    this.inFlight = { type: 'bounds', connection: this.connection, version: this.batch.version,
      sequence: ++this.sequence, bounds: this.bounds, bbox: this.bbox, text: this.text };
    this.worker.postMessage(this.inFlight);
  }

  private receive(result: ViewResult): void {
    const request = this.inFlight;
    if (this.disposed || !request || result.connection !== this.connection || result.sequence !== request.sequence
      || result.version !== request.version) return;
    this.inFlight = undefined;
    if (result.sequence >= this.minimumSequence && result.version === this.batch.version && request.bbox === this.bbox && request.text === this.text) {
      this.state = { batch: this.batch, counts: result.counts, membership: result.membership };
      this.publish(this.state);
    }
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.worker.onmessage = null;
    this.worker.terminate();
  }
}
