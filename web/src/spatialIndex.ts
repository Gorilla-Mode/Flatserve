import type { Geometry, Position } from 'geojson';
import type { Bounds } from './bounds';
import { geometryIntersectsBounds } from './geometry';

export interface SpatialFeature { id: number; dataset: string; geometry: Geometry | null }
export interface ViewQuery {
  type: 'bounds'; connection: number; version: number; sequence: number;
  bounds: Bounds[]; bbox: boolean; text: boolean;
}
export interface DataMessage {
  type: 'data'; connection: number; version: number; features: SpatialFeature[];
}
export interface ViewResult {
  connection: number; version: number; sequence: number;
  counts: Record<string, number>; membership: Record<string, number[]> | null;
}

function envelope(geometry: Geometry | null): Bounds | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const point = (position: Position, wrap: boolean) => {
    let [x, y] = position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (wrap) x = ((x + 180) % 360 + 360) % 360 - 180;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    // The exact point test treats +180 and -180 as the same meridian.
    if (wrap && x === -180) { minX = -180; maxX = 180; }
  };
  const coordinates = (value: Position | Position[] | Position[][] | Position[][][], wrap: boolean) => {
    if (typeof value[0] === 'number') point(value as Position, wrap);
    else for (const child of value) coordinates(child as Position | Position[] | Position[][], wrap);
  };
  const visit = (value: Geometry | null) => {
    if (!value) return;
    if (value.type === 'GeometryCollection') value.geometries.forEach(visit);
    else coordinates(value.coordinates, value.type === 'Point' || value.type === 'MultiPoint');
  };
  visit(geometry);
  return minX === Infinity ? undefined : { minX, minY, maxX, maxY };
}

/** Constructed only in the worker: camera messages never traverse coordinates on the UI thread. */
export class SpatialIndex {
  private readonly entries;
  constructor(features: SpatialFeature[]) {
    this.entries = features.map((feature) => ({ ...feature, envelope: envelope(feature.geometry) }));
  }
  query(query: ViewQuery): ViewResult {
    const counts: Record<string, number> = Object.create(null);
    const membership: Record<string, number[]> | null = query.bbox ? Object.create(null) : null;
    for (const feature of this.entries) {
      counts[feature.dataset] ??= 0;
      const box = feature.envelope;
      const intersects = query.text || (box && query.bounds.some((bounds) =>
        box.maxX >= bounds.minX && box.minX <= bounds.maxX && box.maxY >= bounds.minY && box.minY <= bounds.maxY)
        && geometryIntersectsBounds(feature.geometry, query.bounds));
      if (!intersects) continue;
      counts[feature.dataset]++;
      if (membership) (membership[feature.dataset] ??= []).push(feature.id);
    }
    return { connection: query.connection, version: query.version, sequence: query.sequence, counts, membership };
  }
}
