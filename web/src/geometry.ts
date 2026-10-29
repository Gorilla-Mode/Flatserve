import type { Geometry, Position } from 'geojson';
import { containsPoint } from './bounds';
import type { Bounds } from './bounds';

/** Inclusive segment/rectangle intersection, including crossings with both ends outside. */
function segmentIntersects(a: Position, b: Position, bounds: Bounds): boolean {
  if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return false;
  let start = 0;
  let end = 1;
  for (const [axis, min, max] of [[0, bounds.minX, bounds.maxX], [1, bounds.minY, bounds.maxY]]) {
    const delta = b[axis] - a[axis];
    if (delta === 0) {
      if (a[axis] < min || a[axis] > max) return false;
    } else {
      const first = (min - a[axis]) / delta;
      const last = (max - a[axis]) / delta;
      start = Math.max(start, Math.min(first, last));
      end = Math.min(end, Math.max(first, last));
      if (start > end) return false;
    }
  }
  return true;
}

function lineIntersects(coordinates: Position[], bounds: Bounds): boolean {
  return coordinates.some((point, index) => index > 0 && segmentIntersects(coordinates[index - 1], point, bounds));
}

/** Boundaries are tested separately, so this only needs the even/odd interior rule. */
function insideRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function polygonIntersects(rings: Position[][], bounds: Bounds): boolean {
  if (!rings[0]?.length) return false;
  // A ring inside the rectangle or crossing its edges is visible, including hole boundaries.
  if (rings.some((ring) => lineIntersects(ring, bounds))) return true;
  // Without boundary crossings, one corner tells whether the rectangle is inside the filled area.
  const corner = [bounds.minX, bounds.minY];
  return insideRing(corner, rings[0]) && !rings.slice(1).some((hole) => insideRing(corner, hole));
}

/** Test each normalized viewport part; keep multipart/collection features intact for counts. */
export function geometryIntersectsBounds(geometry: Geometry | null, bounds: Bounds[]): boolean {
  if (!geometry) return false;
  switch (geometry.type) {
    case 'Point': return containsPoint(bounds, geometry.coordinates);
    case 'MultiPoint': return geometry.coordinates.some((point) => containsPoint(bounds, point));
    case 'LineString': return bounds.some((area) => lineIntersects(geometry.coordinates, area));
    case 'MultiLineString': return bounds.some((area) => geometry.coordinates.some((line) => lineIntersects(line, area)));
    case 'Polygon': return bounds.some((area) => polygonIntersects(geometry.coordinates, area));
    case 'MultiPolygon': return bounds.some((area) => geometry.coordinates.some((polygon) => polygonIntersects(polygon, area)));
    case 'GeometryCollection': return geometry.geometries.some((member) => geometryIntersectsBounds(member, bounds));
  }
}
