export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const WORLD: Bounds = { minX: -180, minY: -90, maxX: 180, maxY: 90 };

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
