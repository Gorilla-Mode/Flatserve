import { describe, expect, it } from 'vitest';
import { insetBounds, viewportBounds } from './bounds';

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
