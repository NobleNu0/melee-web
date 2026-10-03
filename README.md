# melee-web

**A web-native Super Smash Bros. Melee, trimmed and tuned for 1v1 versus.**

This is a fork of [999sian/melee-pc](https://github.com/999sian/melee-pc), the
native PC port of Melee (NTSC-U 1.02) built from
[doldecomp/melee](https://github.com/doldecomp/melee) on
[aurora](https://github.com/encounter/aurora) and SDL3. Upstream is the whole
game on every desktop and mobile platform. This fork has one narrower goal:

> Open a URL, pick a character, play a 1v1, at a locked 60 fps, offline against
> a CPU or online against a friend, with nothing to install.

To get there it compiles the game to WebAssembly and renders it with WebGPU. It
cuts the game down to versus play only, and it packs just the files that mode
reads into one compact archive that streams into the page. The work since then
has gone into the parts a browser makes hard: frame pacing, input latency,
audio, the first-load size and shader compiles, and rollback netplay without
UDP.

You need your own disc image. **No game data is in this repository.** The
decompiled game code is not licensed; only the port code is GPL-3.0-or-later
(see [License](#license)).

## What's trimmed

One switch, `MELEE_VS_ONLY` (`src/pc/profile.c`), turns the game into a 1v1
versus client. The web app always runs with it on.

- **Straight to the title.** No memory-card scene, opening movie or attract
  demo. Start opens VS character select, and backing out returns to the title.
- **1v1 only.** Character select opens as port 1 against a level 9 CPU. The
  port 3 and 4 panels are hidden and can't be opened.
- **Tournament rules, fixed.** 4 stocks, 8 minutes, items off, friendly fire
  on (20XX's boot settings). The rules header is hidden.
- **Legal stages only.** Battlefield, Final Destination, Dream Land, Yoshi's
  Story, Fountain of Dreams and Pokémon Stadium, shown as a 3x2 grid of larger
  chips. Random picks among them. Pokémon Stadium is frozen by default (no
  transformations).
- **Everything unlocked, nothing saved.** No records, new challengers, unlock
  fights or trophy prizes after a match.
- **Smaller data.** Each fighter has its default costume and first alternate.
  Stages and menus play their main track (the random rolls still happen, so
  the RNG sequence matches retail).
- **UCF on.** UCF 0.8x dashback and shield drop are the default.

Adventure, Classic, All-Star, the Stadium modes, Event Match and trophies stay
compiled but can't be reached. Training is untouched, for a later return.

## What's optimized for the web

| Area | What this fork does |
|---|---|
| Download | `melee.pak` holds only the 455 of the disc's 1,209 files the VS profile reads (found by tracing every reachable screen, fighter and legal stage). It's a compact virtual disc in 256 KiB LZMA blocks that the engine reads at the same offsets as an `.iso`. The engine's wasm ships gzipped (about 5 MiB). The whole deployable folder is about 89 MB. |
| Loading | Blocks are fetched with HTTP Range requests only when a read needs them, decoded in a worker pool and kept in the Cache API, so a second visit downloads nothing. After boot a worker prefetches the rest of the game data off the game's thread. |
| Shaders | The app ships every GPU pipeline the profile draws (865) and compiles them up front behind "Preparing graphics", so the first match doesn't stutter. |
| Frame rate | Holds 60 fps in every scene the end-to-end tests reach, in desktop Chrome. Frame pacing uses a microsecond monotonic clock (Emscripten rejects `CLOCK_MONOTONIC_RAW`, so SDL had fallen back to `Date.now()`, which only ticks in whole milliseconds). |
| Input latency | The controllers are read again after the frame's pacing sleep, just before the game samples them (the same "polling drift" fix as Slippi's lag reduction). Measured input age at the tick went from 14.8 ms to 0.12 ms. |
| Audio | The mix goes into a ring in shared wasm memory that an AudioWorklet plays on the browser's audio thread, at the game's own 32 kHz where allowed. Upstream uses SDL's deprecated ScriptProcessorNode, which runs on the same main thread as the game. |
| Rendering | The canvas uses the browser's preferred format (BGRA8 on Macs), saving a conversion copy every frame. |

## Online play

The native rollback netcode runs in the page unchanged from the lobby on: time
sync, rollback, resume, per-datagram authentication and desync checks. Only the
transport and the matchmaking are new.

- **Transport.** Browsers have no UDP. Datagrams travel over a WebRTC data
  channel set to unordered with no retransmits, which is UDP's contract. A
  WebSocket relay covers networks that can't reach each other directly.
- **Matchmaking.** A small Cloudflare Worker
  ([`platforms/browser/netplay-worker`](platforms/browser/netplay-worker))
  pairs the two players, forwards the WebRTC handshake and relays when needed.
- **Rollback state in wasm.** A build step renames the game's data segments so
  the linker brackets them for snapshots. MEM1 is pinned at a fixed address so
  both peers hold the same pointers.

To play, choose **Host online match** on the start screen and send your friend
the invite link. Both players land in the Direct Connect lobby, then character
select, stage select (each player picks and a shared coin flip decides) and
the match. The host's rules apply, UCF is forced on, and the start screen sets
the input delay (Auto, or 1–4 frames).

**Discord:** the Worker can also answer a `/melee` slash command. The command
posts a public **Join match** link and sends the caller a private **Start
hosting** link. Invite links unfurl as a card.

Measured between two Chromes over a local Worker: a direct link in about a
second and a fight delay of 1 frame. With 40 ms added each way, 8 ms jitter and
2% loss, there was no desync, and a 2.3 MiB snapshot took 0.18 ms to save and
0.07 ms to restore. Details are in [docs/netcode-plan.md](docs/netcode-plan.md)
§17.

## Controls

| Input | How |
|---|---|
| Keyboard | Stick: arrows or WASD. C-stick: IJKL. A = X, B = Z, X = C, Y = V, L = Q, R = E, Z = Tab, Start = Enter, D-pad: TFGH. |
| Gamepads | Any controller the browser's Gamepad API exposes with the standard mapping (XInput, Switch Pro, DualShock-class pads) drives port 1. |
| GameCube adapter | The official Wii U / Switch adapter (WUP-028, or a Mayflash in Wii U mode) works in Chrome and Edge through WebHID. Click **Connect GameCube adapter** once per site; the browser reconnects it silently after that. Reports are read raw, as the native build reads them: real 8-bit axes, adapter slot N = port N, and rumble. On Windows the adapter must keep its HID driver (not WinUSB from Zadig). |

A bar above the game lists the keyboard controls and draws the connected
controller live.

## Requirements

- A desktop browser with WebGPU. Chrome and Edge are tested (on Apple Silicon,
  and Chromium on Linux with Intel Arc). Safari, Firefox and mobile browsers
  are untested. There is no WebGL fallback.
- **Your own copy of Melee USA revision 2 (GALE01)** as `.iso`, `.gcm` or
  `.ciso`. Scrubbed images work. Convert `.rvz`, `.wia` or `.gcz` to ISO in
  Dolphin first; the build tells you if it gets one.
- Building: Python 3, CMake, Ninja, Git, LLVM 22 with LibTooling, and a real
  GCC 12+ on `PATH` (the build compares its big-endian lowering against GCC).

## Build and run

The repository holds code only. One command turns your disc into the web app:

```sh
python3 tools/browser/bundle.py /path/to/your/melee.iso
python3 build/browser/bundle/serve.py              # http://127.0.0.1:5191/
```

`bundle.py` does the whole build:

1. It checks the image: GALE01, revision 2, with every file the VS profile
   needs. A wrong region, revision or format gets a clear error.
2. On a first run it installs the pinned Emscripten SDK (`setup_sdk.py`) and
   builds the engine (`build.py`). `--rebuild-engine` forces a rebuild after
   you change the code.
3. It packs `melee.pak` from your disc: only the VS profile's files,
   LZMA-compressed. A pak from your CISO is byte-identical to one from the
   same disc as an ISO.
4. It writes a self-contained folder, `build/browser/bundle`, about 89 MB, that
   boots straight into the game.

The build fails if the deployable folder is over 100 MB (`--max-mb` changes
the budget). It also refuses to write the bundle anywhere in the checkout that
git would track, so your game data can't end up in a commit.

The folder works on any static host that supports HTTP Range requests. The engine runs threads, which need cross-origin isolation
(COOP/COEP headers). `serve.py` sends those headers; on a host that can't,
`coi-sw.js` adds them.

Options:

| Flag | Effect |
|---|---|
| `--signal-url wss://…` | Turn on online play through your deployed netplay Worker. Without it the app is offline only. |
| `--sentry-dsn DSN` | Send crash reports to your Sentry project: the PANIC line, wasm stack, recent log, and browser/OS/GPU. No IP address or other personal data, no sessions, no replays. Without a DSN nothing is loaded or sent. |
| `--vercel DIR` | Also write a static deploy folder and `DIR.zip` with `vercel.json` (COOP/COEP headers), under Vercel Hobby's 100 MB limit. |
| `--max-mb N` | The size budget for the deployable folder (default 100). |
| `--rebuild-engine` | Rebuild the engine even if a build exists. |

Any `MELEE_*` query parameter becomes an environment variable, so the upstream
diagnostic knobs still work, for example
`?MELEE_FROZEN_STADIUM=0` restores Stadium's transformations.

Deploying the netplay Worker and setting up the Discord command are covered in
[platforms/browser/README.md](platforms/browser/README.md#online-play-netplay).

> **The bundle contains game data from your disc.** It is for your own use. Do
> not publish it or host it publicly.

## Testing

```sh
python3 build/browser/bundle/serve.py &
MELEE_TEST_BUNDLE=1 MELEE_TEST_URL=http://127.0.0.1:5191/ \
  PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
  node tests/browser/shell-e2e.mjs
```

Headed Chrome boots each scene and fails any case below 58.5 fps or above a
33.4 ms p99 frame time.

After syncing with upstream, also play a Pokémon Stadium match with
`?MELEE_FROZEN_STADIUM=0` for about three minutes (it transforms about once a
minute), and grep for GameCube address tests (`0x80000000`). Both have broken
the wasm build after past decomp syncs.

## Keeping game data out of the repository

`.gitignore` ignores disc images, paks and the disc's file types, and
[`tools/check_no_game_data.py`](tools/check_no_game_data.py) checks every
tracked file by name and content. It catches a renamed or gzipped disc image,
a pak, movies, music streams and HSD archives. CI runs it on every push and
pull request (`.github/workflows/no-game-data.yml`). Run it yourself before
pushing:

```sh
python3 tools/check_no_game_data.py
python3 tools/check_no_game_data.py --history origin/master..HEAD   # every blob your commits add
```

The tree does carry upstream's screenshots in `docs/screenshots` (captures of
the game, not data from the disc) and a shader-pipeline seed of GPU render
state (no textures, models or audio).

## Relationship to upstream

The engine, game code and native platforms come from
[999sian/melee-pc](https://github.com/999sian/melee-pc). This fork changes them
only where the web or the VS profile needs it, and leaves the native platforms
in place, though only the web app is tested here. For the full game on desktop or mobile, use upstream's
[releases](https://github.com/999sian/melee-pc/releases) and its
[README](https://github.com/999sian/melee-pc#readme).

Fixes that aren't specific to this fork go back upstream as small, separate
pull requests: the macOS archive-load crash, the Pokémon Stadium crash and
hang, `__FILE__` paths in release binaries, plus several browser fixes (clock,
ARQ, input timing, audio) and two decomp-sync regressions.

More detail:

- [platforms/browser/README.md](platforms/browser/README.md): the browser
  platform, the bundle, netplay and how the game is compiled for wasm.
- [docs/netcode-plan.md](docs/netcode-plan.md): the rollback netcode, with the
  browser in §17.
- [docs/architecture.md](docs/architecture.md),
  [docs/porting-notes.md](docs/porting-notes.md),
  [docs/debugging.md](docs/debugging.md): upstream's engine docs, which still
  apply.

## License

Three situations, spelled out in [LICENSE.md](licenses/LICENSE.md):

- The decompiled game code in `src/melee` and `src/sysdolphin` is **not
  licensed** and remains the property of its copyright holders.
- The port code in `src/pc`, `tools`, `platforms`, `cmake` and `.github` is
  **GPL-3.0-or-later** ([COPYING](licenses/COPYING)).
- Bundled third-party components keep their own licenses.

Because the game code can't be relicensed, the repository as a whole is not
distributable under the GPL. No game assets are in this repository.
