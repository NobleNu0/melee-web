// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinProfile, createWizard, deviceKey, hatDirections, installGamepads, originOf, parseId, translate, translateState,
} from '../bundle/gamepads.mjs';

// A Gamepad as the Gamepad API hands it over.
function pad({ id = 'Pad', index = 0, mapping = '', buttons = 16, axes = 6, timestamp = 1 } = {}) {
  return {
    id, index, mapping, connected: true, timestamp,
    buttons: Array.from({ length: buttons }, () => ({ pressed: false, touched: false, value: 0 })),
    axes: new Array(axes).fill(0),
  };
}
const press = (p, i, on = true, value = on ? 1 : 0) => { p.buttons[i] = { pressed: on, touched: on, value }; };

const MAYFLASH_CHROME = 'MAYFLASH GameCube Controller Adapter (Vendor: 0079 Product: 1843)';
const MAYFLASH_FIREFOX = '0079-1843-MAYFLASH GameCube Controller Adapter';

test('a Gamepad.id is read the way Chrome, Firefox and Safari write it', () => {
  assert.deepEqual(parseId(MAYFLASH_CHROME), { name: 'MAYFLASH GameCube Controller Adapter', vendor: '0079', product: '1843' });
  assert.deepEqual(parseId(MAYFLASH_FIREFOX), { name: 'MAYFLASH GameCube Controller Adapter', vendor: '0079', product: '1843' });
  assert.deepEqual(parseId('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'),
    { name: 'Wireless Controller', vendor: '054c', product: '09cc' });
  assert.deepEqual(parseId('79-1843-Generic   USB  Joystick'), { name: 'Generic   USB  Joystick', vendor: '0079', product: '1843' });
  assert.deepEqual(parseId('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), { name: 'Xbox 360 Controller', vendor: '', product: '' });
  // One profile serves every port of an adapter and both spellings of its id.
  assert.equal(deviceKey(MAYFLASH_CHROME), deviceKey(MAYFLASH_FIREFOX));
  assert.equal(deviceKey('Some Pad'), 'name:some pad');
});

test('only an unmapped Mayflash-family pad gets the built-in profile', () => {
  assert.ok(builtinProfile(pad({ id: MAYFLASH_CHROME })));
  assert.ok(builtinProfile(pad({ id: MAYFLASH_FIREFOX, axes: 10 })));
  assert.ok(builtinProfile(pad({ id: 'NEXILUX GAMECUBE Controller Adapter', axes: 10 })));
  assert.equal(builtinProfile(pad({ id: MAYFLASH_CHROME, mapping: 'standard' })), null);
  assert.equal(builtinProfile(pad({ id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)' })), null);
  assert.equal(builtinProfile(pad({ id: MAYFLASH_CHROME, buttons: 4, axes: 2 })), null);
});

test('a hat on one axis decodes to its directions, and rest to none', () => {
  assert.deepEqual(hatDirections(-1), ['up']);
  assert.deepEqual(hatDirections(-5 / 7), ['up', 'right']);
  assert.deepEqual(hatDirections(-3 / 7), ['right']);
  assert.deepEqual(hatDirections(1 / 7), ['down']);
  assert.deepEqual(hatDirections(5 / 7), ['left']);
  assert.deepEqual(hatDirections(1), ['up', 'left']);
  for (const rest of [9 / 7, 0, 3.2, NaN, undefined]) assert.deepEqual(hatDirections(rest), [], String(rest));
});

test('the Mayflash profile gives back the controller\'s raw bytes', () => {
  const p = pad({ id: MAYFLASH_CHROME, axes: 10 });
  p.axes[9] = 9 / 7; // hat at rest
  p.axes[3] = p.axes[4] = -0.75; // triggers at rest
  const profile = builtinProfile(p);
  assert.deepEqual([...translate(p, profile)], [0x10, 0, 0, 128, 128, 128, 128, 32, 32]);

  press(p, 1); // A
  press(p, 2); // B
  press(p, 0); // X
  press(p, 3); // Y
  press(p, 9); // Start
  press(p, 7); // Z
  press(p, 4); // L click
  press(p, 5); // R click
  p.axes[0] = 80 / 127.5; // stick right 80
  p.axes[1] = -100 / 127.5; // stick up 100 (up is negative on the wire)
  p.axes[5] = -50 / 127.5; // C left
  p.axes[2] = 60 / 127.5; // C down
  p.axes[3] = 1; // L home
  p.axes[4] = 0; // R half
  p.axes[9] = -1; // d-pad up
  const s = translate(p, profile);
  assert.equal(s[1], 0x01 | 0x02 | 0x04 | 0x08 | 0x80);
  assert.equal(s[2], 0x01 | 0x02 | 0x04 | 0x08);
  assert.deepEqual([...s.subarray(3)], [208, 228, 78, 68, 255, 128]);

  // The d-pad as buttons (Windows) and as two axes (Linux) reads the same.
  const q = pad({ id: MAYFLASH_FIREFOX, axes: 8 });
  press(q, 14);
  q.axes[6] = -1;
  assert.equal(translate(q, builtinProfile(q))[1], 0x40 | 0x10);
});

test('an axis that already reads as pressed when the pad appears is not a press', () => {
  const p = pad({ id: MAYFLASH_FIREFOX, axes: 8 });
  p.axes[6] = -1; // rests there on this browser
  const profile = builtinProfile(p);
  const state = translateState();
  assert.equal(translate(p, profile, undefined, state)[1], 0);
  assert.equal(translate(p, profile, undefined, state)[1], 0);
  p.axes[6] = 0; // seen released once: from now on it is a d-pad
  translate(p, profile, undefined, state);
  p.axes[6] = -1;
  assert.equal(translate(p, profile, undefined, state)[1], 0x10);
});

test('the origin is the first report, unless something is being held', () => {
  assert.deepEqual([...originOf(Uint8Array.of(0x14, 0xff, 0x0f, 131, 120, 128, 140, 34, 28))], [0x14, 0, 0, 131, 120, 128, 140, 34, 28]);
  assert.deepEqual([...originOf(Uint8Array.of(0x10, 0, 0, 228, 30, 128, 128, 240, 130))], [0x10, 0, 0, 128, 128, 128, 128, 30, 30]);
});

// Drive the wizard as a player would: hold a state for some frames, let go.
function run(wizard, p, change, frames = 6) {
  const before = { buttons: p.buttons.map((b) => ({ ...b })), axes: [...p.axes] };
  change(p);
  for (let i = 0; i < frames; i++) wizard.feed(p);
  p.buttons = before.buttons;
  p.axes = before.axes;
  for (let i = 0; i < 4; i++) wizard.feed(p);
}
function settle(wizard, p) {
  for (let i = 0; i < 30; i++) wizard.feed(p);
}

test('the wizard learns an Xbox-style pad and scales its sticks to a GameCube stick\'s reach', () => {
  const p = pad({ id: 'Some Pad (Vendor: 1234 Product: 5678)', buttons: 17, axes: 4 });
  const w = createWizard({ name: 'Some Pad' });
  assert.match(w.prompt, /Let go/);
  settle(w, p);
  assert.equal(w.step, 0);
  for (const b of [0, 1, 2, 3, 9, 5]) run(w, p, (x) => press(x, b)); // A B X Y Start Z
  // L: an analog button (value ramps); R: a plain button.
  assert.match(w.prompt, /Press L/);
  const before = p.buttons[6];
  for (const v of [0.3, 0.7, 1, 1, 1]) { press(p, 6, true, v); w.feed(p); }
  p.buttons[6] = before;
  for (let i = 0; i < 4; i++) w.feed(p);
  run(w, p, (x) => press(x, 7));
  for (const b of [12, 13, 14, 15]) run(w, p, (x) => press(x, b)); // d-pad up down left right
  run(w, p, (x) => { x.axes[0] = 1; });
  run(w, p, (x) => { x.axes[1] = -1; });
  run(w, p, (x) => { x.axes[2] = 1; });
  run(w, p, (x) => { x.axes[3] = -1; });
  assert.equal(w.done, true);
  const profile = w.result;

  press(p, 0);
  press(p, 13);
  press(p, 6, true, 0.5);
  press(p, 7);
  p.axes[0] = -1;
  p.axes[1] = -0.5;
  p.axes[3] = 1;
  const s = translate(p, profile);
  assert.equal(s[1], 0x01 | 0x40, 'A and d-pad down');
  assert.equal(s[2], 0x04, 'R is digital; L at half travel is not a click');
  assert.deepEqual([...s.subarray(3, 7)], [28, 178, 128, 28], 'full deflection is 100 units, up is positive');
  assert.equal(s[7], 108, 'L analog at half');
  assert.equal(s[8], 215, 'a digital-only trigger reads as pressed home');
  press(p, 6, true, 1);
  assert.equal(translate(p, profile)[2], 0x04 | 0x08, 'L fully in is a click');
});

test('the wizard learns a pad with axis triggers, a hat d-pad and short sticks', () => {
  const p = pad({ id: '0079-1800-Odd Adapter', buttons: 12, axes: 10 });
  p.axes[3] = p.axes[4] = -0.8; // triggers at rest
  p.axes[9] = 9 / 7; // hat at rest
  const w = createWizard();
  settle(w, p);
  for (const b of [1, 2, 0, 3, 9, 7]) run(w, p, (x) => press(x, b));
  run(w, p, (x) => { x.axes[3] = 0.9; press(x, 4); }); // L: axis and a click button
  run(w, p, (x) => { x.axes[4] = 0.9; }); // R: axis only
  for (const v of [-1, 1 / 7, 5 / 7, -3 / 7]) run(w, p, (x) => { x.axes[9] = v; }); // up down left right
  run(w, p, (x) => { x.axes[0] = 0.78; });
  run(w, p, (x) => { x.axes[1] = -0.78; });
  run(w, p, (x) => { x.axes[5] = 0.7; });
  w.skip(); // no C-stick up on this one
  assert.equal(w.done, true);
  const profile = w.result;
  assert.equal(profile.sticks.cY, undefined);

  p.axes[0] = 0.78;
  p.axes[1] = 0.39;
  p.axes[9] = -5 / 7; // up-right
  p.axes[4] = 0.9;
  const s = translate(p, profile);
  assert.equal(s[1], 0x80 | 0x20);
  assert.equal(s[2], 0x04, 'R clicks from its axis');
  assert.deepEqual([...s.subarray(3, 7)], [228, 78, 128, 128]);
  assert.equal(s[7], 0);
  assert.equal(s[8], 215);
});

test('a bounce is not taken for a press, and skip leaves an input out', () => {
  const p = pad({ buttons: 4, axes: 2 });
  const w = createWizard();
  settle(w, p);
  press(p, 2);
  w.feed(p);
  press(p, 2, false);
  for (let i = 0; i < 4; i++) w.feed(p);
  assert.equal(w.step, 0, 'one sample is a bounce');
  run(w, p, (x) => press(x, 2));
  assert.equal(w.step, 1);
  while (!w.done) w.skip();
  assert.deepEqual(w.result.buttons, { A: [{ b: 2 }] });
});

// A stand-in for the browser: navigator.getGamepads plus window events.
function browser(pads) {
  const listeners = { gamepadconnected: [], gamepaddisconnected: [] };
  const nav = { getGamepads: () => pads };
  const win = {
    addEventListener(type, fn, capture) { listeners[type][capture ? 'unshift' : 'push'](fn); },
    dispatchEvent(event) {
      let stopped = false;
      event.stopImmediatePropagation = () => { stopped = true; };
      for (const fn of listeners[event.type]) {
        if (stopped) break;
        fn(event);
      }
    },
  };
  const items = new Map();
  const storage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
  // What SDL would have: the events that reached it.
  const sdl = [];
  win.addEventListener('gamepadconnected', (e) => sdl.push(['connected', e.gamepad.index, [...e.gamepad.axes]]));
  win.addEventListener('gamepaddisconnected', (e) => sdl.push(['disconnected', e.gamepad.index]));
  const native = (type, gamepad) => win.dispatchEvent({ type, gamepad });
  return { nav, win, storage, sdl, native };
}
globalThis.Event ??= class { constructor(type) { this.type = type; } };

test('SDL is shown only the pads that are not translated here', () => {
  const xbox = pad({ id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, mapping: 'standard', buttons: 17, axes: 4 });
  const gc = pad({ id: MAYFLASH_CHROME, index: 1, axes: 10 });
  const b = browser([xbox, gc, null, null]);
  const g = installGamepads({ nav: b.nav, win: b.win, storage: b.storage });
  b.native('gamepadconnected', xbox);
  b.native('gamepadconnected', gc);
  assert.deepEqual(b.sdl.map((e) => e.slice(0, 2)), [['connected', 0]]);
  assert.deepEqual(b.nav.getGamepads().map((p) => p?.index ?? null), [0, null, null, null]);
  assert.deepEqual(g.claimed().map(({ pad: p }) => p.index), [1]);
  assert.deepEqual(g.passthrough().map((p) => p.index), [0]);
  assert.equal(g.needsSetup(xbox), false);
  assert.equal(g.needsSetup(gc), false);

  b.native('gamepaddisconnected', gc); // SDL never knew it
  b.native('gamepaddisconnected', xbox);
  assert.deepEqual(b.sdl.map((e) => e.slice(0, 2)), [['connected', 0], ['disconnected', 0]]);
});

test('SDL\'s first look at a pad is a hair off centre, so its first real sample is a change', () => {
  const xbox = pad({ index: 0, mapping: 'standard', buttons: 17, axes: 4, timestamp: 50 });
  xbox.axes[2] = -1; // something resting at an end
  const b = browser([xbox]);
  installGamepads({ nav: b.nav, win: b.win, storage: b.storage });
  // Connected before the engine runs: SDL's first poll is the primed copy.
  const first = b.nav.getGamepads()[0];
  assert.deepEqual(first.axes, [0.02, 0.02, -0.98, 0.02]);
  assert.notEqual(first.timestamp, xbox.timestamp);
  assert.equal(b.nav.getGamepads()[0], xbox);
  // Connected while it runs: the connect event carries the primed copy.
  b.native('gamepaddisconnected', xbox);
  b.native('gamepadconnected', xbox);
  assert.deepEqual(b.sdl.at(-1), ['connected', 0, [0.02, 0.02, -0.98, 0.02]]);
});

test('a layout from the wizard takes the pad from SDL, is remembered, and can be forgotten', () => {
  const odd = pad({ id: 'Odd Pad (Vendor: 1111 Product: 2222)', index: 2, buttons: 12, axes: 4 });
  const b = browser([null, null, odd]);
  const g = installGamepads({ nav: b.nav, win: b.win, storage: b.storage });
  b.native('gamepadconnected', odd);
  assert.equal(g.needsSetup(odd), true);
  assert.equal(b.nav.getGamepads()[2].index, 2);

  g.mute(odd, true); // the wizard is listening
  assert.deepEqual(b.sdl.at(-1), ['disconnected', 2]);
  assert.equal(b.nav.getGamepads()[2], null);
  const profile = { v: 1, name: 'Odd', raw: false, buttons: { A: [{ b: 0 }] }, sticks: {}, triggers: {} };
  g.setProfile(odd, profile);
  g.mute(odd, false);
  assert.equal(b.sdl.length, 2, 'still hidden: SDL hears nothing more');
  assert.equal(g.claimed()[0].profile.name, 'Odd');
  assert.equal(g.hasCustom(odd), true);

  // A later visit finds the layout in storage, for any pad of that model.
  const again = browser([pad({ id: '1111-2222-Odd Pad', index: 0, buttons: 12, axes: 4 })]);
  again.storage.setItem('melee-pad-profiles', b.storage.getItem('melee-pad-profiles'));
  const g2 = installGamepads({ nav: again.nav, win: again.win, storage: again.storage });
  assert.equal(g2.claimed().length, 1);

  g.setProfile(odd, null);
  assert.deepEqual(b.sdl.at(-1).slice(0, 2), ['connected', 2]);
  assert.equal(g.claimed().length, 0);
});

test('damaged stored layouts are ignored', () => {
  const b = browser([]);
  b.storage.setItem('melee-pad-profiles', '{"1111:2222": {"v": 9}, "x": 3');
  assert.doesNotThrow(() => installGamepads({ nav: b.nav, win: b.win, storage: b.storage }));
  b.storage.setItem('melee-pad-profiles', '{"1111:2222": {"v": 9}, "3333:4444": null}');
  const g = installGamepads({ nav: b.nav, win: b.win, storage: b.storage });
  assert.equal(g.profileFor(pad({ id: 'P (Vendor: 1111 Product: 2222)', buttons: 4, axes: 2 })), null);
});
