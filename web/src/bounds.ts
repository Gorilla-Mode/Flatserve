import type { Feature, LineString, MultiLineString } from 'geojson';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const WORLD: Bounds = { minX: -180, minY: -90, maxX: 180, maxY: 90 };

/** Recover the continuous longitude interval from viewportBounds' ordered parts. */
function continuousBounds(bounds: Bounds[]): Bounds | undefined {
  const parts = bounds.flatMap((b) => viewportBounds(b.minX, b.minY, b.maxX, b.maxY));
  if (!parts.length) return;
  return {
    minX: parts[0].minX,
    maxX: parts[0].minX + Math.min(360, parts.reduce((width, b) => width + b.maxX - b.minX, 0)),
    minY: parts[0].minY,
    maxY: parts[0].maxY,
  };
}

/** Rejoin fetched parts into one geographic outline, without a date-line seam. */
export function coverageOutline(bounds: Bounds[]): Feature<MultiLineString> | undefined {
  const area = continuousBounds(bounds);
  if (!area) return;
  const { minX: west, minY: south, maxX: east, maxY: north } = area;
  // World-wide coverage has no east/west edge. Subdivide the parallels so that
  // GeoJSON wrapping never mistakes a full-world segment for a zero-width one.
  const coordinates = east - west >= 360
    ? [south, north].map((y) => [[west, y], [west + 180, y], [east, y]])
    : [[[west, south], [east, south], [east, north], [west, north], [west, south]]];
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates } };
}

/** Add a fraction of the original width/height on each side, then normalize/split. */
export function expandBounds(bounds: Bounds[], margin = 0.3): Bounds[] {
  const area = continuousBounds(bounds);
  if (!area) return [];
  return expandArea(area, margin);
}

function expandArea(area: Bounds, margin: number, offsetX = 0, offsetY = 0): Bounds[] {
  const x = (area.maxX - area.minX) * margin;
  const y = (area.maxY - area.minY) * margin;
  return viewportBounds(area.minX - x + offsetX, area.minY - y + offsetY,
    area.maxX + x + offsetX, area.maxY + y + offsetY);
}

/** Shift both buffers toward movement from the last successful original query.
 * Work in continuous coordinates so splitting and polar clipping happen last. */
export function directionalBuffers(bounds: Bounds[], anchor?: Bounds[]): { fetched: Bounds[]; prefetch: Bounds[] } {
  const area = continuousBounds(bounds);
  if (!area) return { fetched: [], prefetch: [] };
  const previous = anchor && continuousBounds(anchor);
  const width = area.maxX - area.minX;
  const height = area.maxY - area.minY;
  let dx = 0, dy = 0;
  if (previous) {
    if (width > 0 && width < 360 && previous.maxX - previous.minX < 360) {
      const longitude = (area.minX + area.maxX - previous.minX - previous.maxX) / 2;
      dx = (((longitude + 180) % 360 + 360) % 360 - 180) / width;
    }
    if (height > 0) dy = (area.minY + area.maxY - previous.minY - previous.maxY) / 2 / height;
  }
  const length = Math.hypot(dx, dy);
  const offsetX = length ? width * 0.1 * dx / length : 0;
  const offsetY = length ? height * 0.1 * dy / length : 0;
  return {
    fetched: expandArea(area, 0.3, offsetX, offsetY),
    prefetch: expandArea(area, 0.2, offsetX, offsetY),
  };
}

/** Inclusive containment of geographic rectangles, including repeated worlds. */
export function containsBounds(buffer: Bounds[], bounds: Bounds[]): boolean {
  const outer = continuousBounds(buffer);
  const inner = continuousBounds(bounds);
  if (!outer || !inner || inner.minY < outer.minY || inner.maxY > outer.maxY) return false;
  const width = outer.maxX - outer.minX;
  if (width >= 360) return true;
  const offset = ((inner.minX - outer.minX) % 360 + 360) % 360;
  return offset + inner.maxX - inner.minX <= width + 1e-9;
}

/** Reuse only strictly inside reachable prefetch edges. World and collapsed edges
 * remain inclusive so stationary full-world/degenerate views never request forever. */
export function containsPrefetchBounds(boundary: Bounds[], bounds: Bounds[]): boolean {
  if (!containsBounds(boundary, bounds)) return false;
  const outer = continuousBounds(boundary)!;
  const inner = continuousBounds(bounds)!;
  const epsilon = 1e-9;
  const height = outer.maxY - outer.minY;
  if (height > epsilon) {
    const tolerance = Math.min(epsilon, height * 0.01);
    if (outer.minY > -90 && inner.minY <= outer.minY + tolerance) return false;
    if (outer.maxY < 90 && inner.maxY >= outer.maxY - tolerance) return false;
  }
  const width = outer.maxX - outer.minX;
  if (width >= 360 || width <= epsilon) return true;
  const offset = ((inner.minX - outer.minX) % 360 + 360) % 360;
  const tolerance = Math.min(epsilon, width * 0.01);
  return offset > tolerance && offset + inner.maxX - inner.minX < width - tolerance;
}

export function containsPoint(bounds: Bounds[], coordinates: number[]): boolean {
  const [longitude, latitude] = coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  const x = ((longitude + 180) % 360 + 360) % 360 - 180;
  return bounds.some((b) => latitude >= b.minY && latitude <= b.maxY
    && ((x >= b.minX && x <= b.maxX) || (x === -180 && b.maxX === 180)));
}

interface Projection {
  project(coordinates: [number, number]): { x: number; y: number };
  unproject(point: [number, number]): { lng: number; lat: number };
}

/** A geographic rectangle whose projected corners fit in the middle 60% of the canvas. */
export function insetBounds(map: Projection, width: number, height: number): {
  bounds: Bounds[];
  outline: Feature<LineString>;
} {
  const left = width * 0.2;
  const right = width * 0.8;
  const top = height * 0.2;
  const bottom = height * 0.8;
  const center = map.unproject([width / 2, height / 2]);
  const samples = [[left, top], [right, top], [right, bottom], [left, bottom]]
    .map(([x, y]) => map.unproject([x, y]));
  const halfWidth = Math.min(180, Math.max(...samples.map((p) => Math.abs(p.lng - center.lng))));
  // Stay within the Mercator projection, including when looking toward the horizon.
  const halfHeight = Math.max(0, Math.min(85.0511287798066 - Math.abs(center.lat),
    Math.max(...samples.map((p) => Math.abs(p.lat - center.lat)))));
  const corners = (scale: number): [number, number][] => [
    [center.lng - halfWidth * scale, center.lat - halfHeight * scale],
    [center.lng + halfWidth * scale, center.lat - halfHeight * scale],
    [center.lng + halfWidth * scale, center.lat + halfHeight * scale],
    [center.lng - halfWidth * scale, center.lat + halfHeight * scale],
  ];
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const scale = (low + high) / 2;
    const fits = corners(scale).every((corner) => {
      const { x, y } = map.project(corner);
      return x >= left && x <= right && y >= top && y <= bottom;
    });
    if (fits) low = scale;
    else high = scale;
  }
  const ring = corners(low);
  const [west, south] = ring[0];
  const [east, north] = ring[2];
  return {
    bounds: viewportBounds(west, south, east, north),
    // Keep a continuous, unwrapped ring at the date line; splitting would add a false seam.
    outline: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...ring, ring[0]] } },
  };
}

/** MapLibre can report longitudes outside ±180, or bounds crossing the date line. */
export function viewportBounds(west: number, south: number, east: number, north: number): Bounds[] {
  if (![west, south, east, north].every(Number.isFinite) || south > north) {
    throw new Error('Invalid map bounds.');
  }
  const minY = Math.max(-90, Math.min(90, south));
  const maxY = Math.max(-90, Math.min(90, north));
  if (Math.abs(east - west) >= 360) return [{ ...WORLD, minY, maxY }];

  const width = ((east - west) % 360 + 360) % 360;
  const minX = ((west + 180) % 360 + 360) % 360 - 180;
  const maxX = minX + width;
  if (maxX <= 180) return [{ minX, minY, maxX, maxY }];
  return [
    { minX, minY, maxX: 180, maxY },
    { minX: -180, minY, maxX: maxX - 360, maxY },
  ];
}
