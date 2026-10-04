# melee-web

**Super Smash Bros. Melee in your browser: 1v1 versus at 60 fps, with rollback
netplay over WebRTC.**

<img src="docs/media/first-visit.avif" width="100%" alt="Opening the page, picking Falco and Final Destination, and fighting">

Open a page, pick your character, and play: against a CPU, or online against a
friend with an invite link. Nothing to install. Bring your own copy of the game.

## Features

- **60 fps in the browser.** The game runs as WebAssembly and renders with
  WebGPU.
- **Rollback netplay over WebRTC.** Peer to peer, straight from the browser.
  Host a match and send your friend the link.
- **Tournament-ready.** The six legal stages; 4 stocks, 8 minutes, items off;
  UCF on; frozen Pokémon Stadium; everything unlocked.
- **Low input lag.** Controllers are read right before each frame, the same
  fix as Slippi's lag reduction.
- **Your controller.** Keyboard, any standard gamepad, or the official
  GameCube adapter (Chrome and Edge).
- **Quick to start.** Straight to the title screen, no menus to dig through.
  The game data streams in as needed and is cached for next time.

## Quick start

You need your own copy of **Super Smash Bros. Melee (USA, revision 2)** as an
`.iso`, `.gcm` or `.ciso` file, and Chrome or Edge.

**1. Install the build tools.** On macOS, with [Homebrew](https://brew.sh):

```sh
brew install python cmake ninja git llvm@22 gcc
```

<details>
<summary>Linux (Debian/Ubuntu) or an Intel Mac</summary>

On Linux, add LLVM's apt repository ([apt.llvm.org](https://apt.llvm.org)),
then:

```sh
sudo apt install python3 cmake ninja-build git gcc-13 clang-22 llvm-22-dev libclang-cpp22-dev
export LLVM_ROOT=/usr/lib/llvm-22
```

On an Intel Mac, run the Homebrew command above, then
`export LLVM_ROOT=/usr/local/opt/llvm@22`.
</details>

**2. Build it from your disc.** The first build takes a few minutes.

```sh
git clone https://github.com/NobleNu0/melee-web.git
cd melee-web
python3 tools/browser/bundle.py /path/to/your/melee.iso
```

**3. Play.**

```sh
python3 build/browser/bundle/serve.py
```

Open <http://127.0.0.1:5191/> and press **Play**.

The build contains game data from your disc, so it's for your own use: play it
locally, or host it somewhere private. Don't publish it.

## Play online

Online play goes through a small matchmaking server that you deploy for free on
Cloudflare. Everyone you play with uses the same one: one person deploys it and
shares the address.

```sh
cd platforms/browser/netplay-worker
npx wrangler login
npx wrangler deploy --var ALLOWED_ORIGINS:'*'
```

Then build with the address it prints:

```sh
python3 tools/browser/bundle.py /path/to/your/melee.iso --signal-url wss://melee-netplay.<your-subdomain>.workers.dev
```

Choose **Host online match** and send your friend the invite link, or have them
press **Join** and type your code.

More options (relays, local testing) are in
[platforms/browser/README.md](platforms/browser/README.md#online-play-netplay).

## Controls

| | |
|---|---|
| **Keyboard** | Move: arrows or WASD · C-stick: IJKL · A: X · B: Z · X: C · Y: V · L: Q · R: E · Z: Tab · Start: Enter · D-pad: TFGH |
| **Gamepad** | Any standard controller (Xbox, PlayStation, Switch Pro) |
| **GameCube adapter** | Official Wii U/Switch adapter, or a Mayflash in Wii U mode. Click **Connect GameCube adapter** on the page (Chrome and Edge). |

## Build options

| Flag | |
|---|---|
| `--signal-url wss://…` | Turn on online play (see [Play online](#play-online)). |
| `--sentry-dsn DSN` | Send anonymous crash reports to your Sentry project. |
| `--vercel DIR` | Also write a folder ready to deploy on Vercel (privately). |
| `--rebuild-engine` | Rebuild the engine after changing the code. |

## For developers

How the browser build works, the netplay internals and the 60 fps browser test
are in [platforms/browser/README.md](platforms/browser/README.md). Before
pushing, run `python3 tools/check_no_game_data.py`; CI runs it too.

## Credits and license

melee-web is a fork of [melee-pc](https://github.com/999sian/melee-pc), the PC
port of Melee built from the [doldecomp/melee](https://github.com/doldecomp/melee)
decompilation and [aurora](https://github.com/encounter/aurora). For the full
game on desktop and mobile, use melee-pc.

No game data is in this repository. The decompiled game code in `src/melee`
and `src/sysdolphin` is not licensed and belongs to its copyright holders; the
port code is GPL-3.0-or-later. Details are in
[licenses/LICENSE.md](licenses/LICENSE.md).
