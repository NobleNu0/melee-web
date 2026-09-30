// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reads melee.pak (tools/browser/make_pak.py) as the disc behind Module.readDisc.
 *
 * Blocks are fetched with HTTP Range requests only when a read needs them,
 * contiguous misses in one request, and inflated with DecompressionStream.
 * Compressed blocks are kept in the Cache API under the pak's content id, so a
 * second visit reads from disk and a rebuilt pak never mixes with an old one;
 * inflated blocks are kept in a bounded in-memory LRU.
 *
 * read(offset, size) has disc-cache.mjs's contract: a Uint8Array when every
 * block is resident in memory, so a hit never suspends the wasm, and a Promise
 * of one otherwise. A miss stalls the game for a round trip, so the two ways
 * data arrives ahead of need both stay off the game's thread: prefetch() fills
 * the cache from a worker, and reads of streamed music (past coreEnd) fetch
 * the blocks after them in the background.
 */
import { decodeLzmaAlone } from './lzma.mjs';

const HEADER_SIZE = 48;
const INDEX_ENTRY = 16;
const CACHE_PREFIX = 'melee-pak-';

// LZMA blocks decode in JavaScript: on the page's thread a 256 KiB block
// stalls the game for 10-20 ms, so a small worker pool decodes them, several
// blocks of one read in parallel. Falls back to decoding inline where there
// are no module workers (node tests).
function createDecoderPool(size) {
  if (typeof Worker === 'undefined' || size < 1) return null;
  const workers = [];
  const waiting = new Map();
  let next = 0;
  let id = 0;
  for (let i = 0; i < size; i++) {
    const worker = new Worker(new URL('./lzma.worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) job.reject(Error(data.error));
      else job.resolve(data.out);
    };
    workers.push(worker);
  }
  return (stored, raw) => new Promise((resolve, reject) => {
    const job = ++id;
    waiting.set(job, { resolve, reject });
    // The stored bytes are a slice of their own; hand them over, no copy.
    workers[next++ % workers.length].postMessage({ id: job, stored, raw }, [stored.buffer]);
  });
}

export async function openPak(url, {
  fetchImpl = globalThis.fetch.bind(globalThis),
  cacheStorage = globalThis.caches,
  memoryBytes = 96 * 1024 * 1024,
  maxRequestBytes = 8 * 1024 * 1024,
  readAheadBlocks = 2,
  useWorker = typeof Worker !== 'undefined',
  onWholeDownload = () => {},
  decoderWorkers = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2)),
} = {}) {
  // A host that ignores Range answers with the whole file. Keep that one
  // download and serve every later range from it rather than failing: the
  // game then waits for the whole pak once, instead of streaming it.
  let whole = null;
  async function range(start, end) {
    if (whole) return whole.slice(start, end);
    const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (response.status === 200) {
      onWholeDownload();
      whole = new Uint8Array(await response.arrayBuffer());
      return whole.slice(start, end);
    }
    if (response.status !== 206) {
      response.body?.cancel();
      throw Error(`melee.pak: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start) throw Error('melee.pak: short range response');
    return bytes;
  }

  const head = await range(0, HEADER_SIZE);
  const view = new DataView(head.buffer);
  const version = view.getUint32(4, true);
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'MPAK' || (version !== 1 && version !== 2)) {
    throw Error('melee.pak is not a version 1 or 2 pak: rebuild it with tools/browser/bundle.py.');
  }
  const blockBytes = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const size = Number(view.getBigUint64(16, true));
  const coreEnd = view.getUint32(24, true);
  const id = [...head.subarray(32, 48)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const indexBytes = await range(HEADER_SIZE, HEADER_SIZE + count * INDEX_ENTRY);
  const index = new DataView(indexBytes.buffer);
  const entry = (n) => ({
    offset: Number(index.getBigUint64(n * INDEX_ENTRY, true)),
    stored: index.getUint32(n * INDEX_ENTRY + 8, true),
    raw: index.getUint32(n * INDEX_ENTRY + 12, true),
  });

  let store = null;
  if (cacheStorage) {
    try {
      store = await cacheStorage.open(CACHE_PREFIX + id);
      for (const name of await cacheStorage.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_PREFIX + id) cacheStorage.delete(name);
      }
    } catch {
      store = null; // storage blocked (private window, quota): network only
    }
  }
  const base = new URL(url, globalThis.location?.href ?? 'http://localhost/');
  const key = (n) => new URL(`__pak/${id}/${n}`, base).href;

  let decodePool = null;
  const blocks = new Map(); // inflated, insertion order doubles as LRU order
  const pending = new Map(); // block -> promise of inflated bytes
  const stats = { fetchedBytes: 0, residentBytes: 0, foreground: 0 };
  // Nonzero while the game waits on the network; the prefetch worker backs off.
  const busy = globalThis.crossOriginIsolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
  const setForeground = (delta) => {
    stats.foreground += delta;
    if (busy) Atomics.store(busy, 0, stats.foreground);
  };

  // Split ascending block numbers into runs contiguous in the pak, each at
  // most maxRequestBytes (a lone larger block is still one run).
  function runs(numbers) {
    const out = [];
    for (let i = 0; i < numbers.length;) {
      let j = i;
      let bytes = entry(numbers[i]).stored;
      while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1 &&
             bytes + entry(numbers[j + 1]).stored <= maxRequestBytes) {
        bytes += entry(numbers[++j]).stored;
      }
      out.push([numbers[i], numbers[j]]);
      i = j + 1;
    }
    return out;
  }

  function remember(n, data) {
    blocks.delete(n);
    blocks.set(n, data);
    stats.residentBytes += data.length;
    while (stats.residentBytes > memoryBytes && blocks.size > 1) {
      const [oldest, evicted] = blocks.entries().next().value;
      blocks.delete(oldest);
      stats.residentBytes -= evicted.length;
    }
  }

  async function inflate(n, stored) {
    const { raw } = entry(n);
    if (stored.length === raw) return stored;
    if (version === 2) {
      decodePool ??= createDecoderPool(decoderWorkers) || ((bytes, size) => decodeLzmaAlone(bytes, size));
      return decodePool(stored, raw);
    }
    const stream = new Blob([stored]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    if (data.length !== raw) throw Error(`melee.pak: block ${n} inflated to ${data.length} bytes`);
    return data;
  }

  // Fetch blocks first..last (contiguous in the pak) in one request and
  // return their stored bytes; each is written to the persistent cache.
  // Foreground reads do not wait for those writes; prefetch does.
  async function fetchRun(first, last, { awaitStore = false } = {}) {
    const start = entry(first).offset;
    const bytes = await range(start, entry(last).offset + entry(last).stored);
    stats.fetchedBytes += bytes.length;
    const out = [];
    const writes = [];
    for (let n = first; n <= last; n++) {
      const { offset, stored } = entry(n);
      const piece = bytes.slice(offset - start, offset - start + stored);
      if (store) writes.push(store.put(key(n), new Response(piece)).catch(() => {}));
      out.push(piece);
    }
    if (awaitStore) await Promise.all(writes);
    return out;
  }

  // Resolve every missing block in `wanted` (ascending): cache first, then
  // the network in contiguous runs of at most maxRequestBytes.
  function load(wanted, { background = false } = {}) {
    const mine = wanted.filter((n) => !pending.has(n));
    if (mine.length) {
      const job = (async () => {
        const stored = new Map();
        if (store) {
          await Promise.all(mine.map(async (n) => {
            const hit = await store.match(key(n)).catch(() => undefined);
            if (hit) stored.set(n, new Uint8Array(await hit.arrayBuffer()));
          }));
        }
        const missing = mine.filter((n) => !stored.has(n));
        if (!background) setForeground(1);
        try {
          for (const [first, last] of runs(missing)) {
            (await fetchRun(first, last)).forEach((piece, k) => stored.set(first + k, piece));
          }
        } finally {
          if (!background) setForeground(-1);
        }
        const inflated = new Map();
        await Promise.all(mine.map(async (n) => inflated.set(n, await inflate(n, stored.get(n)))));
        for (const n of mine) remember(n, inflated.get(n));
        return inflated;
      })();
      for (const n of mine) {
        const one = job.then((all) => all.get(n));
        pending.set(n, one);
        one.catch(() => {}).finally(() => pending.delete(n));
      }
    }
    return Promise.all(wanted.map((n) => pending.get(n) ?? Promise.resolve(blocks.get(n))));
  }

  function read(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        offset + length > size) {
      throw Error('Disc read is out of bounds.');
    }
    if (!length) return new Uint8Array();
    const first = Math.floor(offset / blockBytes);
    const last = Math.floor((offset + length - 1) / blockBytes);
    if (offset >= coreEnd) readAhead(last);
    const resident = [];
    const missing = [];
    for (let n = first; n <= last; n++) {
      const data = blocks.get(n);
      if (data) {
        blocks.delete(n);
        blocks.set(n, data);
      } else {
        missing.push(n);
      }
      resident.push(data);
    }
    const combine = (values) => {
      const skip = offset - first * blockBytes;
      if (first === last) return values[0].subarray(skip, skip + length);
      const result = new Uint8Array(length);
      let written = 0;
      values.forEach((data, i) => {
        const start = i === 0 ? skip : 0;
        const n = Math.min(data.length - start, length - written);
        result.set(data.subarray(start, start + n), written);
        written += n;
      });
      return result;
    };
    if (!missing.length) return combine(resident);
    return load(missing).then((loaded) => {
      missing.forEach((n, i) => { resident[n - first] = loaded[i]; });
      return combine(resident);
    });
  }

  // Sequential streams (music) ask for the next blocks soon: start them now.
  function readAhead(last) {
    const next = [];
    for (let n = last + 1; n <= last + readAheadBlocks && n < count; n++) {
      if (!blocks.has(n) && !pending.has(n)) next.push(n);
    }
    if (next.length) load(next, { background: true }).catch(() => {});
  }

  /**
   * Copy blocks [0, end) into the persistent cache in the background, so later
   * scene loads never wait on the network. In a browser this runs in
   * pak-prefetch.worker.mjs, backing off while the game waits on a read;
   * resolves with the fraction cached (0 when there is no cache to fill).
   */
  async function prefetch({ end = coreEnd, onProgress = () => {} } = {}) {
    if (whole) return 1; // already all in memory
    if (!store) return 0;
    const last = Math.min(count, Math.ceil(end / blockBytes)) - 1;
    const have = new Set((await store.keys()).map((request) => request.url));
    const todo = [];
    for (let n = 0; n <= last; n++) if (!have.has(key(n))) todo.push(n);
    const total = last + 1;
    let done = total - todo.length;
    onProgress(done / total);
    const work = runs(todo);
    if (useWorker && busy) {
      const worker = new Worker(new URL('./pak-prefetch.worker.mjs', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.error) reject(Error(data.error));
          else if (data.blocks) onProgress((done += data.blocks) / total);
          else resolve();
        };
        worker.onerror = (event) => reject(Error(event.message || 'prefetch worker failed'));
        worker.postMessage({
          url: base.href, cache: CACHE_PREFIX + id, keyPrefix: key(''), busy,
          runs: work.map(([first, lastBlock]) => ({
            first, start: entry(first).offset, end: entry(lastBlock).offset + entry(lastBlock).stored,
            sizes: Array.from({ length: lastBlock - first + 1 }, (_, k) => entry(first + k).stored),
          })),
        });
      }).finally(() => worker.terminate());
      return done / total;
    }
    for (const [first, lastBlock] of work) {
      while (stats.foreground) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!pending.has(first)) await fetchRun(first, lastBlock, { awaitStore: true });
      done += lastBlock - first + 1;
      onProgress(done / total);
    }
    return done / total;
  }

  return { read, prefetch, size, coreEnd, id, stats, get residentBytes() { return stats.residentBytes; } };
}
