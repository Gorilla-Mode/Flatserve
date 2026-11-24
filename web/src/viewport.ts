import type { BinaryResponse } from './api';
import type { DecodedDataset } from './snapshotWorker';
import type { Bounds } from './bounds';
import type { DataBatch } from './dataset';
import { materialize } from './snapshot';
import type { SnapshotDelta } from './snapshot';
import type { ViewQuery, ViewResult } from './spatialIndex';
import type { WorkerRequest, WorkerResponse } from './snapshotWorker';

export interface ViewState {
  batch: DataBatch;
  counts: Record<string, number>;
  membership: Record<string, number[]> | null;
  lodLevels: number[];
}
export interface StatisticsWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface SnapshotRenderer {
  apply(batch: DataBatch): Promise<void>;
  hide(): void;
}

/** One transaction in flight; complete replacements coalesce against the acknowledged snapshot. */
export class ViewportStatistics {
  private batch: DataBatch = { version: 0, groups: new Map() };
  private state: ViewState = { batch: this.batch, counts: {}, membership: null, lodLevels: [] };
  private bounds: Bounds[] = [];
  private bbox = false;
  private text = false;
  private version = 0;
  private epoch = 0;
  private cameraRevision = 0;
  private commitQuery?: { sequence: number; revision: number };
  private sequence = 0;
  private minimumSequence = 0;
  private inFlight?: ViewQuery;
  private pending = false;
  private immediate = false;
  private lastSent = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private desired?: { handle: number; version: number; epoch: number; lodLevels: number[] };
  private transaction?: { version: number; epoch: number; lodLevels: number[]; delta?: SnapshotDelta; batch?: DataBatch; uploaded?: boolean; refreshedCamera?: boolean };
  private renderer?: SnapshotRenderer;
  private blocked = false;
  private clearing = false;
  private nextRequest = 0;
  private decodes = new Map<number, { resolve: (dataset: DecodedDataset) => void; reject: (error: unknown) => void; cleanup: () => void }>();

  constructor(private readonly connection: number, private readonly publish: (state: ViewState) => void,
    private readonly worker: StatisticsWorker = new Worker(new URL('./viewport.worker.ts', import.meta.url), { type: 'module' }),
    private readonly onError: (error: unknown) => void = () => {}) {
    worker.onmessage = ({ data }) => this.receive(data);
  }

  setRenderer(renderer: SnapshotRenderer | undefined): void {
    this.renderer = renderer;
    if (this.transaction) {
      this.transaction.uploaded = false;
      this.commitQuery = undefined;
    }
    if (renderer) {
      // Hydrate newly created sources from the acknowledged snapshot before accepting diffs.
      this.blocked = true;
      const hydration = renderer.apply(this.batch);
      if (this.clearing) renderer.hide();
      void hydration.then(() => {
        if (this.disposed || this.renderer !== renderer) return;
        this.blocked = false;
        if (this.transaction?.batch && this.transaction.epoch !== this.epoch) {
          this.worker.postMessage({ type: 'discard', connection: this.connection, version: this.transaction.version });
          this.transaction = undefined;
        }
        if (this.transaction?.batch) this.upload(this.transaction);
        else this.start();
      }).catch((error) => {
        if (!this.disposed && this.renderer === renderer) this.onError(error);
      });
    }
  }

  async decode(responses: BinaryResponse[], signal: AbortSignal, discovery = false): Promise<DecodedDataset> {
    signal.throwIfAborted();
    if (this.disposed) return Promise.reject(new Error('Connection disposed.'));
    const request = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({ type: 'cancel', connection: this.connection, request });
        this.decodes.delete(request);
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener('abort', abort);
      this.decodes.set(request, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.worker.postMessage({ type: 'decode', connection: this.connection, request, responses, discovery },
          responses.map((response) => response.buffer));
      } catch (error) { this.decodes.delete(request); cleanup(); reject(error); }
    });
  }

  release(handle: number): void {
    if (!this.disposed) this.worker.postMessage({ type: 'release', connection: this.connection, handle });
  }

  setData(handle: number, lodLevels: number[] = []): void {
    if (this.disposed) return;
    if (this.desired) this.release(this.desired.handle);
    this.desired = { handle, version: ++this.version, epoch: this.epoch, lodLevels };
    this.start();
  }

  /** Authorization changes hide synchronously, then serialize an empty snapshot before new data. */
  invalidate(): void {
    if (this.disposed) return;
    this.epoch++;
    this.renderer?.hide();
    this.clearing = true;
    if (this.desired) this.release(this.desired.handle);
    this.desired = undefined;
    this.state = { ...this.state, counts: {}, membership: this.bbox ? {} : null, lodLevels: [] };
    this.publish(this.state);
    this.start();
  }

  private query(version: number): ViewQuery {
    return { type: 'bounds', connection: this.connection, version, sequence: ++this.sequence,
      bounds: this.bounds, bbox: this.bbox, text: this.text };
  }
  private start(): void {
    if (this.disposed || this.blocked || !this.renderer || this.transaction) return;
    const desired = this.clearing ? { handle: null, version: ++this.version, epoch: this.epoch, lodLevels: [] } : this.desired;
    if (!desired) return;
    if (desired.version <= this.batch.version) desired.version = ++this.version;
    if (!this.clearing) this.desired = undefined;
    this.transaction = { version: desired.version, epoch: desired.epoch, lodLevels: desired.lodLevels };
    this.worker.postMessage({ type: 'data', connection: this.connection, version: desired.version,
      handle: desired.handle, view: this.query(desired.version) });
  }

  setView(bounds: Bounds[], bbox: boolean, text: boolean, final = false): void {
    if (this.disposed) return;
    const changedMode = bbox !== this.bbox || text !== this.text;
    this.cameraRevision++;
    this.bounds = bounds; this.bbox = bbox; this.text = text;
    if (changedMode) {
      this.minimumSequence = this.sequence + 1;
      this.state = { ...this.state, membership: bbox ? {} : null };
      this.publish(this.state);
    }
    this.request(final || changedMode);
  }
  private request(immediate: boolean): void {
    this.pending = true; this.immediate ||= immediate; this.flush();
  }
  private flush(): void {
    if (this.disposed || this.inFlight || !this.pending || !this.batch.version) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const delay = this.immediate ? 0 : Math.max(0, 100 - (performance.now() - this.lastSent));
    if (delay > 0) { this.timer = setTimeout(() => this.flush(), delay); return; }
    this.pending = false; this.immediate = false; this.lastSent = performance.now();
    this.inFlight = this.query(this.batch.version);
    this.worker.postMessage(this.inFlight);
  }

  private queryCommit(version: number): void {
    const query = this.query(version);
    this.commitQuery = { sequence: query.sequence, revision: this.cameraRevision };
    this.worker.postMessage(query);
  }

  /** Recreated sources hydrate the acknowledged snapshot, then resume the same candidate. */
  private upload(transaction: NonNullable<ViewportStatistics['transaction']>): void {
    const renderer = this.renderer;
    if (!renderer || this.blocked || !transaction.batch) return;
    transaction.uploaded = false;
    this.commitQuery = undefined;
    void renderer.apply(transaction.batch).then(() => {
      if (this.disposed || this.transaction !== transaction || this.renderer !== renderer) return;
      transaction.uploaded = true;
      this.queryCommit(transaction.version);
    }).catch((error) => {
      if (this.disposed || this.transaction !== transaction || this.renderer !== renderer) return;
      this.worker.postMessage({ type: 'discard', connection: this.connection, version: transaction.version });
      this.transaction = undefined;
      this.onError(error);
      // Retry a failed authorization clear only on a new response or renderer.
      if (!this.clearing) this.start();
    });
  }

  private receive(result: WorkerResponse): void {
    if (this.disposed) return;
    if ('type' in result && (result.type === 'decoded' || result.type === 'decode-error')) {
      if (result.connection !== this.connection) return;
      const pending = this.decodes.get(result.request);
      if (!pending) {
        if (result.type === 'decoded') this.release(result.dataset.handle);
        return;
      }
      this.decodes.delete(result.request); pending.cleanup();
      if (result.type === 'decoded') pending.resolve(result.dataset);
      else pending.reject(new Error(result.error));
      return;
    }
    if ('type' in result && result.type === 'prepared') {
      const { delta } = result;
      const transaction = this.transaction;
      if (!transaction || delta.connection !== this.connection || delta.version !== transaction.version) return;
      if (transaction.epoch !== this.epoch || delta.baseVersion !== this.batch.version) {
        this.worker.postMessage({ type: 'discard', connection: this.connection, version: delta.version });
        this.transaction = undefined; this.start(); return;
      }
      transaction.delta = delta;
      transaction.batch = materialize(delta, this.batch);
      this.upload(transaction);
      return;
    }
    if ('type' in result && result.type === 'error') {
      if (result.connection !== this.connection || result.version !== this.transaction?.version) return;
      this.transaction = undefined; this.onError(new Error(result.error)); this.start(); return;
    }
    if ('type' in result) return;
    if (result.connection !== this.connection) return;
    const transaction = this.transaction;
    if (transaction?.uploaded && result.version === transaction.version) {
      // Re-query if the mode or camera changed since upload completion. No stale BBox can commit.
      if (result.sequence !== this.commitQuery?.sequence) return;
      if (result.sequence < this.minimumSequence || (!transaction.refreshedCamera && this.commitQuery.revision !== this.cameraRevision)) {
        // Refresh movement once, then commit the newest available result and let the normal
        // live query catch up. Requiring an idle camera here would starve uploads during zoom.
        transaction.refreshedCamera = true;
        this.queryCommit(transaction.version);
        return;
      }
      this.worker.postMessage({ type: 'commit', connection: this.connection, version: transaction.version });
      this.batch = transaction.batch!;
      this.transaction = undefined;
      if (transaction.epoch === this.epoch) {
        this.clearing = false;
        this.state = { batch: this.batch, counts: result.counts, membership: result.membership, lodLevels: transaction.lodLevels };
        this.publish(this.state);
      }
      this.inFlight = undefined;
      this.start(); this.request(true);
      return;
    }
    const request = this.inFlight;
    if (!request || result.sequence !== request.sequence || result.version !== request.version) return;
    this.inFlight = undefined;
    if (!this.clearing && result.sequence >= this.minimumSequence && result.version === this.batch.version
      && request.bbox === this.bbox && request.text === this.text) {
      this.state = { ...this.state, batch: this.batch, counts: result.counts, membership: result.membership };
      this.publish(this.state);
    }
    this.flush();
  }

  dispose(): void {
    this.renderer?.hide();
    if (this.desired) this.release(this.desired.handle);
    for (const [request, pending] of this.decodes) {
      this.worker.postMessage({ type: 'cancel', connection: this.connection, request });
      pending.cleanup(); pending.reject(new DOMException('Connection disposed.', 'AbortError'));
    }
    this.decodes.clear();
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.worker.onmessage = null;
    this.worker.terminate();
  }
}
