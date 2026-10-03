#!/usr/bin/env python3
"""Fail if anything git tracks is, or carries, Melee game data.

The repository holds code only; every player supplies their own disc, and the
one step that reads it (tools/browser/bundle.py) writes under build/. This
checks each tracked file (or, with --history, every blob a range of commits
added) by name and by content, so a renamed disc image, a gzipped pak or an
extracted HSD archive is caught as well as melee.iso:

  python3 tools/check_no_game_data.py                    # the tracked tree
  python3 tools/check_no_game_data.py --history A..B     # what commits A..B added

CI runs the first form (.github/workflows/no-game-data.yml).
"""
import argparse
import gzip
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Disc images, containers, the web bundle's pak and the disc's own file types.
EXTENSIONS = {'.iso', '.gcm', '.ciso', '.rvz', '.wia', '.gcz', '.wbfs', '.pak', '.dol', '.usd', '.hps',
              '.ssm', '.sem', '.mth', '.thp'}
MAGICS = {
    b'CISO': 'CISO disc image', b'RVZ\x01': 'RVZ disc image', b'WIA\x01': 'WIA disc image',
    b'\x01\xc0\x0b\xb1': 'GCZ disc image', b'WBFS': 'WBFS disc image', b'MPAK': 'web bundle pak (melee.pak)',
    b'THP\x00': 'THP movie', b'MTHP': 'MTH movie', b' HALPST': 'HPS music stream',
}
GAMECUBE_DISC_MAGIC = 0xC2339F3D  # big-endian word at 0x1C of every GameCube disc header
LARGEST = 4 * 2**20  # the biggest tracked file today is a 1.7 MB screenshot


def findings(name, data):
    path = Path(name)
    if path.suffix.lower() in EXTENSIONS or '.nkit.' in path.name.lower():
        yield f'{path.suffix or path.name} is a disc image or game file type'
    if len(data) > LARGEST:
        yield f'{len(data) / 2**20:.1f} MiB, over the {LARGEST // 2**20} MiB limit for tracked files'
    for head in (data, gunzipped(data)):
        if not head:
            continue
        for magic, what in MAGICS.items():
            if head.startswith(magic):
                yield f'content is a {what}'
        if len(head) >= 0x20 and struct.unpack_from('>I', head, 0x1C)[0] == GAMECUBE_DISC_MAGIC:
            yield f'content is a GameCube disc header ({head[:6].decode("ascii", "replace")})'
    # An HSD archive (.dat/.usd) begins with its own length, then its data
    # size, relocation count, root count and reference count.
    if len(data) >= 0x40:
        total, data_size, relocs, roots = struct.unpack_from('>IIII', data, 0)
        if total == len(data) and 0 < data_size < total and relocs * 4 + roots * 8 <= total - data_size:
            yield 'content looks like an HSD archive (.dat) from the disc'


def gunzipped(data, limit=1 << 16):
    if not data.startswith(b'\x1f\x8b'):
        return b''
    try:
        with gzip.GzipFile(fileobj=__import__('io').BytesIO(data)) as f:
            return f.read(limit)
    except (OSError, EOFError):
        return b''


def git(*args):
    return subprocess.run(['git', '-C', ROOT, *args], check=True, capture_output=True).stdout


def tracked():
    for name in git('ls-files', '-z').decode().split('\0'):
        if name and (ROOT / name).is_file():
            yield name, (ROOT / name).read_bytes()


def added(revs):
    """Every blob the commits in revs introduced, under the path it had."""
    for line in git('rev-list', '--objects', revs).decode().splitlines():
        sha, _, name = line.partition(' ')
        if name and git('cat-file', '-t', sha).strip() == b'blob':
            yield name, git('cat-file', 'blob', sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--history', metavar='REVS', help='check the blobs a commit range added, e.g. origin/master..HEAD')
    args = parser.parse_args()
    bad = 0
    count = 0
    for name, data in (added(args.history) if args.history else tracked()):
        count += 1
        for problem in findings(name, data):
            print(f'{name}: {problem}')
            bad += 1
    if bad:
        print(f'\n{bad} problem(s). Game data must stay out of the repository; '
              'tools/browser/bundle.py builds the web app from your own disc under build/.', file=sys.stderr)
        return 1
    print(f'No game data in {count} files.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
