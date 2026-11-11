import type { Feature } from 'geojson';
import { featureLayer } from './api';

const colors = ['#bb342a', '#38bdf8', '#fbbf24', '#a78bfa', '#34d399', '#fb923c'];
export function layerColor(id: string): string {
  if (id === 'dataset') return colors[0];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

export interface DataBatch {
  version: number;
  groups: Map<string, Feature[]>;
}

/** IDs identify original features, including multipart geometries, within one batch. */
export function prepareBatch(features: Feature[], version: number, firstId = 0): DataBatch {
  const groups = new Map<string, Feature[]>();
  features.forEach((feature, id) => {
    const dataset = featureLayer(feature);
    let group = groups.get(dataset);
    if (!group) groups.set(dataset, group = []);
    group.push({ ...feature, id: firstId + id, properties: { ...feature.properties, __flatserveColor: group[0]?.properties?.__flatserveColor ?? layerColor(dataset) } });
  });
  return { version, groups };
}
