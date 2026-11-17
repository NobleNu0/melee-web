// SPDX-License-Identifier: GPL-3.0-or-later
// Controllers the browser does not hand over in the "standard" layout.
//
// A standard-mapping gamepad (Xbox, PlayStation, Switch Pro and whatever else
// the browser knows) goes to the engine untouched, through SDL. Everything
// else has no agreed layout: a GameCube adapter in "PC" mode, a generic USB
// pad, anything a browser exposes raw. SDL would guess (button 0 is A, axes
// 2 and 3 are the C-stick), which is wrong for nearly all of them.
//
// So a pad with a profile is taken away from SDL and translated here into the
// 9 bytes one port of the official adapter reports ([status][buttons][buttons]
// [stick x][y][c x][y][L][R]); pad-ports.mjs hands those to the engine's
// adapter code (src/pc/gcadapter.c), the same path a real WUP-028 takes. A
// profile is either built in (the Mayflash family in PC mode) or made by the
// player with the setup wizard below and kept in localStorage, so any pad on
// any browser and OS can be made to work, whatever order it reports things in.

/** GameCube buttons, in wizard order; the bits are the adapter report's. */
export const BUTTON_BITS = {
  A: [1, 0x01], B: [1, 0x02], X: [1, 0x04], Y: [1, 0x08],
  Left: [1, 0x10], Right: [1, 0x20], Down: [1, 0x40], Up: [1, 0x80],
  Start: [2, 0x01], Z: [2, 0x02], R: [2, 0x04], L: [2, 0x08],
};
const STICKS = ['stickX', 'stickY', 'cX', 'cY'];
const WIRED = 0x10;
const RUMBLE_POWER = 0x04;
const STORAGE_KEY = 'melee-pad-profiles';

/** { vendor, product, name } from a Gamepad.id, as Chrome, Firefox or Safari writes it. */
export function parseId(id) {
  const text = String(id ?? '');
  let m = /^(.*?)\s*\((?:[^)]*?\s)?Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})\)\s*$/i.exec(text);
  if (m) return { name: m[1].trim(), vendor: m[2].toLowerCase().padStart(4, '0'), product: m[3].toLowerCase().padStart(4, '0') };
  m = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.*)$/i.exec(text);
  if (m) return { name: m[3].trim(), vendor: m[1].toLowerCase().padStart(4, '0'), product: m[2].toLowerCase().padStart(4, '0') };
  return { name: text.replace(/\s*\([^)]*\)\s*$/, '').trim(), vendor: '', product: '' };
}

/** What a saved profile is filed under: the device model, not the port it is in. */
export function deviceKey(id) {
  const { vendor, product, name } = parseId(id);
  return vendor && product ? `${vendor}:${product}` : `name:${name.toLowerCase()}`;
}

// The Mayflash 4-port and 2-port adapters and their rebrands (NEXiLUX and
// unbranded "GameCube Controller Adapter"), switched to PC: each port is a
// gamepad of 16 buttons and 6 axes that mirror the controller's raw bytes.
// Layout as Chrome and Firefox report it, cross-checked against Melee Light's
// table and SDL_GameControllerDB. Where the d-pad lands depends on the
// browser and OS: buttons 12-15, a hat on axis 9 (Chrome on Windows and
// macOS) or a pair of axes after the six real ones (Linux); all are read.
const MAYFLASH_PC = {
  v: 1, name: 'GameCube controller (adapter in PC mode)', raw: true,
  buttons: {
    A: [{ b: 1 }], B: [{ b: 2 }], X: [{ b: 0 }], Y: [{ b: 3 }], Z: [{ b: 7 }], L: [{ b: 4 }], R: [{ b: 5 }], Start: [{ b: 9 }],
    Up: [{ b: 12 }, { hat: 9, dir: 'up' }, { a: 7, dir: -1 }], Right: [{ b: 13 }, { hat: 9, dir: 'right' }, { a: 6, dir: 1 }],
    Down: [{ b: 14 }, { hat: 9, dir: 'down' }, { a: 7, dir: 1 }], Left: [{ b: 15 }, { hat: 9, dir: 'left' }, { a: 6, dir: -1 }],
  },
  sticks: {
    stickX: { a: 0, sign: 1, center: 0 }, stickY: { a: 1, sign: -1, center: 0 },
    cX: { a: 5, sign: 1, center: 0 }, cY: { a: 2, sign: -1, center: 0 },
  },
  triggers: { trigL: { a: 3, rest: -1, full: 1 }, trigR: { a: 4, rest: -1, full: 1 } },
};
const MAYFLASH_PRODUCTS = ['1843', '1844', '1845', '1846', '1847'];

/** The built-in profile for a pad the browser left unmapped, or null. */
export function builtinProfile(pad) {
  if (!pad || pad.mapping === 'standard' || pad.buttons.length < 10 || pad.axes.length < 6) return null;
  const { vendor, product, name } = parseId(pad.id);
  const known = vendor
    ? vendor === '0079' && MAYFLASH_PRODUCTS.includes(product)
    : /mayflash|nexilux/i.test(name) && /gamecube|\bgc\b/i.test(name);
  return known ? MAYFLASH_PC : null;
}

// A hat that browsers put on one axis: eight directions at -1, -5/7 ... 1,
// clockwise from up, and a rest value outside [-1, 1] (or 0).
const HAT = [['up'], ['up', 'right'], ['right'], ['down', 'right'], ['down'], ['down', 'left'], ['left'], ['up', 'left']];
export function hatDirections(value) {
  const step = (value + 1) * 3.5;
  const k = Math.round(step);
  return Number.isFinite(value) && k >= 0 && k <= 7 && Math.abs(step - k) < 0.2 ? HAT[k] : [];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

function triggerAmount(pad, source) {
  if (!source) return 0;
  if (source.b != null) return clamp01(pad.buttons[source.b]?.value ?? 0);
  const v = pad.axes[source.a] ?? source.rest;
  return source.full === source.rest ? 0 : clamp01((v - source.rest) / (source.full - source.rest));
}

function pressed(pad, source, profile, state) {
  if (source.b != null) return !!pad.buttons[source.b]?.pressed;
  if (source.trig != null) return triggerAmount(pad, profile.triggers?.[source.trig]) >= source.at;
  const on = source.hat != null
    ? hatDirections(pad.axes[source.hat]).includes(source.dir)
    : ((pad.axes[source.a] ?? 0) - (source.center ?? 0)) * source.dir > 0.5;
  if (!state) return on;
  // A button read off an axis that is already "pressed" when the pad is first
  // seen is an axis that rests there on this browser, not a press: it counts
  // only once it has been seen released.
  if (!state.seen.has(source)) {
    state.seen.add(source);
    if (on) state.stuck.add(source);
  } else if (!on) {
    state.stuck.delete(source);
  }
  return on && !state.stuck.has(source);
}

/** What translate() remembers about one pad between samples. */
export const translateState = () => ({ seen: new Set(), stuck: new Set() });

/**
 * One adapter port's 9 bytes for `pad` under `profile`. A raw profile gives
 * back the controller's own bytes (sticks 0..255 about 128, triggers as the
 * controller reports them); a wizard-made one scales each stick so its
 * measured reach is a GameCube stick's (about 100 units).
 */
export function translate(pad, profile, out = new Uint8Array(9), state = null) {
  out.fill(0);
  out[0] = WIRED | (pad.vibrationActuator ? RUMBLE_POWER : 0);
  for (const [name, [byte, bit]] of Object.entries(BUTTON_BITS)) {
    // Every source is looked at (no early exit), so each keeps its own state.
    let on = false;
    for (const source of profile.buttons?.[name] ?? []) on = pressed(pad, source, profile, state) || on;
    if (on) out[byte] |= bit;
  }
  STICKS.forEach((name, i) => {
    const s = profile.sticks?.[name];
    const units = profile.raw ? 127.5 : 100 / (s?.peak || 1);
    const v = s ? ((pad.axes[s.a] ?? s.center) - s.center) * s.sign : 0;
    out[3 + i] = clamp(Math.round(127.5 + v * units), 0, 255);
  });
  const full = profile.raw ? 255 : 215;
  out[7] = Math.round(triggerAmount(pad, profile.triggers?.trigL) * full);
  out[8] = Math.round(triggerAmount(pad, profile.triggers?.trigR) * full);
  if (!profile.raw) {
    // A trigger that is only a button still has to read as pressed home.
    if (out[2] & BUTTON_BITS.L[1]) out[7] = Math.max(out[7], full);
    if (out[2] & BUTTON_BITS.R[1]) out[8] = Math.max(out[8], full);
  }
  return out;
}

/**
 * The first report a port is given, which the engine takes as the
 * controller's origin (its rest position), as a console does at power-on. A
 * browser only reveals a pad once a button is pressed, so the player may well
 * be holding something by then: a stick near centre and a trigger not yet
 * half way are taken as they are, anything further as a nominal rest.
 */
export function originOf(slot) {
  const stick = (v) => (Math.abs(v - 128) <= 20 ? v : 128);
  const trigger = (v) => (v <= 127 ? v : 30);
  return Uint8Array.of(slot[0], 0, 0, stick(slot[3]), stick(slot[4]), stick(slot[5]), stick(slot[6]), trigger(slot[7]), trigger(slot[8]));
}

// ---- setup wizard ----------------------------------------------------------

const snapshot = (pad) => ({
  buttons: Array.from(pad.buttons, (b) => ({ pressed: !!b.pressed, value: b.value ?? (b.pressed ? 1 : 0) })),
  axes: Array.from(pad.axes),
});

export const WIZARD_STEPS = [
  ...['A', 'B', 'X', 'Y', 'Start', 'Z'].map((name) => ({ kind: 'button', name, prompt: `Press ${name}` })),
  { kind: 'trigger', name: 'L', trig: 'trigL', prompt: 'Press L all the way down, then let go' },
  { kind: 'trigger', name: 'R', trig: 'trigR', prompt: 'Press R all the way down, then let go' },
  ...['Up', 'Down', 'Left', 'Right'].map((name) => ({ kind: 'button', name, prompt: `Press ${name} on the D-pad` })),
  { kind: 'stick', name: 'stickX', prompt: 'Push the Control Stick all the way RIGHT, then let go' },
  { kind: 'stick', name: 'stickY', prompt: 'Push the Control Stick all the way UP, then let go' },
  { kind: 'stick', name: 'cX', prompt: 'Push the C-Stick all the way RIGHT, then let go' },
  { kind: 'stick', name: 'cY', prompt: 'Push the C-Stick all the way UP, then let go' },
];
const HOLD = 3; // samples a press must last, so a bounce is not taken
const REST = 20; // quiet samples that count as "let go"

/**
 * The setup wizard as a state machine over gamepad samples: feed() it one
 * sample a frame; it asks for each GameCube input in turn (`prompt`), learns
 * which button, axis or hat answers, and ends with a profile (`result`).
 * It starts by waiting for the pad to sit still, which is its rest position.
 */
export function createWizard({ name = 'Custom controller' } = {}) {
  const profile = { v: 1, name, raw: false, buttons: {}, sticks: {}, triggers: {} };
  let index = -1; // -1: learning the rest position
  let rest = null;
  let quiet = 0;
  let waited = 0;
  let last = null;
  let held = null; // { key, n } while a candidate is being confirmed
  let capture = null; // what the current press has moved, for trigger and stick steps
  let waitRelease = false;

  // What differs from the rest position in this sample.
  function active(sample) {
    const found = [];
    sample.buttons.forEach((b, i) => {
      if (b.pressed && !rest.buttons[i]?.pressed) found.push({ type: 'b', i, value: b.value });
    });
    sample.axes.forEach((v, i) => {
      const r = rest.axes[i] ?? 0;
      if (Math.abs(r) > 1.05) {
        // An axis that rests outside [-1, 1] is a hat (the d-pad).
        const dirs = hatDirections(v);
        if (dirs.length === 1) found.push({ type: 'hat', i, dir: dirs[0] });
      } else if (Math.abs(v - r) > 0.5) {
        found.push({ type: 'a', i, delta: v - r, r });
      }
    });
    return found;
  }
  const keyOf = (c) => `${c.type}${c.i}${c.type === 'a' ? Math.sign(c.delta) : c.dir ?? ''}`;

  function next() {
    index++;
    held = capture = null;
    waitRelease = true;
  }

  function finishTrigger(step) {
    const { axis, analogButton, buttons } = capture;
    const digital = [...buttons].filter((i) => i !== analogButton);
    if (axis) profile.triggers[step.trig] = { a: axis.i, rest: axis.r, full: axis.r + axis.peak };
    else if (analogButton != null) profile.triggers[step.trig] = { b: analogButton };
    if (digital.length) profile.buttons[step.name] = [{ b: digital[0] }];
    else if (profile.triggers[step.trig]) profile.buttons[step.name] = [{ trig: step.trig, at: 0.9 }];
  }

  function feed(pad) {
    const sample = snapshot(pad);
    if (index >= WIZARD_STEPS.length) return api;
    if (index < 0) {
      // Rest: nothing pressed and no axis moving for a moment.
      const still = last && sample.buttons.every((b) => !b.pressed) &&
        sample.axes.every((v, i) => Math.abs(v - last.axes[i]) < 0.05);
      quiet = still ? quiet + 1 : 0;
      last = sample;
      waited++;
      // (A pad with something stuck down never goes quiet: take it as it is.)
      if (quiet >= REST || waited >= 10 * REST) {
        rest = sample;
        next();
        waitRelease = false;
      }
      return api;
    }
    const step = WIZARD_STEPS[index];
    const found = active(sample).filter((c) => step.kind !== 'stick' || c.type === 'a');
    if (waitRelease) {
      if (!found.length) waitRelease = false;
      return api;
    }
    if (step.kind === 'button') {
      const c = found[0];
      if (!c) { held = null; return api; }
      const key = keyOf(c);
      held = held?.key === key ? { key, n: held.n + 1, c } : { key, n: 1, c };
      if (held.n >= HOLD) {
        profile.buttons[step.name] = [c.type === 'b' ? { b: c.i } : c.type === 'hat' ? { hat: c.i, dir: c.dir }
          : { a: c.i, dir: Math.sign(c.delta), center: c.r }];
        next();
      }
      return api;
    }
    // Trigger and stick steps watch one whole press: down, as far as it goes, up.
    if (!capture) {
      if (!found.length) return api;
      capture = { axis: null, analogButton: null, buttons: new Set(), n: 0 };
    }
    capture.n++;
    for (const c of found) {
      if (c.type === 'b') {
        capture.buttons.add(c.i);
        if (c.value > 0.02 && c.value < 0.98) capture.analogButton = c.i;
      } else if (c.type === 'a') {
        if (!capture.axis || capture.axis.i === c.i) {
          const peak = capture.axis && Math.abs(capture.axis.peak) > Math.abs(c.delta) ? capture.axis.peak : c.delta;
          capture.axis = { i: c.i, r: c.r, peak };
        }
      }
    }
    if (!found.length) {
      if (capture.n > HOLD) {
        if (step.kind === 'trigger') finishTrigger(step);
        else if (capture.axis) {
          const { i, r, peak } = capture.axis;
          profile.sticks[step.name] = { a: i, sign: Math.sign(peak), center: r, peak: Math.min(1, Math.abs(peak)) };
        }
        next();
        waitRelease = false;
      } else {
        capture = null; // a bounce
      }
    }
    return api;
  }

  const api = {
    feed,
    /** Leave the current input unassigned (the pad has no such control). */
    skip() { if (index >= 0 && index < WIZARD_STEPS.length) next(); return api; },
    get done() { return index >= WIZARD_STEPS.length; },
    get step() { return index; },
    get total() { return WIZARD_STEPS.length; },
    get prompt() {
      return index < 0 ? 'Let go of everything on the controller' : index < WIZARD_STEPS.length ? WIZARD_STEPS[index].prompt : 'Done';
    },
    get result() { return api.done ? profile : null; },
  };
  return api;
}

// ---- which pads are ours, and hiding them from SDL --------------------------

const validProfile = (p) => !!p && typeof p === 'object' && p.v === 1 && typeof p.buttons === 'object';

export function loadProfiles(storage) {
  try {
    const all = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
    return Object.fromEntries(Object.entries(all ?? {}).filter(([, p]) => validProfile(p)));
  } catch {
    return {};
  }
}

// SDL takes the first value it is told for an axis as that axis's rest
// position and reports nothing for it, and its browser driver only tells it
// about an axis when the value changes. A stick flicked from centre to the
// edge within one sample therefore lost its first flick. So the first look
// SDL gets at a pad is this copy, every axis a hair off; the true values that
// follow are a small first change, and everything after that is reported.
function primed(pad) {
  return {
    id: pad.id, index: pad.index, mapping: pad.mapping, connected: pad.connected,
    timestamp: (pad.timestamp || 0) + 0.001, buttons: pad.buttons, vibrationActuator: pad.vibrationActuator,
    axes: Array.from(pad.axes, (v) => (Math.abs(v) < 0.5 ? v + 0.02 : v - Math.sign(v) * 0.02)),
  };
}

/**
 * Sits between the Gamepad API and the engine. `raw()` is the browser's own
 * list. Pads with a profile (`claimed()`) are translated on this side, so
 * `navigator.getGamepads` is replaced by a view without them, which is what
 * SDL polls, and their connect events never reach SDL.
 */
export function installGamepads({ nav = navigator, win = window, storage, log = () => {} } = {}) {
  const original = nav.getGamepads?.bind(nav);
  const raw = () => (original ? Array.from(original() ?? []) : []);
  const profiles = loadProfiles(storage);
  const known = new Map(); // Gamepad.id -> its profile or null
  const muted = new Set(); // indices the wizard is listening to
  const told = new Set(); // indices SDL was sent a connect event for
  const sampled = new Set(); // indices SDL has polled

  function profileFor(pad) {
    if (!pad) return null;
    let profile = known.get(pad.id);
    if (profile === undefined) known.set(pad.id, (profile = profiles[deviceKey(pad.id)] ?? builtinProfile(pad)));
    return profile;
  }
  const hidden = (pad) => muted.has(pad.index) || !!profileFor(pad);

  if (original) {
    Object.defineProperty(nav, 'getGamepads', {
      configurable: true, writable: true,
      value: () => raw().map((pad) => {
        if (!pad || hidden(pad)) return null;
        if (sampled.has(pad.index)) return pad;
        sampled.add(pad.index);
        return primed(pad);
      }),
    });
  }

  function announce(type, pad) {
    const event = new Event(type);
    event.gamepad = pad;
    event.meleeSynthetic = true;
    win.dispatchEvent(event);
  }
  const forget = (index) => {
    const had = told.delete(index);
    return sampled.delete(index) || had;
  };
  // After a profile or the wizard changed who reads a pad: tell SDL about one
  // it should now see, or one it should let go of.
  function sync(pad) {
    const visible = pad.connected !== false && !hidden(pad);
    if (visible && !told.has(pad.index) && !sampled.has(pad.index)) {
      told.add(pad.index);
      announce('gamepadconnected', primed(pad));
    } else if (!visible && forget(pad.index)) {
      announce('gamepaddisconnected', pad);
    }
  }
  // The browser's own events, before SDL's listener gets them.
  const onNative = (connected) => (event) => {
    if (event.meleeSynthetic || !event.gamepad) return;
    const pad = event.gamepad;
    if (!connected) {
      muted.delete(pad.index);
      if (!forget(pad.index)) event.stopImmediatePropagation(); // SDL never knew it
      return;
    }
    event.stopImmediatePropagation();
    if (hidden(pad)) {
      log(`controller: ${parseId(pad.id).name || 'gamepad'} uses the layout "${profileFor(pad)?.name}"`);
    } else {
      told.add(pad.index);
      announce('gamepadconnected', primed(pad));
    }
  };
  win.addEventListener?.('gamepadconnected', onNative(true), true);
  win.addEventListener?.('gamepaddisconnected', onNative(false), true);

  const connected = () => raw().filter((pad) => pad && pad.connected);
  return {
    raw,
    connected,
    profileFor,
    /** Pads translated here, with the profile each uses. */
    claimed: () => connected().filter((pad) => !muted.has(pad.index) && profileFor(pad))
      .map((pad) => ({ pad, profile: profileFor(pad) })),
    /** Pads the engine reads through SDL. */
    passthrough: () => connected().filter((pad) => !hidden(pad)),
    /** True when the browser gave this pad no layout and nothing here knows one. */
    needsSetup: (pad) => !!pad && pad.mapping !== 'standard' && !profileFor(pad),
    hasCustom: (pad) => !!pad && !!profiles[deviceKey(pad.id)],
    /** Save (or with null, forget) the player's layout for this pad's model. */
    setProfile(pad, profile) {
      if (profile) profiles[deviceKey(pad.id)] = profile;
      else delete profiles[deviceKey(pad.id)];
      known.clear();
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(profiles)); } catch {}
      for (const other of connected()) sync(other);
    },
    /** While the wizard listens to a pad, the game must not. */
    mute(pad, on) {
      if (on) muted.add(pad.index);
      else muted.delete(pad.index);
      sync(pad);
    },
  };
}
