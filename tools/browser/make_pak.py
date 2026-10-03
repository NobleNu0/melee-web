#!/usr/bin/env python3
"""Pack a GALE01 rev 2 disc image into melee.pak for the bundled web app.

The image is the player's own: a plain .iso/.gcm, or a CISO read in place.

The pak is a compact virtual disc: the 0x2440-byte header region, main.dol,
a rewritten FST and every FST file laid out back to back, with the gaps and
junk padding of the real image gone. platforms/browser/dvd.c reads it through
the same disc offsets it would read from an .iso, so the engine is unchanged;
only the host page's readDisc() differs (platforms/browser/bundle/pak-reader.mjs).

Files are ordered small game data first and streamed music (.hps) last, so the
page can prefetch everything a scene load touches (the "core" range) without
downloading the soundtrack.

Movies (.mth, 811 MB of the disc) are replaced by stubs unless --keep-movies:
copies of one real frame at the movie's own resolution, chained to each other,
played for about two seconds before the movie ends the way a real one does.
lbmthp.c preloads a 32-frame ring and rewinds its request counter when the
movie has no more frames than that, then streams past the end of the file and
asserts on a zero frame size, so a stub must be longer than the ring.

--vs-only packs for the VS-only profile (src/pc/profile.c): only the files it
can read (VS_ONLY_FILES below) go in; movies, trophies, the stages that are
not tournament-legal and the single-player modes' data are left out. They keep their FST entries, with offset and length 0,
so file numbering is unchanged and dvd.c can name a file the bundle lacks.

Layout (little-endian):
  0  magic 'MPAK'        4  version           8  block size
  12 block count         16 virtual size (u64)
  24 core end            28 reserved          32 content id (16 bytes)
  48 index: per block (u64 pak offset, u32 stored length, u32 raw length)
  ... blocks: compressed when that is smaller, else stored. Version 1
      compresses with raw deflate; version 2 (--lzma) with LZMA in the "alone"
      .lzma format, about a fifth smaller, which the page decodes with
      platforms/browser/bundle/lzma.mjs (browsers only ship deflate).
"""
import argparse
import concurrent.futures
import hashlib
import lzma
import re
import struct
import zlib
from pathlib import Path

MAGIC = b'MPAK'
HEADER_SIZE = 48
INDEX_ENTRY = struct.Struct('<QII')
HEADER_REGION = 0x2440
ALIGN = 32
STUB_FRAMES = 64  # > the 32-frame preload ring in lbmthp.c

# What the VS-only profile reads, from a file-open trace (dvd.c
# MELEE_DVD_TRACE) of the whole reachable game -- title, character and stage
# select, a match on every legal stage, pause, results, Training -- plus the
# files every selectable character and every legal stage can reach but one
# trace does not (another fighter's data, an alternate track). Everything
# else is left out; a miss is logged by name by dvd.c. The US game opens the
# .usd variant of a file that has one, so its .dat twin is left out too.
VS_ONLY_FILES = {
    # Legal stages (gr*.c): Pokemon Stadium loads its four transformations.
    'GrNBa.dat', 'GrNLa.dat', 'GrOp.dat', 'GrSt.dat', 'GrIz.dat', 'GrPs.usd',
    'GrPs1.dat', 'GrPs2.dat', 'GrPs3.dat', 'GrPs4.dat',
    # Scenes and interface: title, character/stage select, pause, results,
    # Training, HUD, common items, memory-card and rumble data read at boot.
    'GmTtAll.usd', 'GmPause.usd', 'GmRst.usd', 'GmTrain.usd', 'SdTrain.usd',
    'MnSlChr.usd', 'MnSlMap.usd', 'MnExtAll.usd', 'SdSlChr.usd', 'SdRst.usd', 'SdIntro.dat',
    'IfAll.usd', 'IfCoGet.dat', 'ItCo.usd', 'LbBf.dat', 'LbRb.dat', 'LbRf.dat',
    'LbMcGame.usd', 'NtMemAc.usd', 'PdPm.dat',
    # The netplay lobby (mnonlinelobby.c): main-menu backdrop and menu text.
    'MnMaAll.usd', 'SdMenu.usd',
    # Every stage load updates trophy flags from these tables
    # (Ground_801C5878 -> Toy_803124BC); the trophy models are not needed.
    'TyDatai.usd',
    # Sound: common banks, announcer, the legal stages' banks, and the bank of
    # every selectable fighter (zs is Zelda/Sheik, emblem Roy, mars Marth);
    # mhands because character select loads Master Hand as its no-pick fighter.
    'main.ssm', 'smash2.sem', 'pokemon.ssm', 'end.ssm', 'nr_name.ssm', 'nr_title.ssm',
    'nr_select.ssm', 'nr_vs.ssm', 'pstadium.ssm', 'pupupu.ssm', 'last.ssm', 'mhands.ssm',
    'captain.ssm', 'clink.ssm', 'dk.ssm', 'drmario.ssm', 'falco.ssm', 'fox.ssm', 'ice.ssm',
    'kirby.ssm', 'kirbytm.ssm', 'koopa.ssm', 'link.ssm', 'luigi.ssm', 'mario.ssm', 'mars.ssm',
    'mewtwo.ssm', 'ness.ssm', 'peach.ssm', 'pichu.ssm', 'pikachu.ssm', 'purin.ssm', 'samus.ssm',
    'yoshi.ssm', 'zs.ssm', 'gw.ssm', 'ganon.ssm', 'emblem.ssm',
    # Music: each legal stage's main track (StageParam, see Ground_801C24F8;
    # the profile never picks the alternates), the menu track (menu01 only,
    # gmMainLib_8015ECBC), the results screen and every franchise's victory
    # fanfare.
    'izumi.hps', 'old_kb.hps', 'ystory.hps', 'pstadium.hps', 'sp_zako.hps', 'sp_end.hps',
    'menu01.hps', 'vs_hyou1.hps', 'vs_hyou2.hps',
    'ff_dk.hps', 'ff_emb.hps', 'ff_flat.hps', 'ff_fox.hps', 'ff_fzero.hps', 'ff_ice.hps',
    'ff_kirby.hps', 'ff_link.hps', 'ff_mario.hps', 'ff_nes.hps', 'ff_poke.hps',
    'ff_samus.hps', 'ff_yoshi.hps',
}
# Per-fighter data, kept for every fighter: models, animations and costumes
# (Pl), effects (Ef, Kirby's copy abilities included) and the results-screen
# poses (GmRstM). Minus the 1P-only fighters: Crazy Hand, Giga Bowser, the
# wireframes and Sandbag.
VS_ONLY_PREFIXES = ('Pl', 'Ef', 'GmRstM')
VS_ONLY_EXCLUDED = ('PlCh', 'PlGk', 'PlBo', 'PlGl', 'PlSb')


# Costumes: the profile offers each fighter's default and first alternate
# only (gm_GetNumCostumesForCKind caps the count at 2). A fighter's costumes
# in the order its ft*.c init table lists them; Kirby's per-colour copy hats
# (PlKb<colour>Cp<fighter>) follow Kirby's two.
COSTUME_ORDER = {
    'Ca': 'Nr Gy Re Wh Gr Bu', 'Cl': 'Nr Re Bu Wh Bk', 'Dk': 'Nr Bk Re Bu Gr', 'Dr': 'Nr Re Bu Gr Bk',
    'Fc': 'Nr Re Bu Gr', 'Fe': 'Nr Re Bu Gr Ye', 'Fx': 'Nr Or La Gr', 'Gn': 'Nr Re Bu Gr La',
    'Kb': 'Nr Ye Bu Re Gr Wh', 'Kp': 'Nr Re Bu Bk', 'Lg': 'Nr Wh Aq Pi', 'Lk': 'Nr Re Bu Bk Wh',
    'Mr': 'Nr Ye Bk Bu Gr', 'Ms': 'Nr Re Gr Bk Wh', 'Mt': 'Nr Re Bu Gr', 'Nn': 'Nr Ye Aq Wh',
    'Ns': 'Nr Ye Bu Gr', 'Pc': 'Nr Re Bu Gr', 'Pe': 'Nr Ye Wh Bu Gr', 'Pk': 'Nr Re Bu Gr',
    'Pp': 'Nr Gr Or Re', 'Pr': 'Nr Re Bu Gr Ye', 'Sk': 'Nr Re Bu Gr Wh', 'Ss': 'Nr Pi Bk Gr La',
    'Ys': 'Nr Re Bu Ye Pi Aq', 'Zd': 'Nr Re Bu Gr Wh',
}
COSTUMES_KEPT = 2


def dropped_costume(name):
    """True for a costume past the ones the profile offers."""
    m = re.fullmatch(r'Pl([A-Z][a-z])([A-Z][a-z])\.(?:dat|usd)', name)
    if m and m.group(1) in COSTUME_ORDER:
        colours = COSTUME_ORDER[m.group(1)].split()
        return m.group(2) in colours[COSTUMES_KEPT:]
    m = re.fullmatch(r'PlKb([A-Z][a-z])Cp[A-Z][a-z]\.dat', name)
    return bool(m) and m.group(1) in COSTUME_ORDER['Kb'].split()[COSTUMES_KEPT:]


def vs_only_drops(name):
    """True for a file the VS-only profile never reads."""
    if name in VS_ONLY_FILES:
        return False
    return (not name.startswith(VS_ONLY_PREFIXES) or name.startswith(VS_ONLY_EXCLUDED) or
            dropped_costume(name))


def be32(data, offset):
    return struct.unpack_from('>I', data, offset)[0]


def align(value, to=ALIGN):
    return (value + to - 1) // to * to


# Compressed containers this script cannot read, by their magic. Dolphin
# converts each of them back to a plain image.
CONVERT_FIRST = {b'RVZ\x01': 'RVZ', b'WIA\x01': 'WIA', b'\x01\xc0\x0b\xb1': 'GCZ', b'WBFS': 'WBFS'}
CISO_MAGIC = b'CISO'
CISO_HEADER = 0x8000  # magic, u32 block size, then one present/absent byte per block


class Disc:
    """A GALE01 revision 2 image: a plain .iso/.gcm, or a CISO (the format
    Nintendont and many dumpers write), read in place without expanding it."""

    def __init__(self, path):
        self.file = open(path, 'rb')
        magic = self.file.read(4)
        if magic in CONVERT_FIRST:
            raise SystemExit(
                f'{path}: this is a {CONVERT_FIRST[magic]} image. Convert it to a plain ISO first: in Dolphin, '
                'right-click the game -> Convert File... -> Format: ISO (or `dolphin-tool convert -f iso -i IN -o OUT`).')
        self.ciso = None
        if magic == CISO_MAGIC:
            self.file.seek(4)
            block = struct.unpack('<I', self.file.read(4))[0]
            present = self.file.read(CISO_HEADER - 8)
            stored, self.ciso = 0, (block, [])
            for flag in present:
                self.ciso[1].append(CISO_HEADER + stored * block if flag else None)
                stored += bool(flag)
        self.header = self.read(0, HEADER_REGION)
        game_id, revision = self.header[:6], self.header[7]
        if game_id != b'GALE01':
            known = {b'GALP01': 'the PAL (Europe) release', b'GALJ01': 'the Japanese release'}
            what = known.get(game_id, f'game id {game_id.decode("ascii", "replace")!r}')
            raise SystemExit(f'{path}: this is {what}. The web app needs Super Smash Bros. Melee USA (GALE01).')
        if revision != 2:
            raise SystemExit(f'{path}: this is GALE01 revision {revision}. The web app needs revision 2 '
                             '(NTSC-U 1.02, the tournament standard).')
        self.dol_offset = be32(self.header, 0x420)
        self.fst_offset = be32(self.header, 0x424)
        self.fst = bytearray(self.read(self.fst_offset, be32(self.header, 0x428)))
        self.entries = be32(self.fst, 8)
        strings = self.entries * 12
        self.files = []  # (fst index, name, disc offset, length)
        self.paths = {}  # fst index -> full path, directories included
        dirs = [(self.entries, '')]  # (end index, prefix) of the open directories
        for i in range(1, self.entries):
            while i >= dirs[-1][0]:
                dirs.pop()
            word, offset, length = struct.unpack_from('>III', self.fst, i * 12)
            start = strings + (word & 0xFFFFFF)
            name = self.fst[start:self.fst.index(0, start)].decode('cp932')
            if word >> 24:
                dirs.append((length, f'{dirs[-1][1]}{name}/'))
                continue
            self.paths[i] = dirs[-1][1] + name
            self.files.append((i, name, offset, length))

    def read(self, offset, size):
        if self.ciso is None:
            self.file.seek(offset)
            data = self.file.read(size)
        else:
            data = self.read_ciso(offset, size)
        if len(data) != size:
            raise SystemExit('Short read: the disc image is truncated.')
        return data

    def read_ciso(self, offset, size):
        block, where = self.ciso
        out = bytearray()
        while size > 0:
            n, skip = divmod(offset, block)
            take = min(size, block - skip)
            if n >= len(where):
                break  # past the map: short read
            if where[n] is None:
                out += bytes(take)  # a block the dumper scrubbed reads as zeros
            else:
                self.file.seek(where[n] + skip)
                chunk = self.file.read(take)
                out += chunk
                if len(chunk) != take:
                    break
            offset, size = offset + take, size - take
        return bytes(out)


def stub_movie(disc, offset, length, frames):
    """A valid MTHP file of STUB_FRAMES copies of the smallest early frame
    with the same dimensions as this movie."""
    header = bytearray(disc.read(offset, 0x40))
    width, height = be32(header, 0x10), be32(header, 0x14)
    frame = frames.get((width, height))
    if frame is None:
        return disc.read(offset, length)  # no donor frame: keep the original
    frame = bytearray(frame)
    struct.pack_into('>I', frame, 0, len(frame))  # next frame is this frame again
    struct.pack_into('>I', header, 0x0C, max(be32(header, 0x0C), len(frame)))
    struct.pack_into('>I', header, 0x1C, STUB_FRAMES)
    struct.pack_into('>I', header, 0x20, 0x40)
    struct.pack_into('>I', header, 0x24, 0)
    struct.pack_into('>I', header, 0x28, len(frame))
    return bytes(header) + bytes(frame) * STUB_FRAMES


def donor_frames(disc):
    """Smallest of the first frames per movie resolution: the first frames of
    the opening and bonus movies are near-black."""
    best = {}
    for _, name, offset, length in disc.files:
        if not name.lower().endswith('.mth'):
            continue
        header = disc.read(offset, 0x40)
        size_key = (be32(header, 0x10), be32(header, 0x14))
        position, size = be32(header, 0x20), be32(header, 0x28)
        for _ in range(min(32, be32(header, 0x1C))):
            if not size or position + size > length:
                break
            frame = disc.read(offset + position, size)
            if size_key not in best or len(frame) < len(best[size_key]):
                best[size_key] = frame
            position += size
            size = be32(frame, 0)
    return best


def compress(raw):
    packer = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
    packed = packer.compress(raw) + packer.flush()
    return packed if len(packed) < len(raw) else raw


def compress_lzma(raw):
    packed = lzma.compress(raw, format=lzma.FORMAT_ALONE, preset=9 | lzma.PRESET_EXTREME)
    return packed if len(packed) < len(raw) else raw


def build(iso, out, block_size, keep_movies, jobs, vs_only=False, use_lzma=False):
    disc = Disc(iso)
    if vs_only:
        present = {name for _, name, _, length in disc.files if length}
        missing = sorted(VS_ONLY_FILES - present)
        if missing:
            raise SystemExit(f'{iso}: the image lacks files the VS-only app needs ({", ".join(missing[:8])}'
                             f'{", ..." if len(missing) > 8 else ""}). Is it a modified or trimmed copy?')
    frames = {} if keep_movies else donor_frames(disc)
    dol = disc.read(disc.dol_offset, disc.fst_offset - disc.dol_offset)

    header = bytearray(disc.header)
    dol_offset = align(HEADER_REGION, 256)
    fst_offset = align(dol_offset + len(dol))
    struct.pack_into('>III', header, 0x420, dol_offset, fst_offset, len(disc.fst))
    struct.pack_into('>I', header, 0x42C, len(disc.fst))

    music = lambda f: f[1].lower().endswith('.hps')
    ordered = [f for f in disc.files if not music(f)] + [f for f in disc.files if music(f)]
    position = align(fst_offset + len(disc.fst))
    placed = []  # (virtual offset, fst index, disc offset, length, data or None)
    core_end = position
    dropped = 0
    # The US game reads its sound banks from audio/us/ (lbaudio_ax.c picks the
    # directory by language); the same-named banks in audio/ are the Japanese
    # voices, which the profile's fixed English setting never loads.
    us_banks = {p.rsplit('/', 1)[1] for p in disc.paths.values() if p.startswith('audio/us/')}
    japanese_bank = lambda index, name: disc.paths[index] == f'audio/{name}' and name in us_banks
    for index, name, offset, length in ordered:
        if vs_only and (vs_only_drops(name) or japanese_bank(index, name)):
            struct.pack_into('>II', disc.fst, index * 12 + 4, 0, 0)
            dropped += length
            continue
        data = None
        if name.lower().endswith('.mth') and not keep_movies:
            data = stub_movie(disc, offset, length, frames)
            length = len(data)
        struct.pack_into('>II', disc.fst, index * 12 + 4, position, length)
        placed.append((position, offset, length, data))
        position = align(position + length)
        if not music((index, name)):
            core_end = position
    virtual_size = position

    # The virtual disc, assembled one block at a time so memory stays bounded.
    pieces = [(0, bytes(header)), (dol_offset, dol), (fst_offset, bytes(disc.fst))]
    pieces += [(v, (o, n, d)) for v, o, n, d in placed]

    def block_bytes(n):
        start, end = n * block_size, min((n + 1) * block_size, virtual_size)
        raw = bytearray(end - start)
        for virtual, piece in pieces:
            if isinstance(piece, tuple):
                offset, length, data = piece
            else:
                offset, length, data = None, len(piece), piece
            lo, hi = max(start, virtual), min(end, virtual + length)
            if lo >= hi:
                continue
            chunk = data[lo - virtual:hi - virtual] if data is not None else \
                disc.read(offset + lo - virtual, hi - lo)
            raw[lo - start:hi - start] = chunk
        return bytes(raw)

    count = (virtual_size + block_size - 1) // block_size
    pieces.sort(key=lambda p: p[0])
    out.parent.mkdir(parents=True, exist_ok=True)
    index = []
    content = hashlib.sha256()
    with open(out, 'wb') as pak, concurrent.futures.ProcessPoolExecutor(jobs) as pool:
        pak.write(b'\0' * (HEADER_SIZE + count * INDEX_ENTRY.size))
        offset = pak.tell()
        batch = 64
        for first in range(0, count, batch):
            raws = [block_bytes(n) for n in range(first, min(first + batch, count))]
            for raw, stored in zip(raws, pool.map(compress_lzma if use_lzma else compress, raws)):
                pak.write(stored)
                index.append((offset, len(stored), len(raw)))
                content.update(stored)
                offset += len(stored)
            print(f'{min(first + batch, count)} / {count} blocks', flush=True)
        pak.seek(0)
        version = 2 if use_lzma else 1
        pak.write(MAGIC + struct.pack('<IIIQII', version, block_size, count, virtual_size, core_end, 0))
        pak.write(content.digest()[:16])
        for entry in index:
            pak.write(INDEX_ENTRY.pack(*entry))
    print(f'{out}: {offset / 2**20:.1f} MiB pak, {virtual_size / 2**20:.1f} MiB virtual disc, '
          f'core {core_end / 2**20:.1f} MiB, {dropped / 2**20:.1f} MiB left out, id {content.hexdigest()[:32]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('iso', type=Path, help='your GALE01 revision 2 image (.iso, .gcm or .ciso)')
    parser.add_argument('out', type=Path)
    parser.add_argument('--block-size', type=int, default=256 * 1024)
    parser.add_argument('--keep-movies', action='store_true')
    parser.add_argument('--vs-only', action='store_true', help='leave out what the VS-only profile never reads')
    parser.add_argument('--lzma', action='store_true', help='compress blocks with LZMA (pak version 2)')
    parser.add_argument('--jobs', type=int, default=8)
    args = parser.parse_args()
    if args.block_size % ALIGN:
        raise SystemExit('--block-size must be a multiple of 32')
    build(args.iso, args.out, args.block_size, args.keep_movies, args.jobs, args.vs_only, args.lzma)


if __name__ == '__main__':
    main()
