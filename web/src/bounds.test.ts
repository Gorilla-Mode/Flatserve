import { describe, expect, it } from 'vitest';
import { directionalBuffers, containsBounds, containsPrefetchBounds, containsPoint, coverageOutline, expandBounds, insetBounds, viewportBounds, WORLD } from './bounds';

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
    const fetched = expandBounds(viewportBounds(0, 50, 10, 60));
    expect(coverageOutline(fetched)?.geometry.coordinates).toEqual([
      [[-3, 47], [13, 47], [13, 63], [-3, 63], [-3, 47]],
    ]);
    expect(coverageOutline([])).toBeUndefined();
  });

  it.each([170, -190, 530])('rejoins coverage across the date line in world %s without false edges', (west) => {
    const fetched = expandBounds(viewportBounds(west, -20, west + 20, 20));
    const outline = coverageOutline(fetched)!;
    expect(outline.geometry.coordinates).toEqual([
      [[164, -32], [196, -32], [196, 32], [164, 32], [164, -32]],
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
  it('adds 30% of the original size by default and accepts a 20% prefetch margin', () => {
    expect(expandBounds(viewportBounds(4, 58, 12, 62)))
      .toEqual(viewportBounds(1.6, 56.8, 14.4, 63.2));
    expect(expandBounds(viewportBounds(0, 50, 10, 60), 0.2))
      .toEqual(viewportBounds(-2, 48, 12, 62));
    expect(expandBounds([])).toEqual([]);
  });
  it('clamps latitude and caps longitude at one world', () => {
    expect(expandBounds(viewportBounds(-120, -80, 120, 80))).toEqual([WORLD]);
    expect(expandBounds(viewportBounds(0, 80, 10, 90)))
      .toEqual(viewportBounds(-3, 77, 13, 90));
    expect(expandBounds([WORLD])).toEqual([WORLD]);
  });
  it.each([170, -190, 530])('expands a crossing in world %s without buffering its parts separately', (west) => {
    const active = viewportBounds(west, -20, west + 20, 20);
    const buffer = expandBounds(active);
    expect(buffer).toEqual(viewportBounds(164, -32, 196, 32));
    expect(containsBounds(buffer, active)).toBe(true);
    expect(containsBounds(buffer, viewportBounds(170, -30, 195, 30))).toBe(true);
    expect(containsBounds(buffer, viewportBounds(170, -30, 197, 30))).toBe(false);
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
    expect(containsBounds(buffer, viewportBounds(2, 56.79, 14, 63))).toBe(false);
    expect(containsBounds(buffer, viewportBounds(1.59, 57, 14, 63))).toBe(false);
  });
});

describe('directional buffers', () => {
  const query = viewportBounds(0, 0, 10, 20);

  it('starts centered and centers zoom changes without center movement', () => {
    for (const anchor of [undefined, [], viewportBounds(-5, -10, 15, 30)]) {
      expect(directionalBuffers(query, anchor)).toEqual({
        fetched: viewportBounds(-3, -6, 13, 26),
        prefetch: viewportBounds(-2, -4, 12, 24),
      });
    }
    expect(directionalBuffers([])).toEqual({ fetched: [], prefetch: [] });
  });

  it.each([
    [0, 10, 0, 2], [0, -10, 0, -2], [10, 0, 1, 0], [-10, 0, -1, 0],
    [3, 8, .6, 1.6], [-3, 8, -.6, 1.6], [3, -8, .6, -1.6], [-3, -8, -.6, -1.6],
    [10, 20, Math.SQRT1_2, 2 * Math.SQRT1_2],
  ])('normalizes movement (%s, %s) by query dimensions', (dx, dy, x, y) => {
    const anchor = viewportBounds(-dx, -dy, 10 - dx, 20 - dy);
    const { fetched, prefetch } = directionalBuffers(query, anchor);
    const expected = viewportBounds(-3 + x, -6 + y, 13 + x, 26 + y)[0];
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(fetched[0][key]).toBeCloseTo(expected[key]);
    expect(prefetch[0].minX - fetched[0].minX).toBeCloseTo(1);
    expect(fetched[0].maxX - prefetch[0].maxX).toBeCloseTo(1);
    expect(prefetch[0].minY - fetched[0].minY).toBeCloseTo(2);
    expect(fetched[0].maxY - prefetch[0].maxY).toBeCloseTo(2);
    expect(containsPrefetchBounds(prefetch, query)).toBe(true);
    expect(containsBounds(fetched, prefetch)).toBe(true);
  });

  it('varies continuously across angles and keeps the entire query inside both buffers', () => {
    for (let angle = 0; angle < Math.PI * 2; angle += .07) {
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const { fetched, prefetch } = directionalBuffers(query, viewportBounds(-dx * 10, -dy * 20, 10 - dx * 10, 20 - dy * 20));
      expect((prefetch[0].minX + prefetch[0].maxX) / 2).toBeCloseTo(5 + dx);
      expect((prefetch[0].minY + prefetch[0].maxY) / 2).toBeCloseTo(10 + dy * 2);
      expect(containsPrefetchBounds(prefetch, query)).toBe(true);
      expect(containsBounds(fetched, prefetch)).toBe(true);
    }
  });

  it('reverses the offset when movement reverses', () => {
    expect(directionalBuffers(query, viewportBounds(10, 0, 20, 20))).toEqual({
      fetched: viewportBounds(-4, -6, 12, 26), prefetch: viewportBounds(-3, -4, 11, 24),
    });
  });

  it('uses the latest query dimensions when movement and zoom happen together', () => {
    const { fetched, prefetch } = directionalBuffers(query, viewportBounds(-8, -3, 12, 7));
    // Centers move by (3, 8); the latest (10, 20) dimensions give direction (.6, .8).
    expect(fetched[0].minX).toBeCloseTo(-2.4);
    expect(fetched[0].minY).toBeCloseTo(-4.4);
    expect(prefetch[0].maxX).toBeCloseTo(12.6);
    expect(prefetch[0].maxY).toBeCloseTo(25.6);
  });

  it.each([170, -190, 530])('uses shortest longitude movement and splits after translation in world %s', (west) => {
    const current = viewportBounds(west + 10, -20, west + 30, 20);
    expect(directionalBuffers(current, viewportBounds(west, -20, west + 20, 20))).toEqual({
      fetched: viewportBounds(west + 6, -32, west + 38, 32),
      prefetch: viewportBounds(west + 8, -28, west + 36, 28),
    });
    expect(directionalBuffers(viewportBounds(west, -20, west + 20, 20), current)).toEqual({
      fetched: viewportBounds(west - 8, -32, west + 24, 32),
      prefetch: viewportBounds(west - 6, -28, west + 22, 28),
    });
  });

  it('translates before latitude clamping at either pole', () => {
    expect(directionalBuffers(viewportBounds(0, 80, 10, 90), viewportBounds(0, 75, 10, 85))).toEqual({
      fetched: viewportBounds(-3, 78, 13, 94), prefetch: viewportBounds(-2, 79, 12, 93),
    });
    expect(directionalBuffers(viewportBounds(0, -90, 10, -80), viewportBounds(0, -85, 10, -75))).toEqual({
      fetched: viewportBounds(-3, -94, 13, -78), prefetch: viewportBounds(-2, -93, 12, -79),
    });
  });

  it('ignores full-world and zero-sized direction axes and normalizes the remaining axis', () => {
    expect(directionalBuffers(viewportBounds(-180, 0, 180, 20), viewportBounds(10, -10, 20, 10))).toEqual({
      fetched: viewportBounds(-180, -4, 180, 28), prefetch: viewportBounds(-180, -2, 180, 26),
    });
    expect(directionalBuffers(query, [WORLD])).toEqual({
      fetched: viewportBounds(-3, -4, 13, 28), prefetch: viewportBounds(-2, -2, 12, 26),
    });
    expect(directionalBuffers(viewportBounds(0, 0, 0, 20), viewportBounds(-10, -10, 0, 10))).toEqual({
      fetched: viewportBounds(0, -4, 0, 28), prefetch: viewportBounds(0, -2, 0, 26),
    });
    expect(directionalBuffers(viewportBounds(0, 0, 10, 0), viewportBounds(-10, -10, 0, -10))).toEqual({
      fetched: viewportBounds(-2, 0, 14, 0), prefetch: viewportBounds(-1, 0, 13, 0),
    });
    const point = viewportBounds(10, 50, 10, 50);
    expect(directionalBuffers(point, query)).toEqual({ fetched: point, prefetch: point });
    expect(directionalBuffers([WORLD], query)).toEqual({ fetched: [WORLD], prefetch: [WORLD] });
  });
});

describe('prefetch containment', () => {
  const active = viewportBounds(0, 50, 10, 60);
  const prefetch = expandBounds(active, 0.2);

  it.each([
    [-2, 50, 8, 60], [2, 50, 12, 60],
    [0, 48, 10, 58], [0, 52, 10, 62],
    [-2.5, 50, 7.5, 60], [2.5, 50, 12.5, 60],
    [0, 47.5, 10, 57.5], [0, 52.5, 10, 62.5],
    [-2, 48, 12, 62],
  ])('fetches at or beyond reachable edges (%s, %s, %s, %s)', (west, south, east, north) => {
    const moved = viewportBounds(west, south, east, north);
    expect(containsBounds(expandBounds(active), moved)).toBe(true);
    expect(containsPrefetchBounds(prefetch, moved)).toBe(false);
  });

  it('reuses movement and zoom strictly inside the boundary', () => {
    for (const bounds of [active, viewportBounds(-1.4, 48.6, 11.4, 61.4), viewportBounds(3, 53, 7, 57)]) {
      expect(containsPrefetchBounds(prefetch, bounds)).toBe(true);
    }
    expect(containsPrefetchBounds([], active)).toBe(false);
    expect(containsPrefetchBounds(prefetch, [])).toBe(false);
  });

  it.each([170, -190, 530])('ignores the date-line seam in world %s but detects actual edges', (west) => {
    const boundary = expandBounds(viewportBounds(west, -20, west + 20, 20), 0.2);
    expect(boundary).toEqual(viewportBounds(166, -28, 194, 28));
    expect(containsPrefetchBounds(boundary, viewportBounds(west + 2, -20, west + 22, 20))).toBe(true);
    expect(containsPrefetchBounds(boundary, viewportBounds(west + 4, -20, west + 24, 20))).toBe(false);
    expect(containsPrefetchBounds(boundary, viewportBounds(west - 4, -20, west + 16, 20))).toBe(false);
    expect(containsPrefetchBounds(boundary, viewportBounds(-180, -20, -175, 20))).toBe(true);
  });

  it('ignores full-world longitude edges and clamped latitude edges, retaining reachable edges', () => {
    expect(containsPrefetchBounds([WORLD], [WORLD])).toBe(true);
    expect(containsPrefetchBounds([WORLD], viewportBounds(530, -90, 550, 90))).toBe(true);
    const wide = expandBounds(viewportBounds(-150, -20, 150, 20), 0.2);
    expect(containsPrefetchBounds(wide, viewportBounds(-400, -20, 400, 20))).toBe(true);
    expect(containsPrefetchBounds(wide, viewportBounds(-180, -28, 180, 20))).toBe(false);
    const north = expandBounds(viewportBounds(0, 80, 10, 90), 0.2);
    expect(containsPrefetchBounds(north, viewportBounds(0, 81, 10, 90))).toBe(true);
    expect(containsPrefetchBounds(north, viewportBounds(0, 78, 10, 90))).toBe(false);
    const south = expandBounds(viewportBounds(0, -90, 10, -80), 0.2);
    expect(containsPrefetchBounds(south, viewportBounds(0, -90, 10, -81))).toBe(true);
    expect(containsPrefetchBounds(south, viewportBounds(0, -90, 10, -78))).toBe(false);
  });

  it.each([
    [0, 50, 0, 50], [180, 50, 180, 60], [0, 50, 10, 50], [0, 90, 10, 90],
    [0, 50, 1e-8, 50 + 1e-8], [0, 50, 1e-10, 50 + 1e-10],
  ])('reuses stationary degenerate and tiny bounds (%s, %s, %s, %s)', (west, south, east, north) => {
    const bounds = viewportBounds(west, south, east, north);
    expect(containsPrefetchBounds(expandBounds(bounds, 0.2), bounds)).toBe(true);
  });
});
