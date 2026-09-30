// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { openPak } from '../bundle/pak-reader.mjs';

// A pak in the layout tools/browser/make_pak.py writes, served by a fake
// fetch that honours Range requests and counts them.
// Python's lzma, as tools/browser/make_pak.py --lzma uses it.
function lzmaAlone(raw) {
  const py = 'import sys,lzma; sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(), format=lzma.FORMAT_ALONE))';
  return new Uint8Array(spawnSync('python3', ['-c', py], { input: Buffer.from(raw) }).stdout);
}

function makePak(bytes, blockBytes, coreEnd = bytes.length, version = 1) {
  const blocks = [];
  for (let start = 0; start < bytes.length; start += blockBytes) {
    const raw = bytes.subarray(start, start + blockBytes);
    const packed = version === 2 ? lzmaAlone(raw) : deflateRawSync(raw);
    blocks.push({ stored: packed.length < raw.length ? packed : raw, raw: raw.length });
  }
  const indexStart = 48;
  let offset = indexStart + blocks.length * 16;
  const head = new DataView(new ArrayBuffer(offset));
  new Uint8Array(head.buffer).set([77, 80, 65, 75]); // MPAK
  head.setUint32(4, version, true);
  head.setUint32(8, blockBytes, true);
  head.setUint32(12, blocks.length, true);
  head.setBigUint64(16, BigInt(bytes.length), true);
  head.setUint32(24, coreEnd, true);
  new Uint8Array(head.buffer, 32, 16).fill(7);
  blocks.forEach((b, n) => {
    head.setBigUint64(indexStart + n * 16, BigInt(offset), true);
    head.setUint32(indexStart + n * 16 + 8, b.stored.length, true);
    head.setUint32(indexStart + n * 16 + 12, b.raw, true);
    offset += b.stored.length;
  });
  const pak = new Uint8Array(offset);
  pak.set(new Uint8Array(head.buffer));
  let at = head.byteLength;
  for (const b of blocks) { pak.set(b.stored, at); at += b.stored.length; }
  return pak;
}

function server(pak, { honourRange = true } = {}) {
  const requests = [];
  const fetchImpl = async (url, { headers }) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    requests.push([+a, +b]);
    if (!honourRange) return new Response(pak, { status: 200 });
    return new Response(pak.slice(+a, +b + 1), { status: 206 });
  };
  return { fetchImpl, requests };
}

const disc = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 13 === 0 ? i & 255 : 0);

test('reads across compressed and stored blocks match the source bytes', async () => {
  const pak = await openPak('http://x/melee.pak', { ...server(makePak(disc, 64)), cacheStorage: null });
  assert.equal(pak.size, 1000);
  assert.deepEqual(await pak.read(5, 200), disc.slice(5, 205));
  assert.deepEqual(await pak.read(960, 40), disc.slice(960));
  assert(pak.read(10, 20) instanceof Uint8Array); // resident: no suspension
  assert.throws(() => pak.read(990, 11), /bounds/);
});

test('contiguous misses share one range request; the LRU stays bounded', async () => {
  const s = server(makePak(disc, 64));
  const pak = await openPak('http://x/melee.pak', { ...s, cacheStorage: null, memoryBytes: 128 });
  const before = s.requests.length;
  await pak.read(0, 400);
  assert.equal(s.requests.length - before, 1);
  assert(pak.residentBytes <= 128);
  await Promise.all([pak.read(600, 10), pak.read(605, 10)]);
  assert.equal(s.requests.length - before, 2);
});

test('a server without Range support still works: the pak is downloaded once, whole', async () => {
  const s = server(makePak(disc, 64), { honourRange: false });
  let told = 0;
  const pak = await openPak('http://x/melee.pak', { ...s, cacheStorage: null, onWholeDownload: () => told++ });
  assert.deepEqual(await pak.read(100, 700), disc.slice(100, 800));
  assert.deepEqual(await pak.read(0, 1000), disc);
  assert.equal(s.requests.length, 1);
  assert.equal(told, 1);
});

test('version 2 paks decode their blocks with LZMA', async () => {
  const pak = await openPak('http://x/melee.pak', { ...server(makePak(disc, 64, disc.length, 2)), cacheStorage: null });
  assert.deepEqual(await pak.read(0, 1000), disc);
  assert.deepEqual(await pak.read(333, 222), disc.slice(333, 555));
});

test('persistent cache serves blocks on a second open and prefetch fills it', async () => {
  const entries = new Map();
  const cache = {
    put: async (key, response) => { entries.set(key, new Uint8Array(await response.arrayBuffer())); },
    match: async (key) => (entries.has(key) ? new Response(entries.get(key)) : undefined),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
  };
  const cacheStorage = { open: async () => cache, keys: async () => ['melee-pak-old'], delete: async () => true };
  const bytes = makePak(disc, 64);
  const first = await openPak('http://x/melee.pak', { ...server(bytes), cacheStorage });
  assert.equal(await first.prefetch(), 1);
  assert.equal(entries.size, 16);
  const s = server(bytes);
  const second = await openPak('http://x/melee.pak', { ...s, cacheStorage });
  const opened = s.requests.length;
  assert.deepEqual(await second.read(100, 700), disc.slice(100, 800));
  assert.equal(s.requests.length, opened); // every block came from the cache
});

test('reads of streamed data past coreEnd fetch the following blocks in the background', async () => {
  const s = server(makePak(disc, 64, 512));
  const pak = await openPak('http://x/melee.pak', { ...s, cacheStorage: null, readAheadBlocks: 2 });
  await pak.read(0, 10); // core: no read-ahead
  const core = s.requests.length;
  await pak.read(520, 10); // block 8, past coreEnd
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(s.requests.length > core + 1);
  const before = s.requests.length;
  assert(pak.read(600, 40) instanceof Uint8Array); // blocks 9-10 are already resident
  assert.deepEqual(pak.read(600, 40), disc.slice(600, 640));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(s.requests.length >= before);
});
