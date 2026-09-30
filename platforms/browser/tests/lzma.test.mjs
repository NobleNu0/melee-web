// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeLzmaAlone } from '../bundle/lzma.mjs';

// Python's lzma is the encoder tools/browser/make_pak.py uses; encode with it
// exactly as the pak does and check the JS decoder reproduces every byte.
function encode(bytes) {
  const py = 'import sys,lzma; d=sys.stdin.buffer.read(); ' +
    'sys.stdout.buffer.write(lzma.compress(d, format=lzma.FORMAT_ALONE, preset=9 | lzma.PRESET_EXTREME))';
  const r = spawnSync('python3', ['-c', py], { input: Buffer.from(bytes), maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  return new Uint8Array(r.stdout);
}

function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24);
}

const cases = {
  'one byte': Uint8Array.of(42),
  zeros: new Uint8Array(256 * 1024),
  text: new TextEncoder().encode('Super Smash Bros. Melee '.repeat(5000) + 'Fox McCloud Falco Lombardi '.repeat(300)),
  random: Uint8Array.from({ length: 70000 }, rng(7)),
  // Structured binary with long-distance repeats: big-endian words, runs, and
  // blocks copied from far back, like the game's model and animation data.
  structured: (() => {
    const next = rng(11);
    const out = new Uint8Array(262144);
    for (let i = 0; i < out.length; i += 4) {
      const v = i % 4096 < 2048 ? i >>> 4 : next() * 3;
      out[i] = v >>> 8; out[i + 1] = v; out[i + 2] = next() & 7; out[i + 3] = 0x80;
    }
    out.copyWithin(200000, 1000, 30000);
    return out;
  })(),
};

for (const [name, bytes] of Object.entries(cases)) {
  test(`decodes Python's LZMA exactly: ${name}`, () => {
    const decoded = decodeLzmaAlone(encode(bytes), bytes.length);
    assert.equal(decoded.length, bytes.length);
    assert.ok(Buffer.from(decoded).equals(Buffer.from(bytes)));
  });
}

test('rejects a truncated stream', () => {
  const packed = encode(cases.text);
  assert.throws(() => decodeLzmaAlone(packed.subarray(0, 40), cases.text.length));
});
