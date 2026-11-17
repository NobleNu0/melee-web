// SPDX-License-Identifier: GPL-3.0-or-later
// The official Wii U / Switch GameCube controller adapter (WUP-028; a Mayflash
// or other third-party adapter switched to "Wii U / Switch" is the same
// device) through WebHID, in Chrome and Edge. Browsers do not expose it as a
// gamepad, so the page opens it (the user picks it once; later visits
// reconnect without asking), starts its report stream and keeps the newest
// 37-byte 0x21 report. pad-ports.mjs hands the controllers in it to the
// engine (src/pc/gcadapter.c parses them as the native build does: raw 8-bit
// axes, origin at the first report) and sends the game's rumble back.

const VENDOR = 0x057e;
const PRODUCT = 0x0337;
const REPORT = 37;

export const webHidAvailable = () => typeof navigator !== 'undefined' && !!navigator.hid;
const isAdapter = (d) => d.vendorId === VENDOR && d.productId === PRODUCT;

/**
 * What to tell a player whose adapter did not connect. `reason` is 'unsupported'
 * (no WebHID here), 'none' (the browser's chooser listed nothing, or it was
 * closed) or 'open' (the adapter was picked but would not open).
 */
export function adapterHelp(reason, platform = '') {
  const windows = /win/i.test(platform);
  const linux = /linux|x11|cros/i.test(platform) && !/android/i.test(platform);
  const lines = [];
  if (reason === 'unsupported') {
    lines.push('This browser cannot open the official GameCube adapter: that needs WebHID, which only Chrome, Edge and other Chromium browsers on a computer have.');
    lines.push('Either use one of those, or, if the adapter has a "Wii U / PC" switch (Mayflash and similar), set it to PC and replug it: each controller then shows up as an ordinary gamepad, which every browser can read. Press a button on it and it appears here.');
    return lines;
  }
  if (reason === 'none') {
    lines.push('If the browser\'s list was empty, it cannot see the adapter:');
    lines.push('Plug in the adapter\'s black USB plug (the grey one only powers rumble).');
    lines.push('If the adapter has a "Wii U / PC" switch, either position works here, but they connect differently: on Wii U use this button; on PC just press a button on the controller.');
    if (windows) {
      lines.push('Windows: if you ever replaced the adapter\'s driver with Zadig (WinUSB, for Dolphin or Slippi), browsers can no longer see it. In Device Manager find "WUP-028" (under Universal Serial Bus devices), choose Uninstall device, tick "Attempt to remove the driver for this device", then unplug and replug the adapter. (A program that needs the WinUSB driver will want it back afterwards; an adapter with a PC mode avoids the choice.)');
    }
    return lines;
  }
  lines.push('The browser found the adapter but could not open it.');
  if (linux) {
    lines.push('Linux: your user needs permission for the device. Save this line as /etc/udev/rules.d/51-gcadapter.rules, run "sudo udevadm control --reload-rules", then replug the adapter:');
    lines.push('KERNEL=="hidraw*", ATTRS{idVendor}=="057e", ATTRS{idProduct}=="0337", MODE="0660", TAG+="uaccess"');
  }
  lines.push('Close any other program that is using the adapter (Dolphin, Slippi, another browser tab with a game open), then press the button again.');
  return lines;
}

export function createGcAdapter({ onStatus = () => {}, log = console.log } = {}) {
  let device = null;
  let latest = null; // the newest report

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
    latest = null;
    candidate.oninputreport = (event) => {
      if (event.reportId !== 0x21) return;
      const report = new Uint8Array(REPORT);
      report[0] = 0x21;
      report.set(new Uint8Array(event.data.buffer, event.data.byteOffset, Math.min(REPORT - 1, event.data.byteLength)), 1);
      latest = report;
    };
    // Start streaming: output report 0x13, as Dolphin and SDL's driver send.
    await send(0x13, new Uint8Array(0));
    log(`GC adapter: ${candidate.productName || 'WUP-028'} connected through WebHID`);
    onStatus('connected');
  }

  if (webHidAvailable()) {
    navigator.hid.addEventListener('disconnect', ({ device: gone }) => {
      if (gone !== device) return;
      device = null;
      latest = null;
      log('GC adapter: disconnected');
      onStatus('disconnected');
    });
    navigator.hid.addEventListener('connect', ({ device: added }) => {
      if (!device && isAdapter(added)) open(added).catch((e) => log(`GC adapter: ${e.message}`));
    });
  }

  return {
    get connected() { return !!device; },
    /**
     * Ask for the adapter (needs a user gesture: a click). Resolves to
     * 'connected', or to the adapterHelp() reason it did not connect.
     */
    async request() {
      if (!webHidAvailable()) return 'unsupported';
      const [picked] = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR, productId: PRODUCT }] });
      if (!picked) return 'none';
      try {
        await open(picked);
      } catch (error) {
        log(`GC adapter: ${error.message}`);
        return 'open';
      }
      return 'connected';
    },
    /** Reopen an adapter this site was already allowed to use. */
    async reconnect() {
      if (!webHidAvailable()) return false;
      const known = (await navigator.hid.getDevices()).find(isAdapter);
      if (known) await open(known);
      return !!known;
    },
    /** The four 9-byte sockets of the newest report (36 bytes), or null. */
    slots: () => (device && latest ? latest.subarray(1) : null),
    /** Motor bytes for the four sockets (0 stop, 1 rumble, 2 brake). */
    rumble: (motors) => send(0x11, motors),
  };
}
