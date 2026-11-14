export interface FgbPart { id: string; bytes: Uint8Array<ArrayBuffer> }

/** Buffer multipart bodies as binary data; never convert FGB payloads to text. */
export async function readFgbParts(response: Response, signal: AbortSignal): Promise<FgbPart[]> {
  const boundary = response.headers.get('content-type')?.match(/boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i);
  const name = boundary?.[1] ?? boundary?.[2];
  if (!name || name.length > 70) throw new Error('Invalid multipart boundary.');
  if (!response.body) throw new Error('The API returned no response stream.');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  const encode = (text: string) => new TextEncoder().encode(text);
  const delimiter = encode(`--${name}`);
  const separator = encode('\r\n\r\n');
  const next = encode(`\r\n--${name}`);
  function matches(offset: number, needle: Uint8Array) {
    return needle.every((byte, index) => bytes[offset + index] === byte);
  }
  function find(needle: Uint8Array, start: number) {
    for (let offset = start; offset <= bytes.length - needle.length; offset++)
      if (bytes[offset] === needle[0] && matches(offset, needle)) return offset;
    throw new Error('Truncated multipart response.');
  }
  const parts: FgbPart[] = [];
  const ids = new Set<string>();
  position = 0;
  while (true) {
    signal.throwIfAborted();
    if (!matches(position, delimiter)) throw new Error('Invalid multipart delimiter.');
    position += delimiter.length;
    if (matches(position, encode('--'))) break;
    if (!matches(position, encode('\r\n'))) throw new Error('Invalid multipart headers.');
    position += 2;
    const headerEnd = find(separator, position);
    const headers = new Headers();
    for (const line of new TextDecoder().decode(bytes.subarray(position, headerEnd)).split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('Invalid multipart headers.');
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/vnd.fgb')
      throw new Error('A multipart layer is not FlatGeobuf.');
    const disposition = headers.get('content-disposition') ?? '';
    const encodedName = disposition.match(/filename\*\s*=\s*utf-8''([^;\s]+)/i)?.[1];
    const filename = encodedName !== undefined ? decodeURIComponent(encodedName)
      : disposition.match(/filename\s*=\s*"([^"\r\n]+)"/i)?.[1]
        ?? disposition.match(/filename\s*=\s*([^;\s]+)/i)?.[1];
    if (!filename?.toLowerCase().endsWith('.fgb')) throw new Error('A multipart layer has no FGB filename.');
    const id = filename.slice(0, -4);
    if (!id || ids.has(id)) throw new Error('Invalid or duplicate multipart layer ID.');
    ids.add(id);
    const end = find(next, headerEnd + separator.length);
    // Copy to a fresh, aligned buffer for FlatBuffers typed-array access.
    parts.push({ id, bytes: bytes.slice(headerEnd + separator.length, end) });
    position = end + 2;
  }
  if (!parts.length) throw new Error('The API returned no FGB layers.');
  return parts;
}
