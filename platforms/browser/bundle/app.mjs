// SPDX-License-Identifier: GPL-3.0-or-later
// Host page for the bundled web app: the disc is melee.pak next to this file
// (tools/browser/bundle.py), so there is no picker. Same Module interface as
// ../shell.mjs; see platforms/browser/README.md.
import { openPak } from './pak-reader.mjs';
import { checkGraphics } from './gpu-preflight.mjs';
import { startControllerView } from './controller-view.mjs';

const $ = (id) => document.getElementById(id);

// The bundle ships the engine and the shader seed gzipped (tools/browser/bundle.py)
// to stay small. A host that adds its own Content-Encoding hands the browser's
// already-inflated bytes to fetch, so inflate only when the gzip magic is there.
async function fetchGzipped(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
Error.stackTraceLimit = 64; // engine aborts log a stack; keep it whole
const params = new URLSearchParams(location.search);
const lines = [];
function log(text) {
  lines.push(String(text));
  if (lines.length > 400) lines.shift();
  $('log').textContent = lines.join('\n');
  console.log(text);
}
function status(text, { error = false } = {}) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function fail(error) {
  status(error.message || String(error), { error: true });
  $('progress').hidden = true;
  $('overlay').hidden = false;
  log(error.stack || error);
}

// Rolling frame statistics; also read by tests/browser/shell-e2e.mjs.
const frames = { count: 0, last: 0, samples: [] };
window.meleeFrames = frames;
function onFrame() {
  const now = performance.now();
  if (frames.last) {
    frames.samples.push(now - frames.last);
    if (frames.samples.length > 7200) frames.samples.shift();
  }
  frames.last = now;
  if (++frames.count % 30 === 0 && frames.samples.length > 60) {
    const recent = frames.samples.slice(-120);
    const fps = 1000 * recent.length / recent.reduce((a, b) => a + b, 0);
    $('stats').textContent = `${fps.toFixed(1)} fps`;
  }
}

// Any MELEE_* query parameter becomes an environment variable, as in shell.mjs,
// except the profile: melee.pak holds only what the VS-only profile reads.
const ENV = {};
for (const [key, value] of params) {
  if (/^MELEE_[A-Z0-9_]+$/.test(key)) ENV[key] = value;
}
ENV.MELEE_VS_ONLY = '1';
// ?res=1440x1080 renders above the default 960x720 (the canvas is its size).
const res = /^(\d{3,4})x(\d{3,4})$/.exec(params.get('res') || '');
if (res) Object.assign($('canvas'), { width: +res[1], height: +res[2] });

let runtimeReady = false;
let pak = null;
function updateStart() {
  $('start').disabled = !(runtimeReady && pak);
  if (runtimeReady && pak) {
    $('progress').hidden = true;
    status('Ready.');
    $('start').focus();
  }
}

window.Module = {
  preRun: [() => Object.assign(Module.ENV, ENV)],
  canvas: $('canvas'),
  print: log,
  printErr: log,
  onFrame,
  onAbort: (reason) => fail(Error(`Engine stopped: ${reason}`)),
  onGraphicsPreparation: (done, total) => {
    $('overlay').hidden = done === total;
    status(done === total ? 'Starting…' : `Preparing graphics… ${Math.floor(done * 100 / total)}%`);
  },
  onRuntimeInitialized: () => { runtimeReady = true; updateStart(); },
  // melee_browser.wasm.gz instead of Emscripten's own fetch of the plain file.
  instantiateWasm(imports, done) {
    fetchGzipped('./melee_browser.wasm.gz')
      .then((bytes) => WebAssembly.instantiate(bytes, imports))
      .then(({ instance, module }) => done(instance, module), fail);
    return {};
  },
};

function syncfs(populate) {
  return new Promise((resolve, reject) =>
    Module.FS.syncfs(populate, (error) => (error ? reject(error) : resolve())));
}

async function start() {
  $('start').disabled = true;
  status('Starting…');
  await checkGraphics();
  // Shader seed (tools/browser/bundle.py): aurora imports it into an empty
  // pipeline cache and compiles it all behind "Preparing graphics".
  const seed = await fetchGzipped('./initial_pipeline_cache.db.gz').catch(() => null);
  if (seed) Module.FS.writeFile('/initial_pipeline_cache.db', seed);
  Module.discFile = { size: pak.size }; // dvd.c bounds-checks reads against this
  Module.readDisc = pak.read;
  // Stateless: the memory card (/saves) lives in memory and is gone on reload.
  // Only compiled pipelines (/cache) persist, which is not game state.
  Module.FS.mkdirTree('/cache');
  Module.FS.mount(Module.FS.filesystems.IDBFS, {}, '/cache');
  await syncfs(true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncfs(false).catch(log);
  });
  $('overlay').hidden = true;
  $('canvas').focus();
  Module.callMain([]);
  if (params.get('prefetch') !== '0') {
    // Everything but the music, into the Cache API, so later scene loads never
    // wait on the network. Music streams from the pak as it plays.
    pak.prefetch({
      onProgress: (f) => { $('caching').textContent = f < 1 ? `caching ${Math.floor(f * 100)}%` : ''; },
    }).catch((error) => log(`prefetch: ${error.message}`));
  }
}
$('start').addEventListener('click', () => start().catch(fail));

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
  $('canvas').focus();
}
$('fullscreen').addEventListener('click', toggleFullscreen);
// The controls and live controller chips above the game.
startControllerView($('pad'));

async function boot() {
  if (!navigator.gpu) throw Error('This browser has no WebGPU. Use a current Chrome or Edge.');
  status('Loading…');
  const script = document.createElement('script');
  script.src = './melee_browser.js';
  script.onerror = () => fail(Error('melee_browser.js is missing from this folder.'));
  document.head.append(script);
  pak = await openPak('./melee.pak');
  window.meleePak = pak; // stats, for tests and the console
  updateStart();
}

// Threads need a cross-origin isolated page. Where the server cannot send
// COOP/COEP, coi-sw.js adds them and the page reloads once under its control.
if (location.protocol === 'file:') {
  fail(Error('Open this folder through a web server (run serve.py here), not as a file.'));
} else if (crossOriginIsolated) {
  sessionStorage.removeItem('melee-coi-reload');
  boot().catch(fail);
} else if (navigator.serviceWorker && !sessionStorage.getItem('melee-coi-reload')) {
  sessionStorage.setItem('melee-coi-reload', '1');
  navigator.serviceWorker.register('./coi-sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => location.reload(), (error) => fail(Error(`Cannot enable threads: ${error.message}`)));
} else {
  fail(Error('This page needs cross-origin isolation for its threads, and this browser did not allow it.'));
}
