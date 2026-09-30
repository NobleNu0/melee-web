#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Group the decomp's statics for the netplay snapshot in the wasm build.

The native links bracket libmelee_game's .data/.bss with src/pc/melee_state.ld
(ELF), section renaming (PE) or Mach-O sections, and src/pc/net_snapshot.c
copies the two ranges. wasm-ld has no linker scripts, but it defines
__start_NAME/__stop_NAME around every output segment whose name is a C
identifier. So this renames each game object's data segments in place:
.data.* -> melee_data and .bss.* -> melee_bss, which wasm-ld then merges into
two segments bracketed by __start_melee_data .. __stop_melee_bss.

(`#pragma clang section` would be the compiler-side way, but on wasm it emits
an unnamed segment instead.) Only the segment names in the object's `linking`
custom section change; relocations refer to segments by index.

The same translation units as melee_state.ld stay out: the sound machine (the
audio side owns it), wall-clock and render-side engine state, the pad alarm
and the disc request queues; so do three more that hold no simulation state
(EXCLUDED below).
"""
import sys
from pathlib import Path

# melee_state.ld's EXCLUDE_FILE list, by source file stem...
EXCLUDED = {"axdriver", "synth", "lbaudio_ax", "perf", "video", "vtxarray", "lbmthp", "card",
            "lb_0195", "devcom",
            # ...and what no fight frame writes as simulation state (measured by
            # MELEE_NET_STATE_DUMP=all over a match, then read): the SIS glyph
            # atlas, copied from the DOL once at boot (147 KiB of every snapshot);
            # the particle display module, whose counters stamp "matrix built this
            # present" and must not be rewound by a rollback, which renders nothing;
            # the netplay lobby's screen, which is never on screen in a fight.
            "sislib_font", "psdisp", "mnonlinelobby"}
DATA, BSS = b"melee_data", b"melee_bss"
WASM_SEGMENT_INFO = 5


def uleb(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def enc(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def rename(name):
    if name == b".data" or name.startswith(b".data."):
        return DATA
    if name == b".bss" or name.startswith(b".bss."):
        return BSS
    return name


def rewrite_linking(payload):
    version, pos = uleb(payload, 0)
    out = bytearray(enc(version))
    changed = 0
    while pos < len(payload):
        kind = payload[pos]
        size, body = uleb(payload, pos + 1)
        end = body + size
        sub = payload[body:end]
        if kind == WASM_SEGMENT_INFO:
            count, p = uleb(sub, 0)
            new = bytearray(enc(count))
            for _ in range(count):
                length, p = uleb(sub, p)
                name = bytes(sub[p:p + length])
                p += length
                align, p = uleb(sub, p)
                flags, p = uleb(sub, p)
                renamed = rename(name)
                changed += renamed != name
                new += enc(len(renamed)) + renamed + enc(align) + enc(flags)
            sub = bytes(new)
        out += bytes([kind]) + enc(len(sub)) + sub
        pos = end
    return bytes(out), changed


def rewrite(path):
    data = Path(path).read_bytes()
    if data[:4] != b"\0asm":
        raise SystemExit(f"{path}: not a wasm object")
    out = bytearray(data[:8])
    pos, changed = 8, 0
    while pos < len(data):
        sid = data[pos]
        size, body = uleb(data, pos + 1)
        end = body + size
        section = data[body:end]
        if sid == 0:
            name_len, p = uleb(section, 0)
            if section[p:p + name_len] == b"linking":
                payload, changed = rewrite_linking(section[p + name_len:])
                section = enc(name_len) + b"linking" + payload
        out += bytes([sid]) + enc(len(section)) + section
        pos = end
    if changed:
        Path(path).write_bytes(out)
    return changed


def main(argv):
    total = 0
    for arg in argv:
        stem = Path(arg).name.split(".")[0]
        if stem not in EXCLUDED:
            total += rewrite(arg)
    print(f"wasm_state_sections: renamed {total} segments in {len(argv)} objects")


if __name__ == "__main__":
    main(sys.argv[1:])
