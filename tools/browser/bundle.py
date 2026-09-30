#!/usr/bin/env python3
"""Assemble the portable web app: engine + the player's own disc as melee.pak.

  python3 tools/browser/build.py --jobs 8           # the engine, once
  python3 tools/browser/bundle.py /path/to/GALE01.iso
  python3 build/browser/bundle/serve.py             # or copy the folder to any host

The output folder is self-contained: index.html, the engine (wasm with debug
names stripped), melee.pak (make_pak.py --vs-only: the disc's files the
VS-only profile reads, compressed) and a standard-library serve.py. The page
always runs the VS-only profile (src/pc/profile.c). It contains game data from
your disc, so it is for your own use; do not publish it.
"""
import argparse
import gzip
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from common import BUILD, ROOT, SDK

RUNTIME = BUILD / 'runtime/platforms/browser'
SOURCES = ROOT / 'platforms/browser'


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('iso', help='your GALE01 revision 2 .iso/.gcm')
    parser.add_argument('--out', default=str(BUILD / 'bundle'))
    parser.add_argument('--repack', action='store_true', help='rebuild melee.pak even if it is up to date')
    parser.add_argument('--jobs', type=int, default=8)
    parser.add_argument('--sentry-dsn', default=os.environ.get('MELEE_SENTRY_DSN', ''),
                        help='report crashes to this Sentry project (default: $MELEE_SENTRY_DSN; empty = off)')
    parser.add_argument('--vercel', metavar='DIR',
                        help='also write a static deploy folder (and DIR.zip) for Vercel: no serve.py, plus vercel.json')
    args = parser.parse_args()
    out, iso = Path(args.out).resolve(), Path(args.iso).resolve()
    if args.sentry_dsn and not re.fullmatch(r'https?://[0-9a-f]+@[\w.-]+(:\d+)?/\d+', args.sentry_dsn):
        raise SystemExit(f'--sentry-dsn does not look like a Sentry DSN (https://KEY@HOST/PROJECT): {args.sentry_dsn}')

    engine = RUNTIME / 'melee_browser.wasm'
    if not engine.exists():
        raise SystemExit('No engine build: run tools/browser/build.py first.')
    out.mkdir(parents=True, exist_ok=True)

    pak = out / 'melee.pak'
    inputs = [iso, ROOT / 'tools/browser/make_pak.py']
    stamp = out / '.pak-options'
    options = f'{iso}\nvs_only=1\nlzma=1\n'
    if (args.repack or not pak.exists() or not stamp.exists() or stamp.read_text() != options or
            any(p.stat().st_mtime > pak.stat().st_mtime for p in inputs)):
        subprocess.run([sys.executable, ROOT / 'tools/browser/make_pak.py', iso, pak, '--jobs', str(args.jobs),
                        '--vs-only', '--lzma'], check=True)
        stamp.write_text(options)

    # Function names are kept (about 0.2 MB gzipped): a crash report from a
    # player's machine then names the functions instead of bare offsets.
    wasm_opt = SDK / 'upstream/bin/wasm-opt'
    # The features melee_browser links with (platforms/browser/CMakeLists.txt).
    # Not --all-features: that lets wasm-opt re-encode imports in forms
    # browsers reject ("Invalid import kind 127").
    features = ['--mvp-features', '--enable-threads', '--enable-bulk-memory', '--enable-bulk-memory-opt',
                '--enable-call-indirect-overlong', '--enable-multivalue', '--enable-mutable-globals',
                '--enable-nontrapping-float-to-int', '--enable-reference-types', '--enable-sign-ext']
    subprocess.run([wasm_opt, '--strip-dwarf', '--strip-producers', *features,
                    engine, '-o', out / 'melee_browser.wasm'], check=True)
    # Shipped gzipped (about a third of the size); app.mjs inflates it.
    with open(out / 'melee_browser.wasm', 'rb') as src, gzip.open(out / 'melee_browser.wasm.gz', 'wb', 9) as dst:
        shutil.copyfileobj(src, dst)
    (out / 'melee_browser.wasm').unlink()
    for name in ('melee_browser.js', 'coi-sw.js', 'gpu-preflight.mjs'):
        shutil.copy2(RUNTIME / name if name.startswith('melee') else SOURCES / name, out / name)
    # Shader seed (merge_pipeline_caches.py): every pipeline the VS-only
    # profile draws with, compiled behind "Preparing graphics" on a first visit.
    shutil.copy2(ROOT / 'tools/browser/vs_pipeline_cache.db.gz', out / 'initial_pipeline_cache.db.gz')
    (out / 'initial_pipeline_cache.db').unlink(missing_ok=True)
    for name in ('app.mjs', 'controller-view.mjs', 'gc-adapter.mjs', 'lzma.mjs', 'lzma.worker.mjs', 'pak-reader.mjs',
                 'pak-prefetch.worker.mjs', 'telemetry.mjs', 'serve.py'):
        shutil.copy2(SOURCES / 'bundle' / name, out / name)
    shutil.copytree(SOURCES / 'bundle/vendor', out / 'vendor', dirs_exist_ok=True)
    # index.html with this build's id (engine hash + pak content id, what a
    # crash report's release names) and the Sentry DSN, if any.
    engine_hash = hashlib.sha256((out / 'melee_browser.wasm.gz').read_bytes()).hexdigest()[:10]
    with open(pak, 'rb') as f:
        pak_id = f.read(48)[32:48].hex()[:8]
    page = (SOURCES / 'bundle/index.html').read_text()
    page = page.replace('<meta name="sentry-dsn" content="">', f'<meta name="sentry-dsn" content="{args.sentry_dsn}">')
    page = page.replace('<meta name="melee-release" content="dev">',
                        f'<meta name="melee-release" content="melee-web@{engine_hash}-{pak_id}">')
    (out / 'index.html').write_text(page)
    print(f'release melee-web@{engine_hash}-{pak_id}, crash reports {"on" if args.sentry_dsn else "off"}')
    if args.vercel:
        write_vercel(out, Path(args.vercel).resolve())

    total = sum(p.stat().st_size for p in out.iterdir() if p.is_file())
    for p in sorted(out.iterdir()):
        if p.is_file() and not p.name.startswith('.'):
            print(f'{p.stat().st_size / 2**20:9.1f} MiB  {p.name}')
    print(f'{total / 2**20:9.1f} MiB  {out}')


# Static hosting on Vercel. The engine's threads need a cross-origin isolated
# page; vercel.json sends the headers, and coi-sw.js still covers a deployment
# that ignores it. melee.pak is read with Range requests where the CDN serves
# them and downloaded once, whole, where it does not (pak-reader.mjs).
VERCEL_JSON = {
    'headers': [
        {'source': '/(.*)', 'headers': [
            {'key': 'Cross-Origin-Opener-Policy', 'value': 'same-origin'},
            {'key': 'Cross-Origin-Embedder-Policy', 'value': 'require-corp'},
            {'key': 'Cross-Origin-Resource-Policy', 'value': 'same-origin'},
        ]},
        {'source': '/(.*)\\.(pak|gz)', 'headers': [
            {'key': 'Content-Type', 'value': 'application/octet-stream'},
        ]},
    ],
}


def write_vercel(bundle, dest):
    import json
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for p in sorted(bundle.iterdir()):
        if p.name.startswith('.') or p.name == 'serve.py':
            continue
        if p.is_dir():
            shutil.copytree(p, dest / p.name)
        else:
            shutil.copy2(p, dest / p.name)
    (dest / 'vercel.json').write_text(json.dumps(VERCEL_JSON, indent=2) + '\n')
    archive = shutil.make_archive(str(dest), 'zip', root_dir=dest)
    files = [p for p in dest.rglob('*') if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    print(f'Vercel folder {dest}: {total / 1e6:.2f} MB ({total / 2**20:.2f} MiB) in {len(files)} files')
    print(f'Vercel zip    {archive}: {Path(archive).stat().st_size / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
