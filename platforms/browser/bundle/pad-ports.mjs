// SPDX-License-Identifier: GPL-3.0-or-later
// The four controller ports, as the engine's adapter code sees them.
//
// src/pc/gcadapter.c reads one 37-byte report in the official adapter's
// format: four 9-byte ports. This module writes that report once a frame, when
// the engine asks (Module.meleePadRefresh), from two kinds of source:
//  - the ports of a real adapter opened through WebHID (gc-adapter.mjs), bytes
//    passed on as they came;
//  - gamepads with a profile, translated to the same bytes (gamepads.mjs).
// Sources take ports first come, first served, lowest free port first, so the
// first controller is always player 1 whichever socket of the adapter it is
// in. Pads the engine reads itself through SDL hold ports of their own (the
// engine says which), and those are left alone.

import { originOf, parseId, translate, translateState } from './gamepads.mjs';

const REPORT = 37;
const PORTS = 4;
const PRESENT = 0x30;

/**
 * Which source holds which port. assign() takes the keys of the sources that
 * exist right now, in order of preference, and a bit mask of ports that are
 * not ours to give; it returns the key on each port (or null). A source keeps
 * its port for as long as it exists. A port given up stays empty for one
 * call, so whoever reads the result always sees a controller leave before
 * another arrives (the engine takes a new controller's origin at that edge).
 */
export function createPortTable() {
  const ports = new Array(PORTS).fill(null);
  return {
    assign(keys, taken = 0) {
      const live = new Set(keys);
      const free = ports.map((key, p) => key === null && !(taken & (1 << p)));
      // Give way to an SDL pad that took a port of ours; that source moves.
      for (let p = 0; p < PORTS; p++) if (ports[p] !== null && taken & (1 << p)) ports[p] = null;
      for (const key of keys) {
        if (ports.includes(key)) continue;
        const p = free.indexOf(true);
        if (p < 0) break;
        free[p] = false;
        ports[p] = key;
      }
      for (let p = 0; p < PORTS; p++) if (ports[p] !== null && !live.has(ports[p])) ports[p] = null;
      return ports.slice();
    },
  };
}

/** A port's bytes as a Gamepad-shaped object in the standard layout, for controller-view.mjs. */
export function slotAsGamepad(s, origin, { id, index, label }) {
  const axis = (v, o, flip) => Math.max(-1, Math.min(1, ((v - o) / 80) * (flip ? -1 : 1)));
  const trigger = (v, o, digital) => ({ pressed: digital, touched: digital, value: Math.max(digital ? 1 : 0, Math.min(1, Math.max(0, v - o) / 140)) });
  const bit = (byte, mask) => ({ pressed: !!(byte & mask), touched: !!(byte & mask), value: byte & mask ? 1 : 0 });
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  buttons[0] = bit(s[1], 0x01);  // A (south)
  buttons[2] = bit(s[1], 0x02);  // B (west on a GameCube layout)
  buttons[1] = bit(s[1], 0x04);  // X (east)
  buttons[3] = bit(s[1], 0x08);  // Y (north)
  buttons[14] = bit(s[1], 0x10); // d-pad
  buttons[15] = bit(s[1], 0x20);
  buttons[13] = bit(s[1], 0x40);
  buttons[12] = bit(s[1], 0x80);
  buttons[9] = bit(s[2], 0x01);  // Start
  buttons[5] = bit(s[2], 0x02);  // Z
  buttons[7] = trigger(s[8], origin[8], !!(s[2] & 0x04)); // R
  buttons[6] = trigger(s[7], origin[7], !!(s[2] & 0x08)); // L
  return {
    id, index, label, connected: true, mapping: 'standard', kind: 'gamecube', buttons,
    axes: [axis(s[3], origin[3]), axis(s[4], origin[4], true), axis(s[5], origin[5]), axis(s[6], origin[6], true)],
  };
}

/**
 * `adapter` is createGcAdapter()'s object, `gamepads` installGamepads()'s.
 * refresh(taken) is what the engine calls each frame before it reads its
 * mailbox; pad(port) is what the page draws.
 */
export function createPadPorts({ adapter, gamepads, log = () => {}, now = () => performance.now() }) {
  const table = createPortTable();
  const report = new Uint8Array(REPORT);
  const translators = new Map(); // gamepad index -> { id, profile, state, slot }
  const held = new Array(PORTS).fill(null); // per port: { key, source, origin, originSent }
  let views = null;
  let hadAny = false;
  let lastEngineRefresh = -Infinity;
  let rumbleSeen = 0;
  const rumbling = new Map(); // gamepad index -> time the effect was last started

  function mailbox() {
    const m = globalThis.Module?.meleeGcAdapter;
    if (!m) return null; // engine not started yet: the report is only drawn
    if (!views) {
      views = {
        report: new Uint8Array(m.buffer, m.report, m.length),
        seq: new Uint32Array(m.buffer, m.seq, 1),
        rumble: new Uint8Array(m.buffer, m.rumble, 5),
        rumbleSeq: new Uint32Array(m.buffer, m.rumbleSeq, 1),
      };
      for (const port of held) if (port) port.originSent = false; // the engine has seen none of them yet
    }
    return views;
  }

  function sources() {
    const list = [];
    const hid = adapter?.slots();
    if (hid) {
      for (let n = 0; n < PORTS; n++) {
        const slot = hid.subarray(9 * n, 9 * n + 9);
        if (slot[0] & PRESENT) list.push({ key: `hid:${n}`, slot, hid: n, id: `Wii U adapter, socket ${n + 1}`, label: 'GameCube' });
      }
    }
    const seen = new Set();
    for (const { pad, profile } of gamepads.claimed()) {
      seen.add(pad.index);
      let t = translators.get(pad.index);
      if (!t || t.id !== pad.id || t.profile !== profile) {
        translators.set(pad.index, (t = { id: pad.id, profile, state: translateState(), slot: new Uint8Array(9) }));
      }
      translate(pad, profile, t.slot, t.state);
      const name = parseId(pad.id).name || 'controller';
      list.push({ key: `pad:${pad.index}`, slot: t.slot, pad, id: name, label: profile.raw ? 'GameCube' : 'Your layout' });
    }
    for (const index of translators.keys()) if (!seen.has(index)) translators.delete(index);
    return list;
  }

  // `engine` is the mailbox to write, or null to only work out who is where
  // (for the drawing, while the game is not asking).
  function compose(taken, engine) {
    const list = sources();
    const byKey = new Map(list.map((s) => [s.key, s]));
    const keys = table.assign(list.map((s) => s.key), taken);
    report.fill(0);
    report[0] = 0x21;
    let any = false;
    for (let p = 0; p < PORTS; p++) {
      const source = keys[p] === null ? null : byKey.get(keys[p]);
      if (!source) {
        held[p] = null;
        continue;
      }
      if (held[p]?.key !== source.key) {
        held[p] = { key: source.key, origin: source.pad ? originOf(source.slot) : source.slot.slice(), originSent: false };
        log(`controller: ${source.id} is player ${p + 1}`);
      }
      held[p].source = source;
      let bytes = source.slot;
      // The engine takes a port's first report as the controller's origin. A
      // real adapter's is passed on as it is; a translated pad has no power-on
      // moment, so its first report is a sane rest position instead.
      if (!held[p].originSent && engine) {
        held[p].originSent = true;
        if (source.pad) bytes = held[p].origin = originOf(source.slot);
      }
      report.set(bytes, 1 + 9 * p);
      any = true;
    }
    if (!engine) return;
    if (any || hadAny) {
      Atomics.add(engine.seq, 0, 1); // odd while it is written, as gcadapter.c expects
      engine.report.set(report);
      Atomics.add(engine.seq, 0, 1);
    }
    hadAny = any;
    rumble(engine);
  }

  // The game's motor requests come back per port: 0 stop, 1 rumble, 2 brake.
  function rumble(engine) {
    const seq = Atomics.load(engine.rumbleSeq, 0);
    const changed = seq !== rumbleSeen;
    rumbleSeen = seq;
    const toAdapter = new Uint8Array(PORTS);
    let adapterHasAny = false;
    for (let p = 0; p < PORTS; p++) {
      const source = held[p]?.source;
      const motor = engine.rumble[1 + p];
      if (source?.hid != null) {
        toAdapter[source.hid] = motor;
        adapterHasAny = true;
      } else if (source?.pad?.vibrationActuator) {
        const actuator = source.pad.vibrationActuator;
        const index = source.pad.index;
        if (motor === 1) {
          // Effects are timed; keep one running for as long as the game asks.
          if (!rumbling.has(index) || now() - rumbling.get(index) > 150) {
            rumbling.set(index, now());
            actuator.playEffect?.('dual-rumble', { duration: 250, strongMagnitude: 1, weakMagnitude: 1 })?.catch?.(() => {});
          }
        } else if (rumbling.delete(index)) {
          actuator.reset?.()?.catch?.(() => {});
        }
      }
    }
    if (changed && adapterHasAny) adapter.rumble(toAdapter);
  }

  let lastTaken = 0;
  return {
    /** Called by the engine before each controller read; `taken` has a bit per port an SDL pad holds. */
    refresh(taken = 0) {
      lastEngineRefresh = now();
      lastTaken = taken;
      compose(taken, mailbox());
    },
    /** Port `port` as controller-view.mjs wants it, or null when the port is empty. */
    pad(port) {
      // Nothing calls refresh() until the game runs (or while it loads): keep the drawing live.
      if (port === 0 && now() - lastEngineRefresh > 250) compose(lastTaken, null);
      const h = held[port];
      if (!h?.source) return null;
      return slotAsGamepad(h.source.slot, h.origin, { id: h.source.id, index: 100 + port, label: `P${port + 1} ${h.source.label}` });
    },
    /** The key of the source on each port (tests and the log). */
    ports: () => held.map((h) => h?.key ?? null),
  };
}
