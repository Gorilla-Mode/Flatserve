import type { Feature } from 'geojson';
import { collectionUrl, errorMessage, fetchFeatures, filterUrl } from './api';
import type { FgbLayer, HeaderMeta, RequestTiming } from './api';
import { containsBounds, expandBounds, WORLD } from './bounds';
import type { Bounds } from './bounds';

interface Observer {
  onFeatures: (features: Feature[]) => void;
  onStatus: (status: { loading: boolean; error: string | null }) => void;
  onHeader: (header: HeaderMeta) => void;
  /** Legacy value discovery for callers using the sample dataset. The web uses index metadata. */
  onValues?: (values: string[]) => void;
  onDiscovery: (status: { loading: boolean; error: string | null }) => void;
  onCoverage?: (bounds: Bounds[] | undefined) => void;
  onTiming?: (timing: RequestTiming) => void;
  onLayers?: (layers: FgbLayer[]) => void;
}

export function distinctBrannvesen(features: Feature[]): string[] {
  return [...new Set(features.map((f) => f.properties?.brannvesen)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b, 'nb'));
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
  private coverage?: Bounds[];
  private features: Feature[] = [];
  private failedTarget?: string;
  private pending?: Promise<void>;
  private status?: { loading: boolean; error: string | null };

  constructor(
    private readonly base: string,
    private readonly observer: Observer,
    private readonly read = fetchFeatures,
  ) {}

  async discover(): Promise<void> {
    if (this.disposed) return;
    this.discoveryRequest?.abort();
    const request = new AbortController();
    this.discoveryRequest = request;
    const current = () => !this.disposed && !request.signal.aborted;
    this.observer.onDiscovery({ loading: true, error: null });
    try {
      const layers: FgbLayer[] = [];
      const headers: HeaderMeta[] = [];
      const features = await this.read(collectionUrl(this.base, WORLD, 2), {
        signal: request.signal,
        onHeader: (header) => { headers.push(header); },
        onLayer: (layer) => { layers.push(layer); },
        onTiming: (timing) => { if (current()) this.observer.onTiming?.(timing); },
      });
      if (!current()) return;
      this.observer.onLayers?.(layers);
      const extents = headers.map((header) => header.envelope)
        .filter((extent) => extent?.length === 4 && Array.from(extent).every(Number.isFinite));
      if (headers.length) this.observer.onHeader({ ...headers[0], envelope: extents.length ? new Float64Array([
        Math.min(...extents.map((extent) => extent![0])), Math.min(...extents.map((extent) => extent![1])),
        Math.max(...extents.map((extent) => extent![2])), Math.max(...extents.map((extent) => extent![3])),
      ]) : null });
      this.observer.onValues?.(distinctBrannvesen(features));
      this.observer.onDiscovery({ loading: false, error: null });
    } catch (error) {
      if (current()) this.observer.onDiscovery({ loading: false, error: errorMessage(error) });
    }
  }

  setBounds(bounds: Bounds[]): Promise<void> {
    this.bounds = bounds;
    if (this.disposed || this.selection !== null) return Promise.resolve();
    return this.schedule();
  }

  setFilter(selection: string | null, bounds = this.bounds, bufferEnabled = this.bufferEnabled, attribute = 'brannvesen'): Promise<void> {
    return this.setTextFilter(selection ? { attribute, value: selection } : null, bounds, bufferEnabled);
  }

  setTextFilter(filter: { attribute: string; value: string } | null, bounds = this.bounds,
    bufferEnabled = this.bufferEnabled): Promise<void> {
    this.selection = filter?.value ?? null;
    this.attribute = filter?.attribute ?? '';
    this.bounds = bounds;
    this.bufferEnabled = bufferEnabled;
    return this.refresh();
  }

  setUser(userId: number | null): Promise<void> {
    if (this.disposed || this.userId === userId) return Promise.resolve();
    this.userId = userId;
    if (this.features.length) {
      this.features = [];
      this.observer.onFeatures([]);
    }
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
    this.observer.onCoverage?.(undefined);
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
    if (selection === null && this.coverage && containsBounds(this.coverage, this.bounds)) {
      this.notifyStatus({ loading: false, error: null });
      return Promise.resolve();
    }
    const requestBounds = this.bufferEnabled ? expandBounds(this.bounds) : this.bounds;
    const target = selection !== null ? JSON.stringify([this.attribute, selection]) : JSON.stringify(requestBounds);
    if ((selection === null && !requestBounds.length) || target === this.failedTarget) return Promise.resolve();
    const urls = selection !== null ? [filterUrl(this.base, selection, this.attribute)]
      : requestBounds.map((bounds) => collectionUrl(this.base, bounds, userId));
    const generation = this.generation;
    const request = new AbortController();
    this.viewRequest = request;
    this.pending = this.load(urls, requestBounds, target, selection, generation, request);
    return this.pending;
  }

  private async load(urls: URL[], requestBounds: Bounds[], target: string, selection: string | null,
    generation: number, request: AbortController): Promise<void> {
    const current = () => !this.disposed && generation === this.generation && !request.signal.aborted;
    this.notifyStatus({ loading: true, error: null });
    const features: Feature[] = [];
    try {
      for (const url of urls) {
        const part = await this.read(url, {
          signal: request.signal,
          cache: selection !== null ? 'no-store' : undefined,
          onTiming: (timing) => { if (current()) this.observer.onTiming?.(timing); },
        });
        if (!current()) return;
        features.push(...part);
      }
      if (selection === null) {
        this.coverage = requestBounds;
        this.observer.onCoverage?.(requestBounds);
      }
      this.features = features;
      this.failedTarget = undefined;
      this.observer.onFeatures(features);
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
    this.observer.onCoverage?.(undefined);
    this.discoveryRequest?.abort();
  }
}
