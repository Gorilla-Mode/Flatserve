import type { Feature } from 'geojson';
import { collectionUrl, errorMessage, fetchFeatures, filterUrl } from './api';
import type { HeaderMeta } from './api';
import { containsBounds, containsPoint, expandBounds, WORLD } from './bounds';
import type { Bounds } from './bounds';

interface Observer {
  onFeatures: (features: Feature[]) => void;
  onStatus: (status: { loading: boolean; error: string | null }) => void;
  onHeader: (header: HeaderMeta) => void;
  onValues: (values: string[]) => void;
  onDiscovery: (status: { loading: boolean; error: string | null }) => void;
}

export function distinctBrannvesen(features: Feature[]): string[] {
  return [...new Set(features.map((f) => f.properties?.brannvesen)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b, 'nb'));
}

/** One connection's cache and request lifetimes; no stale request may publish data. */
export class DatasetSession {
  private readonly cache = new Map<string, Feature[]>();
  private viewRequest?: AbortController;
  private discoveryRequest?: AbortController;
  private generation = 0;
  private disposed = false;
  private selection = '';
  private bounds: Bounds[] = [];
  private coverage?: Bounds[];
  private features: Feature[] = [];
  private displayed = '[]';
  private failedTarget?: string;
  private pending?: Promise<void>;

  constructor(
    private readonly base: string,
    private readonly observer: Observer,
    private readonly read = fetchFeatures,
  ) {}

  async discover(): Promise<void> {
    this.discoveryRequest?.abort();
    const request = new AbortController();
    this.discoveryRequest = request;
    const current = () => !this.disposed && !request.signal.aborted;
    this.observer.onDiscovery({ loading: true, error: null });
    try {
      const features = await this.read(collectionUrl(this.base, WORLD), {
        signal: request.signal,
        onHeader: (header) => { if (current()) this.observer.onHeader(header); },
      });
      if (!current()) return;
      this.observer.onValues(distinctBrannvesen(features));
      this.observer.onDiscovery({ loading: false, error: null });
    } catch (error) {
      if (current()) this.observer.onDiscovery({ loading: false, error: errorMessage(error) });
    }
  }

  setBounds(bounds: Bounds[]): Promise<void> {
    this.bounds = bounds;
    if (this.disposed || this.selection !== '') return Promise.resolve();
    this.publish();
    return this.schedule();
  }

  setFilter(selection: string, bounds = this.bounds): Promise<void> {
    this.selection = selection;
    this.bounds = bounds;
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
    this.failedTarget = undefined;
    if (this.disposed) return Promise.resolve();
    if (!this.selection) this.publish();
    return this.schedule();
  }

  /** Publish only a changed visible subset; movement never changes filter matches. */
  private publish(): void {
    const visible = this.selection ? this.features : this.features.filter((feature) =>
      feature.geometry?.type === 'Point' && containsPoint(this.bounds, feature.geometry.coordinates));
    const signature = JSON.stringify(visible);
    if (signature === this.displayed) return;
    this.displayed = signature;
    this.observer.onFeatures(visible);
  }

  private schedule(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // Movement only updates the desired bounds while one logical request is active.
    if (this.viewRequest) return this.pending!;
    const selection = this.selection;
    const cached = selection ? this.cache.get(selection) : undefined;
    if (cached) {
      this.features = cached;
      this.publish();
      this.observer.onStatus({ loading: false, error: null });
      return Promise.resolve();
    }
    if (!selection && this.coverage && containsBounds(this.coverage, this.bounds)) {
      this.observer.onStatus({ loading: false, error: null });
      return Promise.resolve();
    }
    const buffer = expandBounds(this.bounds);
    const target = selection || JSON.stringify(buffer);
    if ((!selection && !buffer.length) || target === this.failedTarget) return Promise.resolve();
    const urls = selection ? [filterUrl(this.base, selection)]
      : buffer.map((bounds) => collectionUrl(this.base, bounds));
    const generation = this.generation;
    const request = new AbortController();
    this.viewRequest = request;
    this.pending = this.load(urls, buffer, target, selection, generation, request);
    return this.pending;
  }

  private async load(urls: URL[], buffer: Bounds[], target: string, selection: string,
    generation: number, request: AbortController): Promise<void> {
    const current = () => !this.disposed && generation === this.generation && !request.signal.aborted;
    this.observer.onStatus({ loading: true, error: null });
    const features: Feature[] = [];
    try {
      for (const url of urls) {
        const part = await this.read(url, { signal: request.signal });
        if (!current()) return;
        features.push(...part);
      }
      if (selection) this.cache.set(selection, features);
      else this.coverage = buffer;
      this.features = features;
      this.failedTarget = undefined;
      this.publish();
      this.observer.onStatus({ loading: false, error: null });
    } catch (error) {
      if (!current()) return;
      this.failedTarget = target;
      this.observer.onStatus({ loading: false, error: errorMessage(error) });
    }
    if (current()) {
      this.viewRequest = undefined;
      this.pending = undefined;
      // A slow response may cover an old camera position. Catch up immediately.
      if (!selection) await this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelView();
    this.discoveryRequest?.abort();
    this.cache.clear();
  }
}
