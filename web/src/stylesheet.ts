import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { GeoJSONSource, Map, StyleSpecification } from 'maplibre-gl';
import type { Feature } from 'geojson';
import { errorMessage, featureLayer, normalizeApiUrl } from './api';
import { loadEmbeddedIcons } from './styleIcons';

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

/** Adapt GeoFlatpack's generated source names and embedded images to API datasets. */
export function renderStyledLayers(map: Map, datasetIds: string[], prepared: PreparedStylesheet) {
  const { style, icons } = prepared;
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
    for (const id of datasetIds) {
      const source = Object.hasOwn(style.sources, id) ? style.sources[id] : undefined;
      if (source?.type !== 'geojson' || !style.layers.some((layer) => 'source' in layer && layer.source === id)) {
        warnings.push(`No matching stylesheet source/layers for ${id}. Using basic styling.`);
        continue;
      }
      const runtimeId = `flatserve-style-source:${encodeURIComponent(id)}`;
      try {
        map.addSource(runtimeId, { ...source, data: collection([]) });
        sources.set(id, runtimeId);
        layers.set(id, []);
      } catch (error) { warnings.push(`${id}: ${errorMessage(error)} Using basic styling.`); }
    }
    // Iterate the shared stylesheet once to retain ordering across datasets too.
    for (const layer of style.layers) {
      if (!('source' in layer) || typeof layer.source !== 'string' || !sources.has(layer.source)) continue;
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
      } catch (error) {
        removeDataset(owner);
        warnings.push(`${owner}: ${errorMessage(error)} Using basic styling.`);
      }
    }
  } catch (error) {
    for (const id of [...sources.keys()]) removeDataset(id);
    for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    throw error;
  }
  return {
    styled: new Set(sources.keys()), warnings,
    update(features: Feature[]) {
      for (const [id, source] of sources)
        (map.getSource(source) as GeoJSONSource).setData(collection(features.filter((feature) => featureLayer(feature) === id)));
      (map.getSource('stations') as GeoJSONSource).setData(collection(features.filter((feature) => !sources.has(featureLayer(feature)))));
    },
    cleanup() {
      for (const id of [...sources.keys()]) removeDataset(id);
      for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    },
  };
}
