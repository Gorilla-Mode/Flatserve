import type { Feature } from 'geojson';
import { collectionUrl, errorMessage, fetchFeatures, filterUrl } from './api';
import type { HeaderMeta } from './api';
import { WORLD } from './bounds';
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
    return this.selection === '' ? this.refresh() : Promise.resolve();
  }

  setFilter(selection: string, bounds = this.bounds): Promise<void> {
    this.selection = selection;
    this.bounds = bounds;
    return this.refresh();
  }

  cancelViewport(): void {
    if (this.selection === '') this.cancelView();
  }

  private cancelView(): void {
    this.generation++;
    this.viewRequest?.abort();
  }

  async refresh(): Promise<void> {
    this.cancelView();
    if (this.disposed) return;
    const generation = this.generation;
    const request = new AbortController();
    this.viewRequest = request;
    const current = () => !this.disposed && generation === this.generation && !request.signal.aborted;
    const selection = this.selection;
    const cached = this.cache.get(selection);
    if (cached) {
      this.observer.onFeatures(cached);
      this.observer.onStatus({ loading: false, error: null });
      return;
    }
    const urls = selection ? [filterUrl(this.base, selection)]
      : this.bounds.map((bounds) => collectionUrl(this.base, bounds));
    if (!urls.length) return;
    this.observer.onFeatures([]);
    this.observer.onStatus({ loading: true, error: null });
    const features: Feature[] = [];
    try {
      for (const url of urls) {
        const part = await this.read(url, {
          signal: request.signal,
          onBatch: (batch) => {
            if (current()) this.observer.onFeatures([...features, ...batch]);
          },
        });
        if (!current()) return;
        features.push(...part);
      }
      if (selection) this.cache.set(selection, features);
      this.observer.onFeatures(features);
      this.observer.onStatus({ loading: false, error: null });
    } catch (error) {
      if (current()) this.observer.onStatus({ loading: false, error: errorMessage(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelView();
    this.discoveryRequest?.abort();
    this.cache.clear();
  }
}
