import { convertFilter, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { VisibilitySpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FilterSpecification, GeoJSONSource, GeoJSONSourceDiff, Map, StyleSpecification } from 'maplibre-gl';
import type { Feature } from 'geojson';
import { errorMessage, normalizeApiUrl } from './api';
import { loadEmbeddedIcons } from './styleIcons';
import { layerColor } from './dataset';
import type { DataBatch } from './dataset';

export async function fetchStylesheet(base: string, signal: AbortSignal) {
  const response = await fetch(new URL('fgb/style', normalizeApiUrl(base)), {
    signal, credentials: 'omit', headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Stylesheet API returned HTTP ${response.status}.`);
  let style: StyleSpecification;
  try { style = await response.json(); }
  catch { throw new Error('The stylesheet is not valid JSON.'); }
  signal.throwIfAborted();
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new Error('Expected a MapLibre stylesheet.');
  const errors = validateStyleMin(style);
  if (errors.length) throw new Error(`Invalid stylesheet: ${errors[0].message}`);
  const icons = await loadEmbeddedIcons(style, signal);
  signal.throwIfAborted();
  return { style, icons };
}

export type PreparedStylesheet = Awaited<ReturnType<typeof fetchStylesheet>>;
const collection = (features: Feature[]) => ({ type: 'FeatureCollection' as const, features });
// MapLibre mutates source records when applying later diffs. Keep acknowledged UI records
// separate without traversing or serializing geometry on the main thread.
const sourceRecords = (features: Feature[]) => features.map((feature) => ({ ...feature, properties: { ...feature.properties } }));

/** Adapt GeoFlatpack's generated source names and embedded images to API datasets. */
export function renderStyledLayers(map: Map, datasetIds: string[], prepared?: PreparedStylesheet) {
  const { style, icons } = prepared ?? { style: { sources: {}, layers: [] } as unknown as StyleSpecification,
    icons: { images: new globalThis.Map(), errors: [] } };
  const originals = new globalThis.Map<string, { filter?: FilterSpecification; visibility: VisibilitySpecification; expression?: ReturnType<typeof convertFilter> }>();
  const warnings = [...icons.errors];
  const sources = new globalThis.Map<string, string>();
  const layers = new globalThis.Map<string, string[]>();
  const images: string[] = [];
  const runtimeIcons = new globalThis.Map<string, string>();
  function removeDataset(id: string) {
    for (const layer of [...(layers.get(id) ?? [])].reverse()) if (map.getLayer(layer)) map.removeLayer(layer);
    const source = sources.get(id);
    if (source && map.getSource(source)) map.removeSource(source);
    layers.delete(id);
    sources.delete(id);
    styled.delete(id);
  }
  try {
    for (const [name, image] of icons.images) {
      if (!image) continue;
      const id = `flatserve-style-icon:${encodeURIComponent(name)}`;
      try {
        map.addImage(id, image, { pixelRatio: 1, sdf: false });
        if (!map.hasImage(id)) throw new Error('Unable to register image.');
        images.push(id);
        runtimeIcons.set(name, id);
      } catch (error) { warnings.push(`Icon ${name}: ${errorMessage(error)}`); }
    }
  } catch (error) {
    for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    throw error;
  }
  const styled = new Set<string>();
  function addDatasets(requested: string[]) {
    const datasetIds = requested.filter((id) => !sources.has(id));
    for (const id of datasetIds) {
      const source = Object.hasOwn(style.sources, id) ? style.sources[id] : undefined;
      if (source?.type !== 'geojson' || !style.layers.some((layer) => 'source' in layer && layer.source === id)) {
        if (prepared) warnings.push(`No matching stylesheet source/layers for ${id}. Using basic styling.`);
        continue;
      }
      const runtimeId = `flatserve-style-source:${encodeURIComponent(id)}`;
      try {
        map.addSource(runtimeId, { ...source, generateId: false, promoteId: undefined, data: collection([]) });
        sources.set(id, runtimeId);
        styled.add(id);
        layers.set(id, []);
      } catch (error) { warnings.push(`${id}: ${errorMessage(error)} Using basic styling.`); }
    }
    // Iterate the shared stylesheet once to retain ordering across datasets too.
    for (const layer of style.layers) {
      if (!('source' in layer) || typeof layer.source !== 'string' || !datasetIds.includes(layer.source) || !sources.has(layer.source)) continue;
      const owner = layer.source;
      const id = `flatserve-style-layer:${encodeURIComponent(layer.id)}`;
      try {
        let runtime = { ...layer, id, source: sources.get(owner)! };
        if (runtime.type === 'symbol') {
          const icon = runtime.layout?.['icon-image'];
          if (typeof icon === 'string' && icons.images.has(icon)) {
            const layout = { ...runtime.layout };
            if (runtimeIcons.has(icon)) layout['icon-image'] = runtimeIcons.get(icon)!;
            else delete layout['icon-image'];
            runtime = { ...runtime, layout };
          }
        }
        map.addLayer(runtime, 'authorized-area-fill');
        if (!map.getLayer(id)) throw new Error(`Unable to add layer ${layer.id}.`);
        layers.get(owner)!.push(id);
        const filter = 'filter' in layer ? layer.filter : undefined;
        originals.set(id, { filter, expression: filter === undefined ? undefined : convertFilter(filter),
          visibility: layer.layout?.visibility ?? 'visible' });
      } catch (error) {
        removeDataset(owner);
        warnings.push(`${owner}: ${errorMessage(error)} Using basic styling.`);
      }
    }
    // Per-dataset layers allow layout toggles; keep every fallback fill below lines and points.
    const fallbacks = datasetIds.filter((dataset) => !sources.has(dataset));
    for (const dataset of fallbacks) {
      const source = `flatserve-fallback-source:${encodeURIComponent(dataset)}`;
      map.addSource(source, { type: 'geojson', generateId: false, promoteId: undefined, data: collection([]) });
      sources.set(dataset, source);
      layers.set(dataset, []);
    }
    for (const [type, geometry] of [['fill', 'Polygon'], ['line', 'LineString'], ['circle', 'Point']] as const) {
      for (const dataset of fallbacks) {
        const color = layerColor(dataset);
        const paint = type === 'fill' ? { 'fill-color': color, 'fill-opacity': .18 }
          : type === 'line' ? { 'line-color': color, 'line-width': 2 }
          : { 'circle-color': color, 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 };
        const id = `flatserve-fallback-layer:${encodeURIComponent(dataset)}:${type}`;
        const filter: FilterSpecification = ['==', ['geometry-type'], geometry];
        map.addLayer({ id, type, source: sources.get(dataset)!, filter, paint } as Parameters<Map['addLayer']>[0], 'authorized-area-fill');
        layers.get(dataset)!.push(id);
        originals.set(id, { filter, expression: convertFilter(filter), visibility: 'visible' });
      }
    }
  }
  addDatasets(datasetIds);
  let version = 0;
  let highestRequested = 0;
  let hiddenAtVersion = -1;
  let disposed = false;
  let failed = false;
  let tail: Promise<void> = Promise.resolve();
  let appliedGroups: DataBatch['groups'] = new globalThis.Map();
  let previousSuspended = false;
  let lastView: { batch: DataBatch; membership: Record<string, number[]> | null; hidden: Set<string> } = {
    batch: { version: 0, groups: new globalThis.Map() }, membership: null, hidden: new Set(),
  };
  let previousMembership: Record<string, number[]> | null | undefined;
  let previousHidden = new Set<string>();
  const equalIds = (a: number[], b: number[]) => a.length === b.length && a.every((id, index) => id === b[index]);
  function ensureDatasets(ids: string[]) {
    const missing = ids.filter((id) => !sources.has(id));
    if (!missing.length) return;
    addDatasets(missing);
    for (const dataset of missing) for (const id of layers.get(dataset) ?? []) {
      map.setLayoutProperty(id, 'visibility', failed || lastView.batch.version <= hiddenAtVersion || lastView.hidden.has(dataset)
        ? 'none' : originals.get(id)!.visibility);
    }
    // Keep stylesheet order across datasets that are discovered at different times.
    for (const layer of style.layers) {
      const id = `flatserve-style-layer:${encodeURIComponent(layer.id)}`;
      if (map.getLayer(id)) map.moveLayer(id, 'authorized-area-fill');
    }
    previousMembership = undefined;
    renderer.update(lastView.batch, lastView.membership, lastView.hidden);
  }
  const renderer = {
    styled, warnings, ensureDatasets,
    apply(batch: DataBatch): Promise<void> {
      highestRequested = Math.max(highestRequested, batch.version);
      const apply = async () => {
        if (disposed) throw new Error('Dataset renderer was removed.');
        if (failed) throw new Error('Dataset update recovery failed. Retry the stylesheet to recreate sources.');
        if (batch.version === version) return;
        ensureDatasets([...batch.groups.keys()]);
        const changes = batch.delta?.baseVersion === version ? batch.delta.diffs : new globalThis.Map(
          [...sources.keys()].filter((dataset) => appliedGroups.has(dataset) || batch.groups.has(dataset))
            .map((dataset) => [dataset, { removeAll: true, add: batch.groups.get(dataset) ?? [] } as GeoJSONSourceDiff]),
        );
        const touched: string[] = [];
        try {
          // Serializing the snapshot is stricter than one transaction per dataset and bounds worker pressure.
          for (const [dataset, diff] of changes) {
            const source = sources.get(dataset);
            if (!source) throw new Error(`Dataset source is not ready: ${dataset}`);
            touched.push(dataset);
            await (map.getSource(source) as GeoJSONSource).updateData({ ...diff,
              ...(diff.add ? { add: sourceRecords(diff.add) } : {}),
            });
          }
          if (disposed) throw new Error('Dataset renderer was removed.');
          version = batch.version;
          appliedGroups = batch.groups;
        } catch (error) {
          // updateData can mutate its local store before its worker rejects. Restore acknowledged
          // records even for the rejecting source; ordinary responses never use this recovery path.
          if (!disposed) for (const dataset of touched) {
            try {
              await (map.getSource(sources.get(dataset)!) as GeoJSONSource).updateData({
                removeAll: true, add: sourceRecords(appliedGroups.get(dataset) ?? []),
              });
            } catch { failed = true; }
          }
          if (failed) {
            hiddenAtVersion = highestRequested;
            for (const owned of layers.values()) for (const id of owned) map.setLayoutProperty(id, 'visibility', 'none');
          }
          throw error;
        }
      };
      const result = tail.then(apply);
      tail = result.catch(() => {});
      return result;
    },
    hide() {
      previousSuspended = true;
      hiddenAtVersion = highestRequested;
      for (const owned of layers.values()) for (const id of owned) map.setLayoutProperty(id, 'visibility', 'none');
    },
    update(batch: DataBatch, membership: Record<string, number[]> | null = null, hidden = new Set<string>()) {
      lastView = { batch, membership, hidden };
      const suspended = failed || batch.version <= hiddenAtVersion;
      const wasSuspended = previousSuspended;
      previousSuspended = suspended;
      for (const [dataset, ownedLayers] of layers) {
        const ids = membership?.[dataset] ?? [];
        const previousIds = previousMembership?.[dataset] ?? [];
        const changed = previousMembership === undefined || (membership === null) !== (previousMembership === null)
          || !equalIds(ids, previousIds);
        for (const id of ownedLayers) {
          const original = originals.get(id)!;
          if (changed) {
            const restriction: FilterSpecification = ['in', ['id'], ['literal', ids]];
            const filter: FilterSpecification = original.expression === undefined
              ? restriction : ['all', original.expression, restriction];
            map.setFilter(id, membership === null ? original.filter ?? null : filter);
          }
          if (suspended !== wasSuspended || hidden.has(dataset) !== previousHidden.has(dataset))
            map.setLayoutProperty(id, 'visibility', suspended || hidden.has(dataset) ? 'none' : original.visibility);
        }
      }
      previousMembership = membership;
      previousHidden = hidden;
    },
    cleanup() {
      disposed = true;
      for (const id of [...sources.keys()]) removeDataset(id);
      for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    },
  };
  return renderer;
}
