import { describe, expect, it } from 'vitest';
import type { Geometry, Position } from 'geojson';
import { geometryIntersectsBounds } from './geometry';
import { viewportBounds } from './bounds';

const bounds = viewportBounds(0, 0, 10, 10);
const ring = (min: number, max: number): Position[] => [[min, min], [max, min], [max, max], [min, max], [min, min]];
const point = (x: number, y = x): Geometry => ({ type: 'Point', coordinates: [x, y] });

describe('geometry/viewport intersection', () => {
  const cases: [string, Geometry | null, boolean][] = [
    ['point inside', point(5), true],
    ['point outside', point(11), false],
    ['point on corner', point(0, 10), true],
    ['point with elevation', { type: 'Point', coordinates: [5, 5, 1000] }, true],
    ['multipoint with a visible member', { type: 'MultiPoint', coordinates: [[20, 20], [5, 5]] }, true],
    ['multipoint outside', { type: 'MultiPoint', coordinates: [[20, 20], [-1, -1]] }, false],
    ['line inside', { type: 'LineString', coordinates: [[2, 2], [8, 8]] }, true],
    ['line crossing with both endpoints outside', { type: 'LineString', coordinates: [[-5, 5], [15, 5]] }, true],
    ['vertical crossing', { type: 'LineString', coordinates: [[5, -5], [5, 15]] }, true],
    ['line touching a corner', { type: 'LineString', coordinates: [[-1, 1], [1, -1]] }, true],
    ['line along a boundary', { type: 'LineString', coordinates: [[0, -5], [0, 15]] }, true],
    ['line whose envelope overlaps but misses', { type: 'LineString', coordinates: [[-5, 1], [1, -5]] }, false],
    ['parallel line outside', { type: 'LineString', coordinates: [[-1, 0], [-1, 10]] }, false],
    ['collapsed segment inside', { type: 'LineString', coordinates: [[5, 5], [5, 5]] }, true],
    ['collapsed segment outside', { type: 'LineString', coordinates: [[11, 11], [11, 11]] }, false],
    ['multiline crossing in later member', { type: 'MultiLineString', coordinates: [[[20, 20], [30, 30]], [[-5, 5], [15, 5]]] }, true],
    ['multiline outside', { type: 'MultiLineString', coordinates: [[[20, 20], [30, 30]], [[-5, 1], [1, -5]]] }, false],
    ['polygon inside viewport', { type: 'Polygon', coordinates: [ring(2, 8)] }, true],
    ['polygon enclosing viewport', { type: 'Polygon', coordinates: [ring(-5, 15)] }, true],
    ['polygon crossing viewport', { type: 'Polygon', coordinates: [[[-5, 4], [15, 4], [15, 6], [-5, 6], [-5, 4]]] }, true],
    ['polygon outside', { type: 'Polygon', coordinates: [ring(11, 20)] }, false],
    ['polygon touching corner', { type: 'Polygon', coordinates: [ring(10, 20)] }, true],
    ['viewport entirely in polygon hole', { type: 'Polygon', coordinates: [ring(-10, 20), ring(-1, 11)] }, false],
    ['viewport touching hole boundary', { type: 'Polygon', coordinates: [ring(-10, 20), ring(0, 11)] }, true],
    ['hole inside viewport', { type: 'Polygon', coordinates: [ring(-10, 20), ring(2, 8)] }, true],
    ['viewport in filled part beside hole', { type: 'Polygon', coordinates: [ring(-10, 30), ring(15, 20)] }, true],
    ['reversed rings', { type: 'Polygon', coordinates: [ring(-10, 20).reverse(), ring(-1, 11).reverse()] }, false],
    ['multipolygon with visible later member', { type: 'MultiPolygon', coordinates: [[ring(20, 30)], [ring(2, 8)]] }, true],
    ['multipolygon outside or in hole', { type: 'MultiPolygon', coordinates: [[ring(20, 30)], [ring(-10, 20), ring(-1, 11)]] }, false],
    ['collection with crossing line', { type: 'GeometryCollection', geometries: [point(20), { type: 'LineString', coordinates: [[-5, 5], [15, 5]] }] }, true],
    ['nested collection with polygon', { type: 'GeometryCollection', geometries: [{ type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [ring(-5, 15)] }] }] }, true],
    ['collection outside', { type: 'GeometryCollection', geometries: [point(20), { type: 'Polygon', coordinates: [ring(20, 30)] }] }, false],
    ['null geometry', null, false],
    ['empty point', { type: 'Point', coordinates: [] }, false],
    ['empty multipoint', { type: 'MultiPoint', coordinates: [] }, false],
    ['empty line', { type: 'LineString', coordinates: [] }, false],
    ['empty multiline', { type: 'MultiLineString', coordinates: [[], []] }, false],
    ['empty polygon', { type: 'Polygon', coordinates: [] }, false],
    ['empty polygon ring', { type: 'Polygon', coordinates: [[]] }, false],
    ['empty multipolygon', { type: 'MultiPolygon', coordinates: [[], [[]]] }, false],
    ['empty collection', { type: 'GeometryCollection', geometries: [] }, false],
    ['collection of empty members', { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [] }, { type: 'Point', coordinates: [] }] }, false],
  ];

  it.each(cases)('%s', (_name, geometry, expected) => {
    expect(geometryIntersectsBounds(geometry, bounds)).toBe(expected);
  });

  it('handles concavity rather than accepting the polygon envelope', () => {
    const polygon: Geometry = { type: 'Polygon', coordinates: [
      [[-2, -2], [12, -2], [12, 12], [11, 12], [11, -1], [-1, -1], [-1, 12], [-2, 12], [-2, -2]],
    ] };
    expect(geometryIntersectsBounds(polygon, bounds)).toBe(false);
  });

  it.each<Geometry>([
    point(175, 5), point(-175, 5), point(180, 5), point(-180, 5), point(535, 5),
    { type: 'MultiPoint', coordinates: [[0, 5], [-175, 5]] },
    { type: 'LineString', coordinates: [[160, 5], [179, 5]] },
    { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[-179, 5], [-160, 5]]] },
    { type: 'Polygon', coordinates: [[[-179, -5], [-160, -5], [-160, 15], [-179, 15], [-179, -5]]] },
    { type: 'MultiPolygon', coordinates: [[[[171, -5], [179, -5], [179, 15], [171, 15], [171, -5]]]] },
    { type: 'GeometryCollection', geometries: [point(0, 5), point(-175, 5)] },
  ])('checks both rectangles of a split viewport for $type', (geometry) => {
    expect(geometryIntersectsBounds(geometry, viewportBounds(170, 0, 190, 10))).toBe(true);
    expect(geometryIntersectsBounds(geometry, [])).toBe(false);
  });

  it('does not fill the gap between split viewport rectangles', () => {
    const split = viewportBounds(170, 0, 190, 10);
    expect(geometryIntersectsBounds(point(0, 5), split)).toBe(false);
    expect(geometryIntersectsBounds({ type: 'LineString', coordinates: [[-10, 5], [10, 5]] }, split)).toBe(false);
    expect(geometryIntersectsBounds({ type: 'Polygon', coordinates: [ring(0, 10)] }, split)).toBe(false);
  });
});
