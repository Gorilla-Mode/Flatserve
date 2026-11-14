import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { deserialize } from 'flatgeobuf/geojson';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { HeaderMeta } from '../src/api';

let folder: string;
let base: string;
const servers: ChildProcess[] = [];
const dll = resolve('../Flatserve/bin/Debug/net10.0/Flatserve.dll');

async function launch(directory: string, attributes = ['brannvesen', 'department']) {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done) => socket.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('dotnet', [dll, '--urls', url], {
    cwd: resolve('../Flatserve'),
    env: { ...process.env, Fgb__Directory: directory,
      ...Object.fromEntries(attributes.map((attribute, index) => [`Fgb__TextIndexes__${index}`, attribute])),
      ASPNETCORE_ENVIRONMENT: 'Development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  let output = '';
  child.stdout!.on('data', (data) => { output += data; });
  child.stderr!.on('data', (data) => { output += data; });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    child.stdout!.on('data', () => {
      if (output.includes('Now listening on:')) { clearTimeout(timer); done(); }
    });
  });
  return url;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'flatserve-layers-'));
  const original = await readFile(resolve('../Flatserve/test/fgb/Samfunnssikkerhet_0000_Norge_25833_Brannstasjoner_GML.fgb'));
  // Rename one header column without touching features or spatial-index offsets.
  // The fixtures deliberately have different schemas but identical geometry.
  const second = Buffer.from(original);
  const headerEnd = 12 + second.readUInt32LE(8);
  const columnOffset = second.subarray(12, headerEnd).indexOf('brannvesen') + 12;
  expect(columnOffset).toBeGreaterThan(12);
  second.write('department', columnOffset);
  await writeFile(join(folder, 'a.fgb'), original);
  await writeFile(join(folder, 'b.Øst.fgb'), second);
  base = await launch(folder);
}, 15_000);

afterAll(async () => {
  await Promise.all(servers.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function decode(bytes: Uint8Array) {
  let header: HeaderMeta | undefined;
  const features = [];
  // FlatBuffers typed arrays require an aligned buffer rather than a multipart slice.
  for await (const feature of deserialize(new Uint8Array(bytes), { headerMetaFn: (value) => { header = value; } })) features.push(feature);
  return { header: header!, features };
}

async function parts(path: string) {
  const response = await fetch(base + path);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^multipart\/mixed; boundary=/);
  const boundary = response.headers.get('content-type')!.split('boundary=')[1].replaceAll('"', '');
  // Parse binary buffers directly: UTF-8 conversion would corrupt FGB payloads.
  const bytes = Buffer.from(await response.arrayBuffer());
  const delimiter = Buffer.from(`--${boundary}`);
  const results = [];
  let offset = 0;
  while (true) {
    expect(bytes.subarray(offset, offset + delimiter.length).equals(delimiter)).toBe(true);
    offset += delimiter.length;
    if (bytes.subarray(offset, offset + 2).toString() === '--') break;
    const headerEnd = bytes.indexOf('\r\n\r\n', offset);
    const headers = bytes.subarray(offset, headerEnd).toString();
    expect(headers).toContain('Content-Type: application/vnd.fgb');
    const filename = decodeURIComponent(headers.match(/filename\*=utf-8''([^\r\n;]+)/i)![1]);
    const end = bytes.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4);
    results.push({ filename, ...await decode(bytes.subarray(headerEnd + 4, end)) });
    offset = end + 2;
  }
  expect(results.map((part) => part.filename)).toEqual(['a.fgb', 'b.Øst.fgb']);
  return results;
}

const collection = '/fgb/collection?userId=2&minX=4&minY=58&maxX=32&maxY=72';

it('reports only built indexes and their actual distinct values per layer', async () => {
  const response = await fetch(base + '/fgb/indexes');
  expect(response.status).toBe(200);
  const metadata = await response.json();
  expect(metadata.layers.map((layer: { id: string; indexes: { attribute: string }[] }) => [layer.id, layer.indexes.map((index) => index.attribute)]))
    .toEqual([['a', ['brannvesen']], ['b.Øst', ['department']]]);
  const values = metadata.layers[0].indexes[0].values as string[];
  expect(values).toContain('Oslo brann- og redningsetat');
  expect(values).toEqual([...new Set(values)].sort());
  expect(metadata.layers[1].indexes[0].values).toEqual(values);
  const noIndexes = await launch(folder, ['not-a-column']);
  expect((await (await fetch(noIndexes + '/fgb/indexes')).json()).layers
    .every((layer: { indexes: unknown[] }) => layer.indexes.length === 0)).toBe(true);
});

it('exports independently decodable layers with their own schemas', async () => {
  const layers = await parts(collection);
  expect(layers.map((layer) => layer.features.length)).toEqual([639, 639]);
  expect(layers[0].features[0].properties).toHaveProperty('brannvesen');
  expect(layers[1].features[0].properties).toHaveProperty('department');
  for (const layer of layers) expect(layer.header.indexNodeSize).toBe(0);
});

it('filters and authorizes each layer independently, including empty results', async () => {
  const filter = '/fgb/filter?attribute=brannvesen&value=Oslo%20brann-%20og%20redningsetat';
  expect((await parts(filter)).map((layer) => layer.features.length)).toEqual([7, 0]);
  expect((await parts(filter.replace('brannvesen&', 'department&'))).map((layer) => layer.features.length)).toEqual([0, 7]);
  expect((await parts(collection.replace('userId=2', 'userId=1'))).map((layer) => layer.features.length)).toEqual([10, 10]);
  expect((await parts('/fgb/collection?userId=2&minX=-1&minY=-1&maxX=1&maxY=1'))
    .map((layer) => layer.features.length)).toEqual([0, 0]);
});

it('supports layer routes and rejects unknown layers, invalid queries, and ambiguous features', async () => {
  const response = await fetch(base + '/fgb/b.%C3%98st/feature/0');
  expect(response.headers.get('content-type')).toContain('application/vnd.fgb');
  expect((await decode(new Uint8Array(await response.arrayBuffer()))).features).toHaveLength(1);
  for (const [path, status] of [
    ['/fgb/missing/feature/0', 404], ['/fgb/a/feature/639', 404],
    ['/fgb/feature/0', 400], ['/fgb/collection', 400],
    ['/fgb/collection?userId=2&minX=20&minY=0&maxX=10&maxY=10', 400],
    [collection.replace('/collection', '/missing/collection'), 404],
  ] as const) expect((await fetch(base + path)).status).toBe(status);
});

it('keeps concurrent requests isolated', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => parts(collection)));
  for (const layers of results) expect(layers.map((layer) => layer.features.length)).toEqual([639, 639]);
});

it('fails startup for empty, missing, corrupt, or duplicate layer inputs', async () => {
  const empty = join(folder, 'empty');
  await mkdir(empty);
  await expect(launch(empty)).rejects.toThrow('contains no .fgb files');
  await expect(launch(join(folder, 'missing'))).rejects.toThrow();
  await writeFile(join(empty, 'broken.fgb'), 'invalid');
  await expect(launch(empty)).rejects.toThrow('Unable to load FGB layer');
  const duplicate = join(folder, 'duplicates');
  await mkdir(duplicate);
  await writeFile(join(duplicate, 'a.fgb'), await readFile(join(folder, 'a.fgb')));
  await writeFile(join(duplicate, 'a.FGB'), await readFile(join(folder, 'a.fgb')));
  // Case-insensitive filesystems cannot create these two distinct filenames.
  if ((await readdir(duplicate)).length === 2)
    await expect(launch(duplicate)).rejects.toThrow('duplicate FGB layer ID');
});
