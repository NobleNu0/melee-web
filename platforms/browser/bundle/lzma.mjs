// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * LZMA decoder for melee.pak blocks (tools/browser/make_pak.py writes them
 * with Python's lzma module in the "alone" .lzma format: a 13-byte header of
 * properties, dictionary size and uncompressed size, then the LZMA1 stream).
 * Browsers only ship deflate/gzip decompression, and LZMA packs the game's
 * models and animations about a fifth smaller.
 *
 * A direct transcription of the reference decoder (Igor Pavlov's LzmaSpec,
 * public domain): range coder, literal/match/rep decoding and the state
 * machine, decoding into a preallocated output of the known size.
 */

const kNumStates = 12;
const kMatchMinLen = 2;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >>> 1);
const kNumAlignBits = 4;
const kNumLenToPosStates = 4;
const PROB_INIT = 1024; // kBitModelTotal / 2

const probs = (n) => new Uint16Array(n).fill(PROB_INIT);

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    if (buf[pos] !== 0) throw Error('lzma: bad range coder header');
    this.range = 0xFFFFFFFF;
    this.code = 0;
    for (let i = 1; i < 5; i++) this.code = ((this.code << 8) | buf[pos + i]) >>> 0;
    this.pos = pos + 5;
    if (this.code === this.range) throw Error('lzma: bad range coder header');
  }

  bit(p, i) {
    let prob = p[i];
    const bound = (this.range >>> 11) * prob;
    let result;
    if (this.code < bound) {
      prob += (2048 - prob) >>> 5;
      this.range = bound;
      result = 0;
    } else {
      prob -= prob >>> 5;
      this.code -= bound;
      this.range -= bound;
      result = 1;
    }
    p[i] = prob;
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
    return result;
  }

  direct(count) {
    let res = 0;
    do {
      this.range >>>= 1;
      this.code = (this.code - this.range) >>> 0;
      const t = 0 - (this.code >>> 31); // 0 or -1
      this.code = (this.code + (this.range & t)) >>> 0;
      res = ((res << 1) + (t + 1)) >>> 0;
      if (this.range < 0x1000000) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
      }
    } while (--count);
    return res;
  }

  tree(p, offset, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(p, offset + m);
    return m - (1 << bits);
  }

  reverseTree(p, offset, bits) {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(p, offset + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }
}

class LenDecoder {
  constructor() {
    this.choice = probs(2);
    this.low = probs(16 << 3);
    this.mid = probs(16 << 3);
    this.high = probs(1 << 8);
  }

  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}

/** Decode one "alone"-format LZMA stream into a new Uint8Array. */
export function decodeLzmaAlone(input, expectedSize) {
  let d = input[0];
  if (d >= 9 * 5 * 5) throw Error('lzma: bad properties');
  const lc = d % 9; d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;
  const dictSize = Math.max(4096, input[1] | (input[2] << 8) | (input[3] << 16) | (input[4] << 24) >>> 0);
  const lo = (input[5] | (input[6] << 8) | (input[7] << 16) | (input[8] << 24)) >>> 0;
  const hi = (input[9] | (input[10] << 8) | (input[11] << 16) | (input[12] << 24)) >>> 0;
  const known = !(lo === 0xFFFFFFFF && hi === 0xFFFFFFFF);
  const size = known ? lo + hi * 0x100000000 : expectedSize;
  if (size === undefined) throw Error('lzma: unknown uncompressed size');
  if (expectedSize !== undefined && size !== expectedSize) throw Error('lzma: size mismatch');
  void dictSize; // the whole output is the window

  const out = new Uint8Array(size);
  const rc = new RangeDecoder(input, 13);
  const literals = probs(0x300 << (lc + lp));
  const posSlot = probs(kNumLenToPosStates << 6);
  const posDecoders = probs(1 + kNumFullDistances - kEndPosModelIndex);
  const align = probs(1 << kNumAlignBits);
  const isMatch = probs(kNumStates << 4);
  const isRep = probs(kNumStates);
  const isRepG0 = probs(kNumStates);
  const isRepG1 = probs(kNumStates);
  const isRepG2 = probs(kNumStates);
  const isRep0Long = probs(kNumStates << 4);
  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;

  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  let state = 0;
  let n = 0;

  while (n < size) {
    const posState = n & pbMask;
    if (rc.bit(isMatch, (state << 4) + posState) === 0) {
      const prev = n > 0 ? out[n - 1] : 0;
      const base = 0x300 * (((n & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[n - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literals, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literals, base + symbol);
      out[n++] = symbol - 0x100;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len;
    if (rc.bit(isRep, state) !== 0) {
      if (n === 0) throw Error('lzma: rep match at start');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[n] = out[n - rep0 - 1];
          n++;
          continue;
        }
      } else {
        let dist;
        if (rc.bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDecoder.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(len, kNumLenToPosStates - 1);
      const slot = rc.tree(posSlot, lenState << 6, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const numDirectBits = (slot >>> 1) - 1;
        let dist = ((2 | (slot & 1)) << numDirectBits) >>> 0;
        if (slot < kEndPosModelIndex) {
          dist += rc.reverseTree(posDecoders, dist - slot, numDirectBits);
        } else {
          dist += rc.direct(numDirectBits - kNumAlignBits) << kNumAlignBits;
          dist += rc.reverseTree(align, 0, kNumAlignBits);
        }
        rep0 = dist >>> 0;
        if (rep0 === 0xFFFFFFFF) break; // end marker
      }
    }
    len += kMatchMinLen;
    if (rep0 >= n) throw Error('lzma: distance past the start');
    if (n + len > size) throw Error('lzma: match past the end');
    for (let src = n - rep0 - 1, end = n + len; n < end;) out[n++] = out[src++];
  }
  return out;
}
