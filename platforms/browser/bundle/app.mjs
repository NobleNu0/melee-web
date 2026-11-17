// SPDX-License-Identifier: GPL-3.0-or-later
// Host page for the bundled web app: the disc is melee.pak next to this file
// (tools/browser/bundle.py). The Module interface it fills is described in
// platforms/browser/README.md (Host page interface).
import { openPak } from './pak-reader.mjs';
import { checkGraphics } from './gpu-preflight.mjs';
import { startControllerView } from './controller-view.mjs';
import { adapterHelp, createGcAdapter } from './gc-adapter.mjs';
import { installGamepads } from './gamepads.mjs';
import { createPadPorts } from './pad-ports.mjs';
import { createPadDialog } from './pad-setup.mjs';
import { LINK, createNetplay, formatCode, inviteLink, normalizeCode } from './netplay.mjs';
import {
  reportEngineAbort, reportEngineWarning, reportPageError, setSessionContext, startTelemetry, telemetryDsn,
} from './telemetry.mjs';

// Crash reports, when this build has a Sentry DSN (bundle.py --sentry-dsn):
// started first so a failure during boot is reported too.
startTelemetry();

const $ = (id) => document.getElementById(id);
$('reports').hidden = !telemetryDsn();

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
let lastPanic = '';
let netDesync = false;
function log(text) {
  text = String(text);
  lines.push(text);
  if (lines.length > 400) lines.shift();
  $('log').textContent = lines.join('\n');
  console.log(text);
  // The assert location a crash report is titled and grouped by.
  if (text.startsWith('PANIC ')) lastPanic = text.trim();
  if (/ is not in this bundle/.test(text)) reportEngineWarning(text);
  // The two games' frame checksums disagreed (src/pc/net.c check_desync):
  // they have parted and no rollback brings them back. Slippi ends a ranked
  // match here; unranked, say so plainly and report it (once per session).
  if (/^net: DESYNC at frame/.test(text)) {
    netDesync = true;
    updateNet(netplay.info());
    reportEngineWarning(text.replace(/\(local .*$/, '').trim());
  }
}
// Before anything else can ask for gamepads: from here on the engine (SDL) sees
// only the ones that are not translated on this side (gamepads.mjs).
let padStorage = null;
try { padStorage = window.localStorage; } catch { /* storage blocked: layouts last for the visit */ }
const gamepads = installGamepads({ storage: padStorage, log });

function status(text, { error = false } = {}) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function fail(error, { reported = false } = {}) {
  if (!reported) reportPageError(error);
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

// Any MELEE_* query parameter becomes an environment variable, except the
// profile: melee.pak holds only what the VS-only profile reads.
const ENV = {};
for (const [key, value] of params) {
  if (/^MELEE_[A-Z0-9_]+$/.test(key)) ENV[key] = value;
}
ENV.MELEE_VS_ONLY = '1';

// Online play (netplay.mjs, src/pc/net_match_web.c): ?online=host waits for a
// friend under this browser's code, ?join=CODE calls theirs. The engine boots
// into the Direct Connect lobby and dials once (MELEE_ONLINE). The matchmaking
// Worker comes from the page (bundle.py --signal-url); ?signal= overrides it
// on a local test page only.
const localPage = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const signalUrl = (localPage && params.get('signal')) ||
  document.querySelector('meta[name="melee-signal"]')?.content?.trim() || '';
const joinCode = normalizeCode(params.get('join'));
const hosting = params.get('online') === 'host';
const netplay = createNetplay({ signalUrl, log, onChange: (info) => updateNet(info) });
if (netplay.enabled && (hosting || joinCode)) ENV.MELEE_ONLINE = hosting ? 'host' : joinCode;
// A fixed input delay (the start screen's choice), else the netcode's auto
// delay (src/pc/net_sync.c: 1 on a fast link, 2 otherwise, in a fight).
const storedDelay = (() => { try { return localStorage.getItem('melee-net-delay') || ''; } catch { return ''; } })();
if (ENV.MELEE_ONLINE && /^[1-4]$/.test(storedDelay) && !ENV.MELEE_NET_DELAY) ENV.MELEE_NET_DELAY = storedDelay;
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
  onAbort: (reason) => {
    reportEngineAbort(reason, lastPanic, { frames: frames.count, log: lines.slice(-60).join('\n') });
    fail(Error(`Engine stopped: ${reason}`), { reported: true });
  },
  onGraphicsPreparation: (done, total) => {
    $('overlay').hidden = done === total;
    status(done === total ? 'Starting…' : `Preparing graphics… ${Math.floor(done * 100 / total)}%`);
  },
  onRuntimeInitialized: () => { runtimeReady = true; updateStart(); },
  // Netplay's datagram rings (net_web.c) and the matchmaker's calls into the page.
  meleeNetplay: netplay,
  meleeNetLinkReady: () => netplay.attach(Module.meleeNetLink, () => Module._net_web_pump?.()),
  // Called each frame by src/pc/gcadapter.c for the controllers this page feeds it.
  meleePadRefresh: (sdlPorts) => padPorts.refresh(sdlPorts),
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

// ---- online play: start-screen choices and the in-game chip ----------------
function goOnline(query) {
  const url = new URL(location.href);
  url.search = query;
  location.assign(url.href);
}
function setupOnline() {
  if (!netplay.enabled) return;
  const mine = netplay.localCode().slice(1);
  $('online').hidden = false;
  $('host').addEventListener('click', () => goOnline('?online=host'));
  $('net-delay').value = /^[1-4]$/.test(storedDelay) ? storedDelay : '';
  $('net-delay').addEventListener('change', () => {
    try { localStorage.setItem('melee-net-delay', $('net-delay').value); } catch {}
    // Read at boot: reload into the same online mode, still on the start screen.
    if (hosting || joinCode) location.reload();
  });
  const join = () => {
    const code = normalizeCode($('join-code').value);
    if (code && code !== mine) goOnline(`?join=${code}`);
    else $('online-mode').textContent = code ? 'That is your own code.' : 'A code is 8 letters and digits, like K3X-Q2M-7A.';
  };
  $('join').addEventListener('click', join);
  $('join-code').addEventListener('keydown', (event) => event.key === 'Enter' && join());
  $('copy-invite').addEventListener('click', () => {
    netplay.copyCode();
    $('copy-invite').textContent = 'Copied';
  });
  $('net-copy').addEventListener('click', () => {
    netplay.copyCode();
    $('net-copy').textContent = 'Copied';
  });
  $('net-leave').addEventListener('click', () => goOnline(''));
  if (hosting || joinCode) {
    $('online-choose').hidden = true;
    $('start').textContent = hosting ? 'Play online' : 'Join match';
    $('online-mode').innerHTML = hosting
      ? `Hosting as <b>${formatCode(mine)}</b>. Send your friend this link, then press Play:`
      : `Joining <b>${formatCode(joinCode)}</b>'s match. <a href="./" style="color:inherit">Cancel</a>`;
    $('online-invite').hidden = !hosting;
    $('invite-link').textContent = inviteLink(mine);
    $('net').hidden = false;
    $('net-copy').hidden = !hosting;
    updateNet(netplay.info());
  } else {
    $('online-mode').textContent = `Your code: ${formatCode(mine)}`;
  }
}
function updateNet(info) {
  if ($('net').hidden) return;
  const word = {
    [LINK.IDLE]: ['Online', ''],
    [LINK.SIGNALLING]: ['Connecting to the server…', ''],
    [LINK.WAITING]: info.role === 'host' ? ['Waiting for your friend', 'ok'] : ['Calling…', ''],
    [LINK.NEGOTIATING]: ['Found them, connecting…', ''],
    [LINK.OPEN]: ['Connected', 'ok'],
    [LINK.FAILED]: [info.reason || 'Online play failed', 'bad'],
  }[info.state] ?? ['Online', ''];
  $('net-state').textContent = netDesync ? 'Desynced: the two games no longer match' : word[0];
  $('net-state').className = `state ${netDesync ? 'bad' : word[1]}`;
  const who = info.peer ? `vs #${formatCode(info.peer.slice(1))}` : info.role === 'host' ? `your code ${formatCode(info.code)}` : '';
  const how = info.state === LINK.OPEN
    ? `${info.path === 'direct' ? 'direct' : 'relayed'}${info.rttMs != null ? ` · ${info.rttMs} ms` : ''}` : '';
  $('net-detail').textContent = [who, how].filter(Boolean).join(' · ');
  setSessionContext('netplay', { state: info.state, path: info.path, rtt_ms: info.rttMs, role: info.role });
}
setupOnline();

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
  $('canvas').focus();
}
$('fullscreen').addEventListener('click', toggleFullscreen);
// Controllers reach the game three ways (see the README's controller table):
//  - a gamepad the browser knows the layout of goes to the engine through SDL;
//  - one it does not (a GameCube adapter in PC mode, a generic USB pad) is
//    translated here, by a built-in profile or one the player makes with
//    "Set up controller" (gamepads.mjs);
//  - the official adapter is opened through WebHID with "GameCube adapter",
//    once; later visits reconnect it silently (gc-adapter.mjs).
// pad-ports.mjs gives the last two kinds their ports, first controller first.
const adapter = createGcAdapter({ log, onStatus: () => updatePadTools() });
const padPorts = createPadPorts({ adapter, gamepads, log });
const padDialog = createPadDialog($('paddialog'), {
  gamepads,
  onClose: () => {
    updatePadTools();
    $('canvas').focus();
  },
});
function updatePadTools() {
  $('gcadapter').hidden = adapter.connected;
  const pads = gamepads.connected();
  $('padsetup').hidden = !pads.length;
  // A pad nothing knows the layout of plays with guessed buttons until set up.
  const unknown = pads.some((pad) => gamepads.needsSetup(pad));
  $('padsetup').classList.toggle('attn', unknown);
  $('padsetup').title = unknown
    ? 'This controller has no known layout, so its buttons are a guess. Set it up to tell the game which is which.'
    : 'Tell the game which button and stick is which on this controller';
}
$('gcadapter').addEventListener('click', async () => {
  let result = 'none';
  try {
    result = await adapter.request();
  } catch (error) {
    log(`GC adapter: ${error.message}`);
  }
  updatePadTools();
  if (result === 'connected') $('canvas').focus();
  else padDialog.help('GameCube adapter', adapterHelp(result, navigator.userAgent));
});
$('padsetup').addEventListener('click', () => padDialog.setup());
adapter.reconnect().catch((error) => log(`GC adapter: ${error.message}`)).finally(updatePadTools);
setInterval(updatePadTools, 1000);

// The live controller above the game: the ports filled on this side first,
// then the gamepads SDL reads.
startControllerView($('pad'), {
  getGamepads: () => [
    ...[0, 1, 2, 3].map((port) => padPorts.pad(port)).filter(Boolean),
    ...gamepads.passthrough(),
  ],
});

async function boot() {
  if (!navigator.gpu) throw Error('This browser has no WebGPU. Use a current Chrome or Edge.');
  status('Loading…');
  const script = document.createElement('script');
  script.src = './melee_browser.js';
  script.onerror = () => fail(Error('melee_browser.js is missing from this folder.'));
  document.head.append(script);
  pak = await openPak('./melee.pak');
  setSessionContext('pak', { id: pak.id, size: pak.size });
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
