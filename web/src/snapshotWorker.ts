import type { Feature } from 'geojson';
import type { BinaryResponse, FgbLayer, RequestTiming } from './api';
import { decodeResponse } from './decode';
import type { ViewQuery, ViewResult } from './spatialIndex';
import { SpatialIndex } from './spatialIndex';
import { emptySnapshot, SnapshotDiffer } from './snapshot';
import type { Snapshot, SnapshotDelta } from './snapshot';

export interface DecodedDataset {
  handle: number;
  layers: FgbLayer[];
  values?: string[];
  timings: RequestTiming[];
  decodeMs: number;
}
export interface DatasetDecoder {
  decode(responses: BinaryResponse[], signal: AbortSignal, discovery?: boolean): Promise<DecodedDataset>;
  release(handle: number): void;
}

export type WorkerRequest =
  | { type: 'decode'; connection: number; request: number; responses: BinaryResponse[]; discovery: boolean }
  | { type: 'cancel'; connection: number; request: number }
  | { type: 'release'; connection: number; handle: number }
  | { type: 'data'; connection: number; version: number; handle: number | null; view: ViewQuery }
  | { type: 'commit' | 'discard'; connection: number; version: number }
  | ViewQuery;
export type WorkerResponse =
  | { type: 'decoded'; connection: number; request: number; dataset: DecodedDataset }
  | { type: 'decode-error'; connection: number; request: number; error: string }
  | { type: 'prepared'; delta: SnapshotDelta; view: ViewResult }
  | { type: 'error'; connection: number; version: number; error: string }
  | ViewResult;

/** Bound uninterrupted decoding work without paying a clamped timer for every small batch. */
function decodingYield(): () => Promise<void> {
  let lastYield = performance.now();
  return async () => {
    if (performance.now() - lastYield < 8) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lastYield = performance.now();
  };
}

/** Kept independent of self so tests exercise the real worker protocol. */
export class SnapshotWorker {
  private connection?: number;
  private applied = emptySnapshot();
  private index = new SpatialIndex([]);
  private candidate?: { snapshot: Snapshot; index: SpatialIndex };
  private differ = new SnapshotDiffer();
  private datasets = new Map<number, Feature[]>();
  private decoding = new Map<number, AbortController>();
  private latest = { view: 0, discovery: 0 };
  constructor(private readonly yieldControl = decodingYield()) {}

  private async decode(message: Extract<WorkerRequest, { type: 'decode' }>): Promise<WorkerResponse | undefined> {
    const channel = message.discovery ? 'discovery' : 'view';
    if (message.request <= this.latest[channel]) return { type: 'decode-error', connection: message.connection,
      request: message.request, error: 'Stale decode request.' };
    this.latest[channel] = message.request;
    const controller = new AbortController();
    this.decoding.set(message.request, controller);
    const checkCurrent = () => {
      controller.signal.throwIfAborted();
      if (this.latest[channel] !== message.request) throw new Error('Stale decode request.');
    };
    const started = performance.now();
    try {
      const features: Feature[] = [], layers: FgbLayer[] = [], timings: RequestTiming[] = [];
      for (const response of message.responses) {
        controller.signal.throwIfAborted();
        const decoded = await decodeResponse(new Response(response.buffer, {
          headers: { 'Content-Type': response.contentType },
        }), { signal: controller.signal, onLayer: (layer) => layers.push(layer),
          batchSize: 1000, yieldControl: this.yieldControl });
        checkCurrent();
        for (let i = 0; i < decoded.length; i++) {
          features.push(decoded[i]);
          if (i % 1000 === 999) { await this.yieldControl(); controller.signal.throwIfAborted(); }
        }
        const finished = performance.timeOrigin + performance.now();
        timings.push({ url: response.url, httpMs: response.httpMs,
          downloadDecodeMs: finished - response.headersReceived, totalMs: finished - response.started });
        await this.yieldControl();
      }
      checkCurrent();
      const values = message.discovery ? [...new Set(features.map((f) => f.properties?.brannvesen)
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
        .sort((a, b) => a.localeCompare(b, 'nb')) : undefined;
      this.datasets.set(message.request, features);
      return { type: 'decoded', connection: message.connection, request: message.request,
        dataset: { handle: message.request, layers, values, timings, decodeMs: performance.now() - started } };
    } catch (error) {
      return { type: 'decode-error', connection: message.connection, request: message.request, error: String(error) };
    } finally {
      this.decoding.delete(message.request);
    }
  }

  private dataset(handle: number): Feature[] {
    const features = this.datasets.get(handle);
    if (!features) throw new Error('Decoded dataset has been released or does not exist.');
    return features;
  }

  receive(message: WorkerRequest): WorkerResponse | undefined | Promise<WorkerResponse | undefined> {
    if (this.connection !== undefined && this.connection !== message.connection) return;
    this.connection = message.connection;
    if (message.type === 'decode') return this.decode(message);
    if (message.type === 'cancel') { this.decoding.get(message.request)?.abort(); return; }
    if (message.type === 'release') { this.datasets.delete(message.handle); return; }
    if (message.type === 'data') {
      try {
        if (message.version <= this.applied.batch.version || this.candidate) throw new Error('Stale or overlapping snapshot preparation.');
        const { snapshot, delta } = this.differ.prepare(message.handle === null ? [] : this.dataset(message.handle), message.version, this.applied, message.connection);
        const features = [...snapshot.batch.groups].flatMap(([dataset, group]) => group.map((feature) => ({
          id: feature.id as number, dataset, geometry: feature.geometry,
        })));
        const index = new SpatialIndex(features, this.index);
        this.candidate = { snapshot, index };
        return { type: 'prepared', delta, view: index.query(message.view) };
      } catch (error) {
        return { type: 'error', connection: message.connection, version: message.version, error: String(error) };
      } finally {
        if (message.handle !== null) this.datasets.delete(message.handle);
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
