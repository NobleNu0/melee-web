// SPDX-License-Identifier: GPL-3.0-or-later
// The official Wii U / Switch GameCube controller adapter (WUP-028; a Mayflash
// in Wii U mode is the same device) through WebHID, Chrome and Edge only.
// Browsers do not expose it as a gamepad, so the page opens it (the user picks
// it once; later visits reconnect without asking), starts its report stream
// and hands every 37-byte 0x21 report to src/pc/gcadapter.c through a
// seqlock'd buffer in shared wasm memory, where the 1000 Hz input thread
// parses it exactly as the native build does (raw 8-bit axes, origin at the
// first report, adapter slot N = PAD port N). Rumble comes back the same way.

const VENDOR = 0x057e;
const PRODUCT = 0x0337;
const REPORT = 37;
const EMPTY = new Uint8Array(REPORT).fill(0, 1);
EMPTY[0] = 0x21;

export const webHidAvailable = () => typeof navigator !== 'undefined' && !!navigator.hid;
const isAdapter = (d) => d.vendorId === VENDOR && d.productId === PRODUCT;

export function createGcAdapter({ onStatus = () => {}, log = console.log } = {}) {
  let device = null;
  let latest = null; // last report, for the controller view
  let views = null;
  let rumbleSeen = 0;
  const origins = [null, null, null, null];

  function mailbox() {
    const m = globalThis.Module?.meleeGcAdapter;
    if (!m) return null; // engine not started yet: reports just update the view
    views ??= {
      report: new Uint8Array(m.buffer, m.report, m.length),
      seq: new Uint32Array(m.buffer, m.seq, 1),
      rumble: new Uint8Array(m.buffer, m.rumble, 5),
      rumbleSeq: new Uint32Array(m.buffer, m.rumbleSeq, 1),
    };
    return views;
  }

  function deliver(report) {
    latest = report;
    const m = mailbox();
    if (!m) return;
    Atomics.add(m.seq, 0, 1); // odd: the poll thread skips a half-written report
    m.report.set(report);
    Atomics.add(m.seq, 0, 1);
  }

  async function send(id, data) {
    try {
      await device?.sendReport(id, data);
      return true;
    } catch (error) {
      log(`GC adapter: report 0x${id.toString(16)} failed: ${error.message}`);
      return false;
    }
  }

  async function open(candidate) {
    if (!candidate.opened) await candidate.open();
    device = candidate;
    origins.fill(null);
    candidate.oninputreport = (event) => {
      if (event.reportId !== 0x21) return;
      const report = new Uint8Array(REPORT);
      report[0] = 0x21;
      report.set(new Uint8Array(event.data.buffer, event.data.byteOffset, Math.min(REPORT - 1, event.data.byteLength)), 1);
      deliver(report);
    };
    // Start streaming: output report 0x13, as Dolphin and SDL's driver send.
    await send(0x13, new Uint8Array(0));
    log(`GC adapter: ${candidate.productName || 'WUP-028'} connected through WebHID`);
    onStatus('connected');
  }

  // Rumble: forward what the game asks for as output report 0x11.
  setInterval(() => {
    const m = mailbox();
    if (!m || !device) return;
    const seq = Atomics.load(m.rumbleSeq, 0);
    if (seq === rumbleSeen) return;
    rumbleSeen = seq;
    send(0x11, m.rumble.slice(1, 5));
  }, 16);

  if (webHidAvailable()) {
    navigator.hid.addEventListener('disconnect', ({ device: gone }) => {
      if (gone !== device) return;
      device = null;
      deliver(EMPTY); // every slot empty: the engine drops the pads
      log('GC adapter: disconnected');
      onStatus('disconnected');
    });
    navigator.hid.addEventListener('connect', ({ device: added }) => {
      if (!device && isAdapter(added)) open(added).catch((e) => log(`GC adapter: ${e.message}`));
    });
  }

  return {
    get connected() { return !!device; },
    /** Ask for the adapter (needs a user gesture: a click). */
    async request() {
      const [picked] = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR, productId: PRODUCT }] });
      if (picked) await open(picked);
      return !!picked;
    },
    /** Reopen an adapter this site was already allowed to use. */
    async reconnect() {
      if (!webHidAvailable()) return false;
      const known = (await navigator.hid.getDevices()).find(isAdapter);
      if (known) await open(known);
      return !!known;
    },
    /**
     * Slot `slot` as a Gamepad-API-shaped object in the standard layout that
     * controller-view.mjs draws as a GameCube controller, or null.
     */
    pad(slot) {
      const s = latest?.subarray(1 + 9 * slot, 10 + 9 * slot);
      if (!device || !s || !(s[0] & 0x30)) {
        origins[slot] = null;
        return null;
      }
      const origin = (origins[slot] ??= Array.from(s.subarray(3, 9)));
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
      buttons[7] = trigger(s[8], origin[5], !!(s[2] & 0x04)); // R
      buttons[6] = trigger(s[7], origin[4], !!(s[2] & 0x08)); // L
      return {
        id: `GameCube controller (Wii U adapter, port ${slot + 1})`, index: 100 + slot, connected: true,
        mapping: 'standard', timestamp: performance.now(), buttons,
        axes: [axis(s[3], origin[0]), axis(s[4], origin[1], true), axis(s[5], origin[2]), axis(s[6], origin[3], true)],
      };
    },
  };
}
