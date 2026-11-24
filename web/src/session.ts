import { collectionUrl, errorMessage, fetchBinary, filterUrl } from './api';
import type { FgbLayer, HeaderMeta, RequestTiming } from './api';
import { containsBounds, containsPrefetchBounds, directionalBuffers, WORLD } from './bounds';
import type { Bounds } from './bounds';
import type { DatasetDecoder } from './snapshotWorker';

interface Observer {
  /** Ownership of this worker handle passes to the viewport. */
  onDataset: (handle: number, lodLevels: number[]) => void;
  onInvalidate: () => void;
  onStatus: (status: { loading: boolean; error: string | null }) => void;
  onHeader: (header: HeaderMeta) => void;
  /** Legacy value discovery for callers using the sample dataset. The web uses index metadata. */
  onValues?: (values: string[]) => void;
  onDiscovery: (status: { loading: boolean; error: string | null }) => void;
  onCoverage?: (bounds: Bounds[] | undefined) => void;
  onPrefetchCoverage?: (bounds: Bounds[] | undefined) => void;
  onTiming?: (timing: RequestTiming) => void;
  onLayers?: (layers: FgbLayer[]) => void;
}

// Match the collection API's zoom cutoffs for coverage reuse.
function zoomBand(zoom: number): number {
  if (zoom < 6) return 0;
  if (zoom < 10) return 1;
  return zoom < 14 ? 2 : 3;
}

/** One connection's coverage and request lifetimes; no stale request may publish data. */
export class DatasetSession {
  private viewRequest?: AbortController;
  private discoveryRequest?: AbortController;
  private generation = 0;
  private disposed = false;
  private userId: number | null = null;
  private selection: string | null = null;
  private attribute = 'brannvesen';
  private bufferEnabled = true;
  private bounds: Bounds[] = [];
  private zoom = 14;
  private coverage?: Bounds[];
  private prefetchCoverage?: Bounds[];
  private queryAnchor?: Bounds[];
  private failedTarget?: string;
  private pending?: Promise<void>;
  private status?: { loading: boolean; error: string | null };

  constructor(
    private readonly base: string,
    private readonly observer: Observer,
    private readonly decoder: DatasetDecoder,
    private readonly read = fetchBinary,
  ) {}

  async discover(zoom = 14): Promise<void> {
    if (this.disposed) return;
    this.discoveryRequest?.abort();
    const request = new AbortController();
    this.discoveryRequest = request;
    const current = () => !this.disposed && !request.signal.aborted;
    this.observer.onDiscovery({ loading: true, error: null });
    try {
      const response = await this.read(collectionUrl(this.base, WORLD, 2, zoom), { signal: request.signal });
      if (!current()) return;
      const dataset = await this.decoder.decode([response], request.signal, true);
      try {
        if (!current()) return;
        for (const timing of dataset.timings) this.observer.onTiming?.(timing);
        const layers = dataset.layers;
        const headers = layers.map((layer) => layer.header);
        this.observer.onLayers?.(layers);
        const extents = headers.map((header) => header.envelope)
          .filter((extent) => extent?.length === 4 && Array.from(extent).every(Number.isFinite));
        if (headers.length) this.observer.onHeader({ ...headers[0], envelope: extents.length ? new Float64Array([
          Math.min(...extents.map((extent) => extent![0])), Math.min(...extents.map((extent) => extent![1])),
          Math.max(...extents.map((extent) => extent![2])), Math.max(...extents.map((extent) => extent![3])),
        ]) : null });
        this.observer.onValues?.(dataset.values ?? []);
        this.observer.onDiscovery({ loading: false, error: null });
      } finally { this.decoder.release(dataset.handle); }
    } catch (error) {
      if (current()) this.observer.onDiscovery({ loading: false, error: errorMessage(error) });
    }
  }

  setBounds(bounds: Bounds[], zoom = this.zoom): Promise<void> {
    const changedBand = zoomBand(this.zoom) !== zoomBand(zoom);
    this.bounds = bounds;
    this.zoom = zoom;
    if (this.disposed || this.selection !== null) return Promise.resolve();
    return changedBand ? this.refresh() : this.schedule();
  }

  setFilter(selection: string | null, bounds = this.bounds, bufferEnabled = this.bufferEnabled, attribute = 'brannvesen'): Promise<void> {
    return this.setTextFilter(selection ? { attribute, value: selection } : null, bounds, bufferEnabled);
  }

  setTextFilter(filter: { attribute: string; value: string } | null, bounds = this.bounds,
    bufferEnabled = this.bufferEnabled, zoom = this.zoom): Promise<void> {
    this.selection = filter?.value ?? null;
    this.attribute = filter?.attribute ?? '';
    this.bounds = bounds;
    this.bufferEnabled = bufferEnabled;
    this.zoom = zoom;
    return this.refresh();
  }

  setUser(userId: number | null): Promise<void> {
    if (this.disposed || this.userId === userId) return Promise.resolve();
    this.userId = userId;
    this.observer.onInvalidate();
    return this.refresh();
  }

  private cancelView(): void {
    this.generation++;
    this.viewRequest?.abort();
    this.viewRequest = undefined;
    this.pending = undefined;
  }

  refresh(): Promise<void> {
    this.cancelView();
    this.coverage = undefined;
    this.prefetchCoverage = undefined;
    this.queryAnchor = undefined;
    this.observer.onCoverage?.(undefined);
    this.observer.onPrefetchCoverage?.(undefined);
    this.failedTarget = undefined;
    if (this.disposed) return Promise.resolve();
    return this.schedule();
  }

  private notifyStatus(status: { loading: boolean; error: string | null }): void {
    if (this.status?.loading === status.loading && this.status.error === status.error) return;
    this.status = status;
    this.observer.onStatus(status);
  }

  private schedule(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const userId = this.userId;
    if (userId === null) {
      this.notifyStatus({ loading: false, error: null });
      return Promise.resolve();
    }
    // Movement only updates the desired bounds while one logical request is active.
    if (this.viewRequest) return this.pending!;
    const selection = this.selection;
    const covered = this.bufferEnabled
      ? this.prefetchCoverage && containsPrefetchBounds(this.prefetchCoverage, this.bounds)
      : this.coverage && containsBounds(this.coverage, this.bounds);
    if (selection === null && covered) {
      this.notifyStatus({ loading: false, error: null });
      return Promise.resolve();
    }
    const queryBounds = this.bounds;
    const buffers = this.bufferEnabled ? directionalBuffers(queryBounds, this.queryAnchor) : undefined;
    const requestBounds = buffers?.fetched ?? queryBounds;
    const prefetchBounds = buffers?.prefetch;
    const target = selection !== null ? JSON.stringify([this.attribute, selection]) : JSON.stringify(requestBounds);
    if ((selection === null && !requestBounds.length) || target === this.failedTarget) return Promise.resolve();
    const urls = selection !== null ? [filterUrl(this.base, selection, this.attribute)]
      : requestBounds.map((bounds) => collectionUrl(this.base, bounds, userId, this.zoom));
    const generation = this.generation;
    const request = new AbortController();
    this.viewRequest = request;
    this.pending = this.load(urls, queryBounds, requestBounds, prefetchBounds, target, selection, generation, request);
    return this.pending;
  }

  private async load(urls: URL[], queryBounds: Bounds[], requestBounds: Bounds[], prefetchBounds: Bounds[] | undefined,
    target: string, selection: string | null,
    generation: number, request: AbortController): Promise<void> {
    const current = () => !this.disposed && generation === this.generation && !request.signal.aborted;
    this.notifyStatus({ loading: true, error: null });
    const responses = [];
    try {
      for (const url of urls) {
        const response = await this.read(url, {
          signal: request.signal,
          cache: selection !== null ? 'no-store' : undefined,
        });
        if (!current()) return;
        responses.push(response);
      }
      const dataset = await this.decoder.decode(responses, request.signal);
      if (!current()) { this.decoder.release(dataset.handle); return; }
      for (const timing of dataset.timings) this.observer.onTiming?.(timing);
      if (selection === null) {
        this.coverage = requestBounds;
        this.prefetchCoverage = prefetchBounds;
        this.queryAnchor = queryBounds;
        this.observer.onCoverage?.(requestBounds);
        this.observer.onPrefetchCoverage?.(prefetchBounds);
      }
      this.failedTarget = undefined;
      const lodLevels = [...new Set(dataset.layers.flatMap(({ lod }) => lod === undefined ? [] : [lod]))]
        .sort((a, b) => a - b);
      this.observer.onDataset(dataset.handle, lodLevels);
      this.notifyStatus({ loading: false, error: null });
    } catch (error) {
      if (!current()) return;
      this.failedTarget = target;
      this.notifyStatus({ loading: false, error: errorMessage(error) });
    }
    if (current()) {
      this.viewRequest = undefined;
      this.pending = undefined;
      // A slow response may cover an old camera position. Catch up immediately.
      if (selection === null) await this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelView();
    this.coverage = undefined;
    this.prefetchCoverage = undefined;
    this.queryAnchor = undefined;
    this.observer.onCoverage?.(undefined);
    this.observer.onPrefetchCoverage?.(undefined);
    this.discoveryRequest?.abort();
  }
}
