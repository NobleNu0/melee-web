# Browser platform (Emscripten + WebGPU)

Runs the game in a web page from the player's own disc image. The page reads the
image with the File API; nothing is uploaded and no game data is part of the
build. Game logic, Aurora GX, the AX mixer and memory-card support are the same
code as every other platform.

Status: desktop Chrome (tested on Apple Silicon; Chromium on Linux with Intel
Arc graphics as well) holds 60 fps in every scene the tests reach,
including four CPUs on Final Destination. It needs WebGPU; there is no WebGL
fallback. Netplay is compiled in but refused at connect (browsers have no UDP),
and HD texture packs, custom music, the desktop launcher and the updater are
absent.

## Build and run

Prerequisites: Python 3, CMake, Ninja, Git, LLVM 22 with LibTooling
(`LLVM_ROOT`, default `/opt/homebrew/opt/llvm@22`), and a real GCC 12+ on `PATH`
as `gcc-NN` for the lowering oracle.

```sh
python3 tools/browser/setup_sdk.py        # pinned Emscripten into build/browser/emsdk
python3 tools/browser/build.py --jobs 8   # oracle tests, game, Aurora, link, node tests
python3 tools/browser/serve.py            # http://127.0.0.1:5190/
```

`serve.py` exists because the engine uses threads, which browsers only allow on
a cross-origin-isolated page (COOP/COEP headers). A host that cannot send them,
such as GitHub Pages (`.github/workflows/pages.yml` publishes this build under
`/play/`), gets them from `coi-sw.js`, a service worker the page registers and
reloads under once.

Any `MELEE_*` query parameter becomes an environment variable, so the knobs in
`docs/testing.md` work as they do natively:
`http://127.0.0.1:5190/?MELEE_BOOT_SCENE=vs&MELEE_DEBUG_VS=cpu4`.

## Bundled web app (disc built in)

`tools/browser/bundle.py` turns the engine and your own disc image into one
self-contained folder that boots straight into the game, with no disc picker:

```sh
python3 tools/browser/build.py --jobs 8                  # the engine, once
python3 tools/browser/bundle.py /path/to/GALE01.iso      # -> build/browser/bundle
python3 build/browser/bundle/serve.py                    # http://127.0.0.1:5191/
```

`--vercel DIR` also writes a deploy folder and `DIR.zip` for Vercel Drop (or any
static host): the bundle without `serve.py`, plus a `vercel.json` sending the
COOP/COEP headers. `melee.pak` is LZMA-compressed there (`make_pak.py --lzma`,
decoded by `bundle/lzma.mjs` in a worker pool) to stay under Hobby's 100 MB
static upload limit, and a host that ignores Range requests gets the pak
downloaded once, whole, instead of streamed.

The folder is portable: copy it to any static host that supports HTTP Range
requests (GitHub Pages, nginx, and so on; `coi-sw.js` supplies COOP/COEP where the
host cannot), or run its own standard-library `serve.py` wherever Python 3 is.
It holds game data from your disc, so it is for your own use: do not publish it.

- The app always runs the VS-only profile (`MELEE_VS_ONLY=1`, `src/pc/profile.c`):
  boot goes straight to the title (no memory-card scene, no movie), Start opens
  VS character select as a 1v1 of port 1 against a level 9 CPU (the port 3 and
  4 panels are hidden and cannot be opened), everything is unlocked, nothing is
  saved, and the rules are 20XX's boot settings: 4 stocks, 8 minutes, items
  off, friendly fire on. Stage select shows only Battlefield, Final
  Destination, Dream Land, Yoshi's Story, Fountain of Dreams and Pokemon
  Stadium, as a 3x2 grid of larger chips with Random beside it. Backing out of
  CSS returns to the title. Adventure, Classic, trophies and the other modes
  stay compiled but unreachable; Training is untouched for a later return.
- `melee.pak` (`tools/browser/make_pak.py --vs-only`) is a compact virtual disc:
  header, `main.dol`, a rewritten FST and the files back to back, in
  raw-deflate blocks of 256 KiB. `dvd.c` reads it through the same disc offsets
  as an `.iso`, so the engine is unchanged. Only the files the profile can read
  go in (`VS_ONLY_FILES` in `make_pak.py`, from a `MELEE_DVD_TRACE=1` trace of
  every reachable screen plus each fighter's and legal stage's data): 455 of
  1,209 files; each fighter keeps its default costume and first alternate only
  (`gm_GetNumCostumesForCKind` caps the count at 2 in the profile). About
  119 MiB against a 1.46 GB disc. A left-out file keeps its
  FST entry with offset and length 0, and `dvd.c` logs its name if anything
  asks for it.
- Shaders: `tools/browser/vs_pipeline_cache.db.gz` holds every GPU pipeline the
  profile draws with (865, recorded from sessions covering every screen, fighter
  and legal stage, merged by `merge_pipeline_caches.py`). The page installs it as
  `/initial_pipeline_cache.db`; on a first visit aurora imports it and compiles
  it all behind "Preparing graphics" (about a quarter of a second) instead of
  skipping draws while pipelines compile during the first match.
- The page shows a chip bar above the game: the keyboard controls, and the
  first connected controller drawn live (`bundle/controller-view.mjs`) as a
  GameCube controller or a generic gamepad, each control labelled with the
  GameCube input aurora maps it to. Character select has no rules header,
  since the rules are fixed.
- Input: the keyboard and any controller the browser's Gamepad API exposes
  with the standard mapping (XInput, Switch Pro, DualShock-class pads) drive
  port 1 through SDL. The official Wii U / Switch GameCube adapter (WUP-028,
  or a Mayflash in Wii U mode) is not a Gamepad API device: in Chrome and Edge
  the page opens it through WebHID (`bundle/gc-adapter.mjs`; "Connect GameCube
  adapter", once per site) and hands its reports to `src/pc/gcadapter.c`,
  which reads them exactly as the native build does: raw 8-bit axes, adapter
  slot N = port N, rumble. On Windows the adapter must still use its HID
  driver (not WinUSB from Zadig); on Linux Chrome needs hidraw access.
- Crash reports: `bundle.py --sentry-dsn DSN` (or `MELEE_SENTRY_DSN`) turns on
  Sentry reporting (`bundle/telemetry.mjs`, the SDK self-hosted in
  `bundle/vendor/`). Engine aborts arrive titled by their PANIC location with
  the wasm stack and the recent log; each report is tagged with the browser,
  OS, GPU, CPU, memory and exact build (`melee-web@<engine>-<pak>`). No IP
  address or other personal data, no sessions, tracing or replays. Without a
  DSN nothing is loaded or sent.
- `bundle/pak-reader.mjs` serves `Module.readDisc` from it: blocks are fetched
  with Range requests only when a read needs them, inflated with
  `DecompressionStream`, and kept compressed in the Cache API, so a second visit
  downloads nothing. After boot, `pak-prefetch.worker.mjs` copies the game data
  (everything but the music) into the cache off the game's thread, backing off
  while the game waits on a read; music streams with two blocks of read-ahead.
  `?prefetch=0` turns the prefetch off.
- The engine's wasm is stripped of its function names and shipped gzipped
  (`melee_browser.wasm.gz`, 4.9 MiB); `app.mjs` inflates it with
  `DecompressionStream` in `Module.instantiateWasm`, and passes bytes through
  untouched when a host already served them with `Content-Encoding: gzip`. The page takes the same
  `MELEE_*` query parameters as the disc-picker shell, plus `?res=WxH`.

`MELEE_TEST_BUNDLE=1 MELEE_TEST_URL=http://127.0.0.1:5191/ node tests/browser/shell-e2e.mjs`
runs the 60 fps cases against the bundle instead of a picked disc.

## Why the game is compiled differently here

The decomp reads disc structures through
`__attribute__((scalar_storage_order("big-endian")))`, which only GCC
implements. Android, Apple and Windows-ARM64 solve that by routing game C
through a GCC cross-compiler. There is no GCC for WebAssembly, so this platform
lowers the attribute instead:

1. Clang preprocesses each unit with `DISC_STRUCT` defined as an annotation.
2. `tools/browser/disc_lower.cpp` (LibTooling) rewrites every read and write of
   an annotated struct's scalar members, bit-fields included, into explicit
   big-endian loads and stores, and emits plain C.
3. `emcc` compiles the result with the same floating-point flags as
   `melee_game`.

`tools/browser/test_disc_lower.py` is the safety net: each `tests/browser/disc_*.c`
is built with real GCC, and the lowered program must print identical values and
bytes both natively and as wasm. `build.py` runs it before compiling the game.
String literals are converted to CP932 first (`execution_charset.py`), which is
what `-fexec-charset=CP932` does for GCC.

A wasm32 host is also the first 32-bit target, which is what the `UINTPTR_MAX`
branches in `src/pc/disc.h` and the 64-bit casts in `archive.c` are for, and the
first where a call through a mismatched prototype traps instead of working by
accident (`ftLib_800876B4`, `gm_801677E8`, `mnCharSel_802640A0`).

## What differs from native

- `main.c`, `dvd.c` replace `src/pc/main.c` and nod: the part of the DVD API
  this target links (an unimplemented call is a link error) is served from
  the page's `File` through `disc-cache.mjs` (512 KiB blocks, 32 MiB LRU). A
  cache miss suspends the wasm (Asyncify) until the read resolves. Only plain
  GALE01 revision 2 `.iso`/`.gcm` images are accepted for now.
- `pc_stubs.c` replaces the desktop launcher's settings, the libusb GameCube
  adapter and the archive file cache. Everything else in `src/pc` is compiled
  unchanged; when `PC_SOURCES` grows, add the file to `BROWSER_PC_SOURCES`.
- One thread runs the game and submits GPU work (`ProcessingMode::Inline`);
  the browser only exposes a WebGPU device to the realm that created it. DVD,
  ARQ and card completions that native delivers from worker threads are
  delivered cooperatively from `pc_os_run_alarms`.
- The frame boundary paces with `emscripten_sleep` instead of
  `SDL_DelayPrecise`, and always returns to the event loop once per frame. The
  game's own wait loops (`pc_os_wait_alarm`, `pc_os_yield`) yield to the event
  loop too, instead of SDL's delays, which spin or clamp to 4 ms here.
- Staging uploads use one CPU arena and `Queue.WriteBuffer` for the ranges a
  frame used. Mapping native's 87 MiB staging buffers every frame costs an
  allocate, clear and copy of all of it in emdawnwebgpu.
- Pipelines compile asynchronously; a draw whose pipeline is still compiling is
  skipped, as upstream does natively. Cached pipelines are compiled behind the
  loading status before `melee_main` rather than five per frame during play.
  The cache uses `journal_mode=MEMORY`: WAL on Emscripten's in-memory filesystem
  stalled uploads for over a second at a time and never persisted.
- Saves (`/saves`) and the pipeline cache (`/cache`) persist in IndexedDB.

## Host page interface

`index.html` and `shell.mjs` are a complete host in about a hundred lines. A page
embedding the engine sets these on `Module` before loading `melee_browser.js`:
`canvas` (its `width` and `height` are the render size), `print`/`printErr`,
`readDisc(offset, size)` returning a `Uint8Array` or a promise of one, and
optionally `onFrame(frame)`, `onGraphicsPreparation(done, total)` and `onAbort`.
Environment variables go into `Module.ENV` from `preRun`, which is after
Emscripten creates `ENV` and before the static constructor that snapshots it.
Then the page mounts `/saves` and `/cache` and calls `callMain([])`.

## Testing

```sh
python3 tools/browser/serve.py &
MELEE_ISO=/path/to/GALE01.iso PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
  node tests/browser/shell-e2e.mjs
```

Headed Chrome boots `title` (answering the memory-card prompt and menus by
keyboard), `vs`, `vs-cpu4`, `classic` and `training`, and fails any case below
58.5 fps or above a 33.4 ms p99 frame time. Boot-scene cases must also log the
scene they asked for, so holding 60 fps on the wrong screen cannot pass.

Audio does not go through SDL here: `src/pc/audio.c` writes the mix into a
ring in shared wasm memory and an `AudioWorklet` plays it on the browser's
audio thread, at the game's own 32 kHz when the browser allows it (SDL's
Emscripten backend uses the deprecated `ScriptProcessorNode`, on the main
thread the game runs on). The canvas uses the browser's preferred format
(`navigator.gpu.getPreferredCanvasFormat()`), which saves a conversion copy
per frame.

Known limitations:
Safari and mobile browsers are untested here; the first launch on a machine
compiles shaders for a few seconds behind the loading status.
