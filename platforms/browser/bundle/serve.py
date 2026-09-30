#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Serve this folder for local play: python3 serve.py, then open the URL.

Standalone on purpose (standard library only), so the bundled folder works
wherever Python 3 does. It sends what any static host would need to: the
COOP/COEP headers the engine's threads require (coi-sw.js covers hosts that
cannot) and HTTP Range support, which melee.pak is read through.
"""
import argparse
import http.server
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
RANGE = re.compile(r'bytes=(\d*)-(\d*)$')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.js': 'text/javascript',
                      '.pak': 'application/octet-stream'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_head(self):
        match = RANGE.match(self.headers.get('Range', ''))
        path = self.translate_path(self.path)
        if not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        first, last = match.groups()
        if first:
            start, end = int(first), min(int(last) if last else size - 1, size - 1)
        else:
            start, end = max(size - int(last or 0), 0), size - 1
        if start > end or start >= size:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers()
            return None
        f = open(path, 'rb')
        f.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        self.remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, 'remaining', None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining:
            chunk = source.read(min(1 << 20, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=5191)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    print(f'http://{args.host}:{args.port}/')
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
