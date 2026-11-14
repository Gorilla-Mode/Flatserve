import type { Feature } from 'geojson';
import type { GeoJSONSourceDiff } from 'maplibre-gl';
import { featureLayer } from './api';
import { layerColor } from './dataset';
import type { DataBatch } from './dataset';

export interface SnapshotDelta {
  connection: number;
  version: number;
  baseVersion: number;
  diffs: Map<string, GeoJSONSourceDiff>;
  /** Only added/changed records cross back to the UI thread. */
  records: Map<string, Feature[]>;
  ids: Map<string, number[]>;
}
interface RecordEntry { feature: Feature; content: string; identity?: string }
export interface Snapshot { batch: DataBatch; entries: Map<number, RecordEntry> }
export const emptySnapshot = (): Snapshot => ({ batch: { version: 0, groups: new Map() }, entries: new Map() });

// JSON's key order is not semantic. Keep exact canonical strings as collision verification,
// rather than trusting a hash, including for identical records with occurrence ordinals.
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function properties(feature: Feature) {
  return Object.fromEntries(Object.entries(feature.properties ?? {}).filter(([key]) => key !== '__flatserveColor'));
}
function identity(feature: Feature): string | undefined {
  const id = feature.properties?.gml_id;
  if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return;
  return canonical([featureLayer(feature), id, feature.geometry?.type, feature.properties?.__geoflatpack_vertices]);
}

/** Worker-only identity preparation. A candidate never mutates the applied snapshot. */
export class SnapshotDiffer {
  private nextId = 0;
  prepare(features: Feature[], version: number, applied: Snapshot, connection = 0): { snapshot: Snapshot; delta: SnapshotDelta } {
    const identities = features.map(identity);
    const frequencies = new Map<string, number>();
    for (const key of identities) if (key !== undefined) frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
    const oldIdentities = new Map<string, RecordEntry>();
    const oldContent = new Map<string, RecordEntry[]>();
    for (const entry of applied.entries.values()) {
      if (entry.identity !== undefined) oldIdentities.set(entry.identity, entry);
      const key = canonical([featureLayer(entry.feature), entry.content]);
      const bucket = oldContent.get(key) ?? [];
      bucket.push(entry);
      oldContent.set(key, bucket);
    }
    const entries: Snapshot['entries'] = new Map();
    const groups: DataBatch['groups'] = new Map();
    const diffs: SnapshotDelta['diffs'] = new Map();
    const records: SnapshotDelta['records'] = new Map();
    const ids: SnapshotDelta['ids'] = new Map();
    const used = new Set<number>();
    const diffFor = (dataset: string) => {
      let diff = diffs.get(dataset);
      if (!diff) diffs.set(dataset, diff = { add: [], remove: [], update: [] });
      return diff;
    };
    // Match unique identities first so fallback records cannot steal an identified ID.
    const incoming = features.map((feature, index) => {
      const dataset = featureLayer(feature);
      const props = properties(feature);
      const content = canonical([feature.geometry, props]);
      const key = identities[index];
      const unique = key !== undefined && frequencies.get(key) === 1 ? key : undefined;
      const old = unique === undefined ? undefined : oldIdentities.get(unique);
      if (old) used.add(old.feature.id as number);
      return { feature, dataset, props, content, unique, old };
    });
    for (const item of incoming) {
      const { feature, dataset, props, content, unique } = item;
      let old = item.old;
      if (!old) {
        const bucket = oldContent.get(canonical([dataset, content]));
        while (bucket?.length && used.has(bucket[0].feature.id as number)) bucket.shift();
        old = bucket?.shift();
        if (old) used.add(old.feature.id as number);
      }
      const id = old ? old.feature.id as number : this.nextId++;
      const retained = old?.content === content;
      const runtime = retained ? old!.feature : { ...feature, id, properties: { ...props, __flatserveColor: layerColor(dataset) } };
      if (!retained && old && canonical(old.feature.geometry) === canonical(runtime.geometry)) runtime.geometry = old.feature.geometry;
      entries.set(id, { feature: runtime, content, identity: unique });
      const group = groups.get(dataset) ?? [];
      group.push(runtime); groups.set(dataset, group);
      const order = ids.get(dataset) ?? [];
      order.push(id); ids.set(dataset, order);
      if (retained) continue;
      const changed = records.get(dataset) ?? [];
      changed.push(runtime); records.set(dataset, changed);
      const diff = diffFor(dataset);
      if (!old) diff.add!.push(runtime);
      else if (!runtime.geometry || !old.feature.geometry) {
        // MapLibre's newGeometry cannot represent null; replace this one record with its stable ID.
        diff.remove!.push(id); diff.add!.push(runtime);
      } else {
        const previous = old.feature.properties ?? {};
        const next = runtime.properties ?? {};
        diff.update!.push({ id,
          ...(canonical(old.feature.geometry) === canonical(runtime.geometry) ? {} : { newGeometry: runtime.geometry }),
          removeProperties: Object.keys(previous).filter((key) => !Object.hasOwn(next, key)),
          addOrUpdateProperties: Object.entries(next).filter(([key, value]) => canonical(previous[key]) !== canonical(value))
            .map(([key, value]) => ({ key, value })),
        });
      }
    }
    for (const [id, entry] of applied.entries) if (!entries.has(id)) diffFor(featureLayer(entry.feature)).remove!.push(id);
    return { snapshot: { batch: { version, groups }, entries }, delta: { connection, version, baseVersion: applied.batch.version, diffs, records, ids } };
  }
}

/** Reconstruct arrays using retained UI objects, without inspecting coordinates or serializing features. */
export function materialize(delta: SnapshotDelta, applied: DataBatch): DataBatch {
  const groups = new Map<string, Feature[]>();
  for (const [dataset, ids] of delta.ids) {
    const records = new Map((applied.groups.get(dataset) ?? []).map((feature) => [feature.id as number, feature]));
    for (const feature of delta.records.get(dataset) ?? []) records.set(feature.id as number, feature);
    groups.set(dataset, ids.map((id) => records.get(id)!));
  }
  return { version: delta.version, groups, delta };
}
