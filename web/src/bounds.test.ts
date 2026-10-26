import { describe, expect, it } from 'vitest';
import { containsBounds, containsPoint, coverageOutline, expandBounds, insetBounds, viewportBounds, WORLD } from './bounds';

function projection(longitude = 10, bearing = 0, pitch = 0) {
  const cos = Math.cos(bearing);
  const sin = Math.sin(bearing);
  return {
    project([lng, lat]: [number, number]) {
      const dx = (lng - longitude) * 10;
      const dy = -lat * 10;
      const x = dx * cos - dy * sin;
      const y = dx * sin + dy * cos;
      const perspective = 1 + y * pitch / 1000;
      return { x: 500 + x / perspective, y: 300 + y / perspective };
    },
    unproject([x, y]: [number, number]) {
      const perspective = 1 - (y - 300) * pitch / 1000;
      const dx = (x - 500) / perspective;
      const dy = (y - 300) / perspective;
      return { lng: longitude + (dx * cos + dy * sin) / 10, lat: -(-dx * sin + dy * cos) / 10 };
    },
  };
}

describe('fetched coverage outline', () => {
  it('draws exactly the reported coverage without expanding it again', () => {
    const fetched = expandBounds(viewportBounds(4, 58, 12, 62));
    expect(coverageOutline(fetched)?.geometry.coordinates).toEqual([
      [[2, 57], [14, 57], [14, 63], [2, 63], [2, 57]],
    ]);
    expect(coverageOutline([])).toBeUndefined();
  });

  it.each([170, -190, 530])('rejoins coverage across the date line in world %s without false edges', (west) => {
    const fetched = expandBounds(viewportBounds(west, -20, west + 20, 20));
    const outline = coverageOutline(fetched)!;
    expect(outline.geometry.coordinates).toEqual([
      [[165, -30], [195, -30], [195, 30], [165, 30], [165, -30]],
    ]);
    const [sw, , ne] = outline.geometry.coordinates[0];
    expect(viewportBounds(sw[0], sw[1], ne[0], ne[1])).toEqual(fetched);
  });

  it('normalizes repeated worlds and omits artificial vertical edges for full-world coverage', () => {
    expect(coverageOutline([{ minX: 364, minY: 58, maxX: 392, maxY: 72 }]))
      .toEqual(coverageOutline(viewportBounds(4, 58, 32, 72)));
    expect(coverageOutline(viewportBounds(-400, -60, 400, 60))?.geometry.coordinates).toEqual([
      [[-180, -60], [0, -60], [180, -60]],
      [[-180, 60], [0, 60], [180, 60]],
    ]);
  });
});

describe('inset query rectangle', () => {
  it('leaves a 20% margin and uses the exact outline coordinates for requests', () => {
    const { bounds, outline } = insetBounds(projection(), 1000, 600);
    expect(bounds).toHaveLength(1);
    expect(bounds[0].minX).toBeCloseTo(-20);
    expect(bounds[0].maxX).toBeCloseTo(40);
    expect(bounds[0].minY).toBeCloseTo(-18);
    expect(bounds[0].maxY).toBeCloseTo(18);
    const [sw, , ne] = outline.geometry.coordinates;
    expect(bounds).toEqual(viewportBounds(sw[0], sw[1], ne[0], ne[1]));
    expect(outline.geometry.coordinates[4]).toEqual(sw);
  });
  it.each([0, Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI])(
    'keeps every corner within the inset at bearing %s with perspective', (bearing) => {
      const map = projection(10, bearing, 0.8);
      const { outline } = insetBounds(map, 1000, 600);
      for (const coordinate of outline.geometry.coordinates) {
        const { x, y } = map.project(coordinate as [number, number]);
        expect(x).toBeGreaterThanOrEqual(200);
        expect(x).toBeLessThanOrEqual(800);
        expect(y).toBeGreaterThanOrEqual(120);
        expect(y).toBeLessThanOrEqual(480);
      }
      expect(outline.geometry.coordinates[2][0] - outline.geometry.coordinates[0][0]).toBeGreaterThan(10);
    },
  );
  it.each([179, -181, 539])('splits queries at longitude %s while drawing a continuous outline', (longitude) => {
    const { bounds, outline } = insetBounds(projection(longitude), 1000, 600);
    expect(bounds).toHaveLength(2);
    expect(bounds[0].maxX).toBe(180);
    expect(bounds[1].minX).toBe(-180);
    expect(bounds[0].minX).toBeCloseTo(149);
    expect(bounds[1].maxX).toBeCloseTo(-151);
    const [sw, se, ne] = outline.geometry.coordinates;
    expect(se[0] - sw[0]).toBeCloseTo(60);
    expect(bounds).toEqual(viewportBounds(sw[0], sw[1], ne[0], ne[1]));
  });
});

describe('camera bounds', () => {
  it('keeps Norway bounds and normalizes a repeated world', () => {
    expect(viewportBounds(4, 58, 32, 72)).toEqual([{ minX: 4, minY: 58, maxX: 32, maxY: 72 }]);
    expect(viewportBounds(364, 58, 392, 72)).toEqual(viewportBounds(4, 58, 32, 72));
    expect(viewportBounds(-356, 58, -328, 72)).toEqual(viewportBounds(4, 58, 32, 72));
  });
  it('splits wrapped and unwrapped bounds at the antimeridian', () => {
    const split = [{ minX: 170, minY: -20, maxX: 180, maxY: 20 },
      { minX: -180, minY: -20, maxX: -170, maxY: 20 }];
    expect(viewportBounds(170, -20, 190, 20)).toEqual(split);
    expect(viewportBounds(170, -20, -170, 20)).toEqual(split);
    expect(viewportBounds(-190, -20, -170, 20)).toEqual(split);
    expect(viewportBounds(530, -20, 550, 20)).toEqual(split);
  });
  it('queries the world once for wide views and clamps latitude', () => {
    expect(viewportBounds(-400, -100, 400, 100)).toEqual([{ minX: -180, minY: -90, maxX: 180, maxY: 90 }]);
    expect(viewportBounds(180, 0, 540, 80)).toEqual([{ minX: -180, minY: 0, maxX: 180, maxY: 80 }]);
    expect(viewportBounds(180, 0, 190, 80)[0].minX).toBe(-180);
    expect(viewportBounds(10, 50, 10, 50)).toEqual([{ minX: 10, minY: 50, maxX: 10, maxY: 50 }]);
  });
  it('rejects invalid coordinates', () => {
    expect(() => viewportBounds(NaN, 0, 10, 20)).toThrow();
    expect(() => viewportBounds(0, 20, 10, 0)).toThrow();
  });
});

describe('buffered bounds', () => {
  it('adds a quarter of the active size to every side', () => {
    expect(expandBounds(viewportBounds(4, 58, 12, 62)))
      .toEqual(viewportBounds(2, 57, 14, 63));
    expect(expandBounds([])).toEqual([]);
  });
  it('clamps latitude and caps longitude at one world', () => {
    expect(expandBounds(viewportBounds(-120, -80, 120, 80))).toEqual([WORLD]);
    expect(expandBounds(viewportBounds(0, 80, 10, 90)))
      .toEqual(viewportBounds(-2.5, 77.5, 12.5, 90));
    expect(expandBounds([WORLD])).toEqual([WORLD]);
  });
  it.each([170, -190, 530])('expands a crossing in world %s without buffering its parts separately', (west) => {
    const active = viewportBounds(west, -20, west + 20, 20);
    const buffer = expandBounds(active);
    expect(buffer).toEqual(viewportBounds(165, -30, 195, 30));
    expect(containsBounds(buffer, active)).toBe(true);
    expect(containsBounds(buffer, viewportBounds(170, -30, 195, 30))).toBe(true);
    expect(containsBounds(buffer, viewportBounds(170, -30, 196, 30))).toBe(false);
    expect(containsBounds(buffer, viewportBounds(-10, -20, 10, 20))).toBe(false);
    expect(containsBounds(buffer, viewportBounds(-175, -20, -170, 20))).toBe(true);
  });
  it('includes touching edges and points at either representation of the date line', () => {
    const buffer = viewportBounds(170, -20, 180, 20);
    expect(containsBounds(buffer, buffer)).toBe(true);
    expect(containsBounds(buffer, viewportBounds(-180, -20, -180, 20))).toBe(true);
    expect(containsPoint(buffer, [-180, 20])).toBe(true);
    expect(containsPoint(buffer, [540, 20])).toBe(true);
    expect(containsPoint(buffer, [180, 21])).toBe(false);
    expect(containsBounds([WORLD], viewportBounds(530, -90, 550, 90))).toBe(true);
    expect(containsBounds(buffer, [WORLD])).toBe(false);
    expect(containsBounds([], buffer)).toBe(false);
    expect(containsBounds(buffer, [])).toBe(false);
  });
  it('normalizes unwrapped rectangles for containment', () => {
    expect(containsBounds([{ minX: 364, minY: 58, maxX: 392, maxY: 72 }],
      viewportBounds(4, 58, 32, 72))).toBe(true);
    const buffer = expandBounds(viewportBounds(4, 58, 12, 62));
    expect(containsBounds(buffer, viewportBounds(2, 57, 14, 63))).toBe(true);
    expect(containsBounds(buffer, viewportBounds(2, 56.99, 14, 63))).toBe(false);
    expect(containsBounds(buffer, viewportBounds(1.99, 57, 14, 63))).toBe(false);
  });
});
