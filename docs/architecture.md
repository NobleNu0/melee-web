# Architecture

melee-web is one target: the game compiled to WebAssembly, rendered with
WebGPU, in a page that carries the player's own disc as `melee.pak`. The code
is [melee-pc](https://github.com/999sian/melee-pc)'s, minus its native
platforms. [platforms/browser/README.md](../platforms/browser/README.md) has
the build, the pak format, online play and the host page in detail.

## Layers

```
melee.pak (the player's disc: big-endian .dat/.usd files, verbatim in MEM1)
        │  Module.readDisc, platforms/browser/bundle/pak-reader.mjs
        ▼
src/melee, src/sysdolphin     game code from doldecomp/melee (C11; upstream
                              commit in src/UPSTREAM_COMMIT), adapted to the
                              port's data model and lowered for wasm
        │  GX / OS / PAD / DVD / CARD / AX / THP / VI calls
        ▼
src/pc + platforms/browser    platform layer: OS/VI/GX glue, keyboard,
                              GameCube adapter, software AX mixer, rollback
                              netcode; main, disc access, clock and the
                              launcher's fixed settings for the browser
        │
        ▼
extern/aurora (vendored)      GX command processor -> WebGPU (emdawnwebgpu),
                              Dolphin SDK services (OS, PAD, CARD, ARAM, MTX,
                              THP), SDL3 window and input, pipeline cache
        │
        ▼
platforms/browser/bundle      the page: loads the engine and the pak, audio
                              worklet, controllers (Gamepad API, WebHID),
                              netplay link (WebRTC or relay), crash reports
```

The boundary rule and the per-layer coding conventions are in
[CODING_STYLE.md](../CODING_STYLE.md#1-architectural-overview--the-two-layers).

- `src/melee`, `src/sysdolphin` - game code from the decomp
  ([porting-notes.md](porting-notes.md)). Divergences from the decomp are
  tagged `/* PORT: ... */`. Every mode is still compiled; the VS-only profile
  (`src/pc/profile.c`, `MELEE_VS_ONLY`) decides what is reachable.
- `src/pc` - upstream's platform layer, the files the browser build compiles:
  `vi.c` (frame boundary and pacing), `os.c` (interrupt masking, alarms),
  `gx.c` / `vtxarray.c`, `keyboard.c`, `input_poll.c`, `gcadapter.c`,
  `audio.c` (software AX mixer), `thp.c`, `discfont.c` (font atlases read
  from the disc), `region.c`, `widescreen.c`, `textures.cpp`, and the netcode
  (`net*.c`; `net_web.c` and `net_match_web.c` are the browser's transport and
  matchmaking).
- `platforms/browser` - what replaces upstream's native pieces: `main.c`,
  `dvd.c` (disc reads from the pak), `clock.c`, `scheduler.c`, and
  `pc_stubs.c` (the launcher's settings as fixed values, no file cache or
  replay recorder).
- `extern/aurora` - vendored aurora with local changes; editable in-tree.
- `tools/browser` - the build: `bundle.py` (one step, disc to deployable
  folder), `compile_game.py` and `disc_lower.cpp` (the game units),
  `make_pak.py`.

## How the game code is compiled

The decomp marks every struct that maps disc bytes `DISC_STRUCT`, which GCC
byte-swaps on access (`scalar_storage_order`). Clang, which Emscripten is, has
no such attribute, so each game unit goes through `disc_lower` (LLVM
LibTooling) first: it rewrites those accesses into explicit big-endian loads
and stores, and emcc compiles the result. Port files that read disc structs
(`src/pc/vtxarray.c`, `src/pc/widescreen.c`) take the same route. The game's
statics are then grouped into two named segments so a rollback snapshot can
copy them (`wasm_state_sections.py`).

## Threads

One thread runs everything the engine does: the game loop, GPU submission
(aurora's inline processing mode; a WebGPU device belongs to the realm that
made it), the audio mix (`pc_audio_pump`), the netcode, and the completion of
disc and ARAM requests, which upstream delivers from worker threads and this
build delivers cooperatively (`pc_os_run_alarms`). `VIWaitForRetrace`
(`src/pc/vi.c`) is the frame boundary; it paces to 60 Hz and returns to the
browser's event loop at least once a frame (Asyncify).

Off that thread, in the page: an AudioWorklet plays the mix from a ring in
shared wasm memory, and workers prefetch and decompress the pak.

## Memory map

- wasm32: pointers are 32 bits, as on the GameCube, so a disc pointer slot
  holds a host address directly.
- MEM1 (96 MB) is allocated at `0x10000000` on every page
  (`extern/aurora/lib/dolphin/os/OSMemory.cpp`), so two netplay peers hold the
  same pointers and GameCube heaps get the 32-byte alignment they assume.
- ARAM (16 MB) is a separate buffer; ARAM "addresses" are offsets into it, and
  anything below `0x01000000` is an ARAM offset (`PC_IS_ARAM_ADDR` in
  `src/pc/disc.h`). The GameCube's `>= 0x80000000` test for "MEM1" is wrong
  here; an upstream sync that brings one back breaks stage loads.
- Disc pointer slots are `DISC_PTR(T)`, read through `DP(T, slot)` and written
  through `DP_SET(slot, p)`.

## Aurora

`extern/aurora` is the [encounter/aurora](https://github.com/encounter/aurora)
compatibility layer, vendored with local changes. It provides the Dolphin SDK
surface the decomp calls and implements GX by recording the FIFO into a
command processor that compiles TEV and vertex state into WebGPU pipelines
(`extern/aurora/lib/gx`). Pipelines compile asynchronously and are cached in
SQLite (`/cache`, kept in IndexedDB); the bundle ships a seed
(`tools/browser/vs_pipeline_cache.db.gz`) that is compiled behind "Preparing
graphics", so a first visit does not skip draws while shaders compile.
