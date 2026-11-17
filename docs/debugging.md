# Debugging

## Logs

Everything the engine prints goes through `pc_log_line()` (`src/pc/pc.h`),
timestamped in milliseconds from startup, and arrives in the browser's console
(the page's `Module.print`, `platforms/browser/bundle/app.mjs`). Any frame
over 50 ms leaves a `STALL` marker (`src/pc/vi.c`). aurora's `[aurora::gpu]`
lines (enabled features, surface format) are the first things to read in a
graphics report.

Settings are query parameters: any `MELEE_*` parameter on the page's URL
becomes an environment variable before the engine starts, so
`?MELEE_FPS=1&MELEE_BOOT_SCENE=vs` is how the variables below are set.
`MELEE_BOOT_SCENE=title|vs|classic|credits` boots straight into a scene;
`MELEE_DEBUG_VS_CHARS=<ckind>,...` and `MELEE_DEBUG_VS_STAGE=<stkind>` choose
the debug VS match's fighters and stage, which is how to reach any character
or stage without menus. `MELEE_DVD_TRACE=1` names each file as it is first
opened.

## Crashes

An assert prints `PANIC <file>:<line>` and aborts; the page shows the message
and, when the build has a Sentry DSN (`bundle.py --sentry-dsn`), reports it
with the wasm stack, the recent log, and the browser, OS and GPU
(`bundle/telemetry.mjs`). The deployed wasm keeps its function names, so the
stack reads as game functions. A file the pak lacks is logged as
`[dvd] <name> is not in this bundle` (`platforms/browser/dvd.c`) and reported
too. A desync in online play is logged as `net: DESYNC at frame N`, followed
by the recent frames' checksummed state (`src/pc/net.c`); the page shows it on
the online chip.

For a hang, pause in the browser's debugger: the wasm frames name the loop.
`tests/browser/shell-e2e.mjs` holds each scene to 60 fps; run it after any
change to shared code ([platforms/browser/README.md](../platforms/browser/README.md#testing)).

## Heap check

`MELEE_HEAP_CHECK=1` appends a canary to every `OSAlloc` allocation
(`extern/aurora/lib/dolphin/os/OSAlloc.cpp`), checks them each frame, and aborts
at the first stomp with the allocating call site. This is the tool for "walked an object
by GameCube word number" and other off-by-pointer-width writes.

## Diagnostic environment variables

These are off by default and cost nothing when unset. They measure or suppress
only; none of them fixes anything. The netplay knobs (`MELEE_NET_*`) are in
[netcode-plan.md](netcode-plan.md) and `src/pc/net.c`.

| Variable | Effect |
|---|---|
| `MELEE_FPS=1` | Print frame rate once a second. |
| `MELEE_INPUT_HUD=1` | Log how old the controller sample each tick consumes is. |
| `MELEE_HEAP_CHECK=1` | Canaries on every heap allocation, checked each frame; aborts at the first stomp. |
| `MELEE_SEED=<n>` | Deterministic RNG for the attract demo. |
| `MELEE_AUDIO_DUMP=<file>` | Also write the mix as raw f32 stereo 32 kHz. |
| `MELEE_SFX_STATS=1` | Sound-effect request/accept/reject counts. |
| `MELEE_AUDIO_STATS=1` | Per-0.5s voice census. |
| `MELEE_AUDIO_ADDR=1` | Report voice sample addresses against the ARAM bounds. |
| `MELEE_GFX_STATS=1` | Peak per-pool high-water marks (vertex/uniform/index/storage/texture) for sizing frame budgets. |
| `MELEE_CPU_TRACE=1` | Per-CPU-player AI census every ~2s. |
| `MELEE_PIPELINE_SYNC=1` | Block the frame on a never-before-seen GX pipeline (old behaviour, the #46 stutter) instead of skipping its draw until it compiles. |
| `MELEE_SCENE_LOG=1` | Report scene model descriptor slots (the joint pointer `gmRegClearAddModel` panics on). |
| `MELEE_ARCHIVE_LOG=1` | Report every archive load with its header sizes. |
| `MELEE_INTRO_LOG=1`, `MELEE_ICON_LOG=1`, `MELEE_TEXANIM_LOG=1` | Team-splash capture buffers; CSS icon frame selection; out-of-range texture-animation frames. |
| `MELEE_MOBJ_MARK=1` | Tag draws with whether the material had a texture. |
| `MELEE_TEV_TREE=1` | Count compiled TEV stages and how many carry a texture. |
| `MELEE_TEX_ASSIGN=1` | Count tobjs assigned a texmap vs forced to null. |
| `MELEE_PS_TEXMISS=1` | Report particles that ask for a texture but resolve none. |
| `MELEE_EF_LOG=1`, `MELEE_EF_SKIP=a-b`, `MELEE_EF_MAT=<id>` | Report or suppress effect ids; dump the material of one effect. |
| `MELEE_ZTEX_BIAS=<n>` | Z-texture bias for the sobj tile pass (0 = retail; separates an empty Z capture from a missing draw). |
| `MELEE_CAM_BONE=1` | Report camera-bone inputs where the value is produced, so the first bad frame is logged. |
| `MELEE_INSTANT_WIN=1` | End a VS match after 60 frames (test fixture). |
| `MELEE_CLASSIC_STAGE_OVERRIDE=<1-11>`, `MELEE_CLASSIC_TEAM=kirby\|jiggly` | Force a Classic stage / team fight (test fixture). |
| `AURORA_LOG_UNTEX=1` | Report draws that bind no texture. |
| `AURORA_SKIP_UNTEX=1` | Drop every untextured draw. |
| `AURORA_SKIP_UNTEX_VTX=n`, `AURORA_ONLY_UNTEX_VTX=n` | Drop, or keep only, untextured draws with exactly n vertices. |
| `AURORA_LOG_TEV=1`, `AURORA_LOG_UNTEX_REGS=1`, `AURORA_LOG_QUADPOS=1` | Report what an untextured draw's TEV stages / registers / quad positions asked for. |
| `AURORA_LEGACY_TEX_LOD=1` | Restore the unconditional LOD-bias sample (positive control for the black-floor sweep). |

`grep -rho 'getenv("\(MELEE\|AURORA\)_[A-Z0-9_]*")' src extern/aurora/lib platforms` is the
authoritative list; the table lags it.
