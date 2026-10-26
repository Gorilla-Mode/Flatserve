import { serialize } from 'flatgeobuf/geojson';
import type { Feature, Point } from 'geojson';

export const station = (name: string, x = 8): Feature<Point> => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [x, 58.15] },
  properties: { brannvesen: name },
});

export function encoded(features = [station('Oslo'), station('Kristiansand – Sør'), station('Oslo', 10)]): Uint8Array {
  return serialize({ type: 'FeatureCollection', features }, 4326);
}

export function headerOnly(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0, 12 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true));
}

export function chunked(bytes: Uint8Array, size = 7): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(offset, offset + size)); offset += size; }
    },
  }));
}
