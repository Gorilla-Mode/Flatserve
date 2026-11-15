import type { Feature } from 'geojson';
import type { BinaryResponse, DecodeOptions, FgbLayer } from '../src/api';
import { DatasetSession as Session } from '../src/session';

/** Adapt readable feature fixtures to opaque handles for the coverage/lifetime tests.
 * Actual binary transfer and decoding are exercised in workerDecode.test.ts. */
export class DatasetSession extends Session {
  constructor(base: string, observer: {
    onFeatures: (features: Feature[]) => void;
    onStatus: (status: { loading: boolean; error: string | null }) => void;
    onHeader: NonNullable<DecodeOptions['onHeader']>;
    onDiscovery: (status: { loading: boolean; error: string | null }) => void;
    onValues?: (values: string[]) => void;
    onCoverage?: ConstructorParameters<typeof Session>[1]['onCoverage'];
    onLayers?: (layers: FgbLayer[]) => void;
    onTiming?: DecodeOptions['onTiming'];
  }, read: (url: URL, options: DecodeOptions) => Promise<Feature[]>) {
    const bodies = new Map<ArrayBuffer, { features: Feature[]; layers: FgbLayer[] }>();
    const datasets = new Map<number, Feature[]>();
    let next = 0, populated = false;
    super(base, { ...observer,
      onDataset: (handle) => {
        const features = datasets.get(handle)!;
        populated = features.length > 0;
        observer.onFeatures(features);
        datasets.delete(handle);
      },
      onInvalidate: () => { if (populated) observer.onFeatures([]); populated = false; },
    }, {
      decode: async (responses, signal) => {
        signal.throwIfAborted();
        const features: Feature[] = [], layers: FgbLayer[] = [];
        for (const response of responses) {
          const body = bodies.get(response.buffer)!;
          for (const feature of body.features) features.push(feature);
          for (const layer of body.layers) layers.push(layer);
          bodies.delete(response.buffer);
        }
        const handle = ++next;
        datasets.set(handle, features);
        return { handle, layers, timings: [], decodeMs: 0,
          values: [...new Set(features.map((f) => f.properties?.brannvesen)
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].sort((a, b) => a.localeCompare(b, 'nb')) };
      },
      release: (handle) => { datasets.delete(handle); },
    }, async (url, options): Promise<BinaryResponse> => {
      const layers: FgbLayer[] = [];
      const features = await read(url, { ...options, onHeader: (header) => { layers.push({ id: 'dataset', header }); },
        onLayer: (layer) => { layers[layers.length - 1] = layer; },
        onTiming: (timing) => { if (!options.signal.aborted) observer.onTiming?.(timing); } });
      const buffer = new ArrayBuffer(0);
      bodies.set(buffer, { features, layers });
      return { buffer, contentType: '', url: url.href, httpMs: null, started: 0, headersReceived: 0 };
    });
  }
}
