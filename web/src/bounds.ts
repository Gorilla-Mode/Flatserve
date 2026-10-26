import type { Feature, LineString } from 'geojson';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const WORLD: Bounds = { minX: -180, minY: -90, maxX: 180, maxY: 90 };

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
