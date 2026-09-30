// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetplay, datagramRing, formatCode, inviteLink, localCode, normalizeCode } from '../bundle/netplay.mjs';

test('codes are read however a person types or pastes them', () => {
  assert.equal(normalizeCode('k3x-q2m-7a'), 'K3XQ2M7A');
  assert.equal(normalizeCode('#K3XQ2M7A'), 'K3XQ2M7A');
  assert.equal(normalizeCode('NAME#K3X Q2M 7A'), 'K3XQ2M7A');
  for (const bad of ['', 'K3XQ2M7', 'K3XQ2M7A9', 'K3XQ2M71', null, undefined]) {
    assert.equal(normalizeCode(bad), null, String(bad));
  }
  assert.equal(formatCode('K3XQ2M7A'), 'K3X-Q2M-7A');
});

test('a browser keeps its code, and invite links carry only the code', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const code = localCode(storage);
  assert.ok(normalizeCode(code));
  assert.equal(localCode(storage), code);
  assert.equal(inviteLink('K3XQ2M7A', 'https://melee.example/?online=host#x'), 'https://melee.example/?join=K3XQ2M7A');
});

// The layout net_web.c's WebRing has: head, tail, len[slots], data.
function fakeLink(slots = 4, bytes = 16) {
  const size = 8 + 4 * slots + slots * bytes;
  return { buffer: new SharedArrayBuffer(64 + 2 * size), tx: 64, rx: 64 + size, slots, bytes };
}

test('the datagram rings pass bytes in order, wrap, and drop when full or oversized', () => {
  const link = fakeLink();
  const rx = datagramRing(link, link.rx);
  const u32 = new Uint32Array(link.buffer);
  const got = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) assert.equal(rx.put(new Uint8Array([round, i, 7])), true);
    assert.equal(rx.put(new Uint8Array([9])), false, 'full');
    // The engine side consumes (net_web_recv): read the slots, advance the tail.
    datagramRing(link, link.rx).drain((bytes) => got.push([...bytes]));
  }
  assert.equal(got.length, 12);
  assert.deepEqual(got[5], [1, 1, 7]);
  assert.equal(rx.put(new Uint8Array(17)), false, 'oversized');
  assert.equal(u32[link.rx >> 2], 12, 'head counts every datagram ever written');
});

test('a host opened from a Discord invite hosts the room the invite names', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const own = createNetplay({ storage }).localCode();
  assert.equal(createNetplay({ storage, roomCode: 'svc-bjh-rz' }).localCode(), '#SVCBJHRZ');
  assert.equal(createNetplay({ storage, roomCode: 'bad!' }).localCode(), own, 'a bad code falls back');
  assert.equal(createNetplay({ storage }).localCode(), own, 'the saved code is untouched');
});
