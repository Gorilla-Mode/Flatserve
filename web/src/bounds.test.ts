import { describe, expect, it } from 'vitest';
import { viewportBounds } from './bounds';

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
