// SPDX-License-Identifier: GPL-3.0-or-later
// Fills the Cache API with melee.pak blocks for pak-reader.mjs's prefetch(),
// off the thread the game runs on: downloading, slicing and cache writes on
// the page's main thread cost frames. Waits while `busy` (shared with the
// page) says the game is blocked on a read, so it never competes with one.
self.onmessage = async ({ data: { url, cache: name, keyPrefix, busy, runs } }) => {
  try {
    const cache = await caches.open(name);
    let block = 0;
    for (const run of runs) {
      while (Atomics.load(busy, 0) > 0) await new Promise((resolve) => setTimeout(resolve, 50));
      const response = await fetch(url, { headers: { Range: `bytes=${run.start}-${run.end - 1}` } });
      if (response.status !== 206) throw Error(`melee.pak prefetch: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let at = 0;
      await Promise.all(run.sizes.map((size, k) => {
        const piece = bytes.subarray(at, at + size);
        at += size;
        return cache.put(keyPrefix + (run.first + k), new Response(piece));
      }));
      block += run.sizes.length;
      self.postMessage({ blocks: run.sizes.length });
    }
    self.postMessage({ done: block });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
