import { serialize } from 'flatgeobuf/geojson';
import type { Feature, Point } from 'geojson';

export const station = (name: string, x = 8): Feature<Point> => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [x, 58.15] },
  properties: { brannvesen: name },
});

export function encoded(features: Feature[] = [station('Oslo'), station('Kristiansand – Sør'), station('Oslo', 10)]): Uint8Array {
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

export function multipartEncoded(layers: { id: string; bytes: Uint8Array }[]): Uint8Array {
  const text = (value: string) => new TextEncoder().encode(value);
  const chunks = layers.flatMap(({ id, bytes }) => [
    text(`--fgb-test\r\nContent-Type: application/vnd.fgb\r\nContent-Disposition: attachment; filename="layer.fgb"; filename*=utf-8''${encodeURIComponent(id)}.fgb\r\n\r\n`),
    bytes, text('\r\n'),
  ]);
  chunks.push(text('--fgb-test--\r\n'));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function multipartResponse(layers: { id: string; bytes: Uint8Array }[], size = 7): Response {
  const response = chunked(multipartEncoded(layers), size);
  response.headers.set('Content-Type', 'multipart/mixed; boundary="fgb-test"');
  return response;
}
