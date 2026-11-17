// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPadPorts, createPortTable } from '../bundle/pad-ports.mjs';
import { adapterHelp } from '../bundle/gc-adapter.mjs';

test('the first controller is player 1, and a controller keeps its port', () => {
  const t = createPortTable();
  assert.deepEqual(t.assign(['hid:2']), ['hid:2', null, null, null]);
  assert.deepEqual(t.assign(['hid:0', 'hid:2']), ['hid:2', 'hid:0', null, null]);
  assert.deepEqual(t.assign(['hid:0', 'hid:2', 'pad:1']), ['hid:2', 'hid:0', 'pad:1', null]);
  // Player 1 unplugs: nobody moves up, and the port is empty for one call.
  assert.deepEqual(t.assign(['hid:0', 'pad:1']), [null, 'hid:0', 'pad:1', null]);
  assert.deepEqual(t.assign(['hid:0', 'pad:1', 'pad:3']), ['pad:3', 'hid:0', 'pad:1', null]);
});

test('a port is never handed straight from one controller to another', () => {
  const t = createPortTable();
  t.assign(['a']);
  assert.deepEqual(t.assign(['b']), [null, 'b', null, null], 'a left and b arrived in the same call');
  assert.deepEqual(t.assign(['b', 'c']), ['c', 'b', null, null]);
});

test('ports an SDL pad holds are kept clear, and a fifth controller waits', () => {
  const t = createPortTable();
  assert.deepEqual(t.assign(['a'], 0b0001), [null, 'a', null, null]);
  // An SDL pad arrives on the port a took: a moves on.
  assert.deepEqual(t.assign(['a'], 0b0011), [null, null, 'a', null]);
  assert.deepEqual(t.assign(['a', 'b', 'c'], 0b0011), [null, null, 'a', 'b']);
  assert.deepEqual(t.assign(['a', 'b', 'c'], 0), ['c', null, 'a', 'b']);
});

// An engine mailbox as src/pc/gcadapter.c registers it.
function engine() {
  const buffer = new SharedArrayBuffer(64);
  globalThis.Module = { meleeGcAdapter: { buffer, report: 0, length: 37, seq: 40, rumble: 48, rumbleSeq: 56 } };
  return {
    report: new Uint8Array(buffer, 0, 37),
    seq: new Uint32Array(buffer, 40, 1),
    rumble: new Uint8Array(buffer, 48, 5),
    rumbleSeq: new Uint32Array(buffer, 56, 1),
    port(p) { return [...this.report.subarray(1 + 9 * p, 10 + 9 * p)]; },
  };
}
const PROFILE = { v: 1, name: 'T', raw: true, buttons: { A: [{ b: 0 }] }, triggers: {},
  sticks: { stickX: { a: 0, sign: 1, center: 0 }, stickY: { a: 1, sign: -1, center: 0 } } };
function fakePad(index, actuator) {
  return { id: `Pad ${index}`, index, connected: true, mapping: '', vibrationActuator: actuator,
    buttons: [{ pressed: false, value: 0 }], axes: [0, 0] };
}

test('adapter sockets and translated pads share the four ports; rumble finds its way back', () => {
  const e = engine();
  const hid = new Uint8Array(36);
  hid.set([0x14, 0x01, 0, 130, 126, 128, 128, 30, 31], 18); // a controller in socket 3, A held
  const sent = [];
  const adapter = { slots: () => hid, rumble: (m) => sent.push([...m]) };
  const effects = [];
  const actuator = { playEffect: (...a) => { effects.push(a[0]); return Promise.resolve(); }, reset: () => { effects.push('reset'); return Promise.resolve(); } };
  const p1 = fakePad(1, actuator);
  p1.axes[0] = 1; // held hard right when it shows up
  const pads = [{ pad: p1, profile: PROFILE }];
  let clock = 0;
  const ports = createPadPorts({ adapter, gamepads: { claimed: () => pads }, now: () => clock });

  ports.refresh(0);
  assert.equal(e.seq[0], 2);
  assert.equal(e.report[0], 0x21);
  assert.deepEqual(ports.ports(), ['hid:2', 'pad:1', null, null]);
  assert.deepEqual(e.port(0), [0x14, 0x01, 0, 130, 126, 128, 128, 30, 31], 'the adapter\'s bytes, untouched');
  assert.deepEqual(e.port(1), [0x14, 0, 0, 128, 128, 128, 128, 0, 0], 'a translated pad starts from a sane origin');
  ports.refresh(0);
  assert.deepEqual(e.port(1), [0x14, 0, 0, 255, 128, 128, 128, 0, 0]);
  assert.equal(ports.pad(1).axes[0], 1);
  assert.equal(ports.pad(1).kind, 'gamecube');
  assert.equal(ports.pad(2), null);

  // The game rumbles players 1 and 2: socket 3 of the adapter, and the pad.
  e.rumble.set([0x11, 1, 1, 0, 0]);
  e.rumbleSeq[0]++;
  ports.refresh(0);
  assert.deepEqual(sent, [[0, 0, 1, 0]]);
  assert.deepEqual(effects, ['dual-rumble']);
  clock = 200;
  ports.refresh(0);
  assert.deepEqual(effects, ['dual-rumble', 'dual-rumble'], 'kept going while asked for');
  e.rumble.set([0x11, 0, 0, 0, 0]);
  e.rumbleSeq[0]++;
  ports.refresh(0);
  assert.deepEqual(sent.at(-1), [0, 0, 0, 0]);
  assert.equal(effects.at(-1), 'reset');

  // Everything unplugged: one empty report, then silence.
  hid.fill(0);
  pads.length = 0;
  const before = e.seq[0];
  ports.refresh(0);
  assert.equal(e.seq[0], before + 2);
  assert.deepEqual(e.port(0), new Array(9).fill(0));
  ports.refresh(0);
  assert.equal(e.seq[0], before + 2);
  delete globalThis.Module;
});

test('a pad seen before the game starts still gets its origin report when it does', () => {
  delete globalThis.Module;
  const p0 = fakePad(0);
  p0.axes[1] = -1;
  let clock = 1000;
  const ports = createPadPorts({ adapter: { slots: () => null }, gamepads: { claimed: () => [{ pad: p0, profile: PROFILE }] }, now: () => clock });
  assert.equal(ports.pad(0).label, 'P1 GameCube', 'drawn on the start screen with no engine yet');
  const e = engine();
  ports.refresh(0);
  assert.deepEqual(e.port(0), [0x10, 0, 0, 128, 128, 128, 128, 0, 0]);
  ports.refresh(0);
  assert.deepEqual(e.port(0), [0x10, 0, 0, 128, 255, 128, 128, 0, 0]);
  delete globalThis.Module;
});

test('the help for an adapter that will not connect fits the browser and system', () => {
  assert.match(adapterHelp('unsupported').join(' '), /WebHID.*PC/s);
  assert.match(adapterHelp('none', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)').join(' '), /Zadig/);
  assert.doesNotMatch(adapterHelp('none', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)').join(' '), /Zadig/);
  assert.ok(adapterHelp('open', 'Mozilla/5.0 (X11; Linux x86_64)').some((line) => line.startsWith('KERNEL==')));
  assert.ok(!adapterHelp('open', 'Mozilla/5.0 (Windows NT 10.0)').some((line) => line.startsWith('KERNEL==')));
});
