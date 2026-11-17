// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Controller paths of the bundled web app, end to end, with simulated
 * devices: what the page is given by the Gamepad API and WebHID on the
 * browsers and adapters people have, and what the game then reads.
 *
 *   python3 build/browser/bundle/serve.py &
 *   PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/controllers-e2e.mjs [case ...]
 *
 * The game's side is read from MELEE_INPUT_TRACE=1 ("game pad N: ..." lines,
 * src/pc/keyboard.c). Real hardware is not needed and not covered: the device
 * layouts here are the ones the page's profiles were written from.
 */
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.MELEE_TEST_URL || 'http://127.0.0.1:5191/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GameCube button bits as the game holds them (dolphin/pad.h).
const BTN = { Left: 0x0001, Right: 0x0002, Down: 0x0004, Up: 0x0008, Z: 0x0010, R: 0x0020, L: 0x0040,
  A: 0x0100, B: 0x0200, X: 0x0400, Y: 0x0800, Start: 0x1000 };

// Runs in the page before its scripts: Gamepad API and WebHID stand-ins.
function devices() {
  const pads = [];
  window.__pads = {
    add(id, mapping, nButtons, nAxes, axes = {}) {
      const pad = {
        id, index: pads.length, mapping, connected: true, timestamp: performance.now(),
        buttons: Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 })),
        axes: Array.from({ length: nAxes }, () => 0),
      };
      for (const [i, v] of Object.entries(axes)) pad.axes[i] = v;
      pads.push(pad);
      const event = new Event('gamepadconnected');
      event.gamepad = pad;
      window.dispatchEvent(event);
      return pad.index;
    },
    button(i, b, on, value) {
      Object.assign(pads[i].buttons[b], { pressed: on, touched: on, value: value ?? (on ? 1 : 0) });
      pads[i].timestamp = performance.now();
    },
    axis(i, a, v) {
      pads[i].axes[a] = v;
      pads[i].timestamp = performance.now();
    },
  };
  Object.defineProperty(navigator, 'getGamepads', { value: () => pads.slice(), configurable: true, writable: true });

  // An official adapter with one controller, in the socket __hid.socket.
  const state = { socket: 2, buttons1: 0, buttons2: 0, stickX: 131, present: true, rumble: [] };
  window.__hid = state;
  const device = {
    vendorId: 0x057e, productId: 0x0337, productName: 'WUP-028', opened: false, oninputreport: null,
    async open() {
      this.opened = true;
      setInterval(() => {
        const d = new Uint8Array(36);
        if (state.present) d.set([0x14, state.buttons1, state.buttons2, state.stickX, 126, 128, 128, 31, 29], 9 * state.socket);
        this.oninputreport?.({ reportId: 0x21, data: new DataView(d.buffer) });
      }, 8);
    },
    async sendReport(id, data) { if (id === 0x11) state.rumble.push([...new Uint8Array(data.buffer ?? data)]); },
    async close() { this.opened = false; },
  };
  const hid = new EventTarget();
  hid.getDevices = async () => (window.__hidAllowed ? [device] : []);
  hid.requestDevice = async () => (window.__hidListed === false ? [] : [device]);
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
}

const XBOX = ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard', 17, 4];
// A Mayflash adapter switched to PC, as Chrome on Windows and macOS shows it
// (hat on axis 9) and as Firefox does (other id, d-pad as buttons).
const MAYFLASH = ['MAYFLASH GameCube Controller Adapter (Vendor: 0079 Product: 1843)', '', 16, 10, { 3: -0.75, 4: -0.75, 9: 9 / 7 }];
const MAYFLASH_FIREFOX = ['0079-1843-MAYFLASH GameCube Controller Adapter', '', 16, 6, { 3: -0.75, 4: -0.75 }];
const UNKNOWN = ['Twin USB Joystick (Vendor: 0810 Product: 0001)', '', 12, 4];

async function session(browser, { before = async () => {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  const game = [null, null, null, null]; // newest "game pad" line per port
  const logs = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => {
    const text = m.text();
    logs.push(text);
    if (/panic|fatal|abort\(|Assertion failed/i.test(text)) errors.push(text);
    const hit = /game pad (\d): btn ([0-9a-f]+) stick (-?\d+),(-?\d+) sub (-?\d+),(-?\d+) trig (\d+),(\d+) err (-?\d+)/.exec(text);
    if (hit) {
      const [port, , x, y, cx, cy, l, r, err] = hit.slice(1).map(Number);
      game[port - 1] = { btn: parseInt(hit[2], 16), x, y, cx, cy, l, r, err };
    }
  });
  await page.addInitScript(devices);
  const url = new URL(base);
  url.searchParams.set('MELEE_INPUT_TRACE', '1');
  await page.goto(url.href);
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
  await before(page);
  await page.locator('#start').click();
  await page.waitForFunction(() => window.meleeFrames.count >= 200, null, { timeout: 180000 });
  const pads = {
    add: (spec) => page.evaluate((s) => window.__pads.add(...s), spec),
    button: (i, b, on, value) => page.evaluate(([i, b, on, value]) => window.__pads.button(i, b, on, value ?? undefined), [i, b, on, value ?? null]),
    axis: (i, a, v) => page.evaluate(([i, a, v]) => window.__pads.axis(i, a, v), [i, a, v]),
  };
  // Wait until the game reads what `want` describes on some port; returns the port.
  async function until(want, what, timeout = 4000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const port = game.findIndex((g) => g && want(g));
      if (port >= 0) return port;
      await sleep(30);
    }
    throw Error(`${what}: the game never read it (ports: ${JSON.stringify(game)})`);
  }
  const idle = (port) => until((g) => g === game[port] && g.btn === 0 && Math.abs(g.x) < 10 && Math.abs(g.y) < 10, `port ${port + 1} back to rest`);
  return { page, context, pads, game, logs, errors, until, idle };
}

function expect(ok, what) {
  if (!ok) throw Error(what);
}

const cases = {
  // A pad the browser knows goes through SDL. The stick is thrown from dead
  // centre to the edge in one sample, the case SDL's initial-value logic ate.
  async standard(browser) {
    const s = await session(browser, { before: (page) => page.evaluate((x) => { window.__x = window.__pads.add(...x); }, XBOX) });
    const { pads, until, idle } = s;
    await pads.axis(0, 0, 1);
    const port = await until((g) => g.x > 50, 'first flick of a pad connected before the game started');
    expect(port === 0, `the only controller is player 1, not ${port + 1}`);
    await pads.axis(0, 0, 0);
    await pads.button(0, 0, true);
    await until((g) => g.btn === BTN.A, 'A (south button)');
    await pads.button(0, 0, false);
    await pads.button(0, 6, true, 1);
    await until((g) => g.btn & BTN.L && g.l > 100, 'left trigger as L');
    await pads.button(0, 6, false, 0);
    await idle(0);
    // A second one plugged in mid-game takes the next port; same first flick.
    const second = await pads.add(XBOX);
    await sleep(300);
    await pads.axis(second, 1, -1);
    const port2 = await until((g) => g.y > 50, 'first flick of a pad connected while the game runs');
    expect(port2 === 1, `the second controller is player 2, not ${port2 + 1}`);
    expect((await s.page.textContent('#pad .cv-title')).startsWith('Controller'), 'the chip shows a generic controller');
    return s;
  },

  // A GameCube controller on a Mayflash in PC mode: no standard layout, so it
  // is translated on the page and reaches the game with its raw values.
  async mayflash(browser) {
    const s = await session(browser, { before: (page) => page.evaluate((m) => { window.__pads.add(...m); }, MAYFLASH) });
    const { pads, until, idle, page } = s;
    expect(await page.evaluate(() => navigator.getGamepads()[0] === null), 'SDL must not see a translated pad');
    for (const [button, name] of [[1, 'A'], [2, 'B'], [0, 'X'], [3, 'Y'], [9, 'Start'], [7, 'Z']]) {
      await pads.button(0, button, true);
      const port = await until((g) => g.btn === BTN[name], `${name} on button ${button}`);
      expect(port === 0, `player 1, not ${port + 1}`);
      await pads.button(0, button, false);
      await idle(0);
    }
    await pads.axis(0, 0, 100 / 127.5); // a GameCube stick's whole travel is about 100
    await until((g) => g.x >= 70, 'full stick right at raw 100');
    await pads.axis(0, 0, 0);
    await pads.axis(0, 1, -100 / 127.5);
    await until((g) => g.y >= 70, 'stick up');
    await pads.axis(0, 1, 0);
    await pads.axis(0, 5, -100 / 127.5);
    await until((g) => g.cx <= -50, 'C-stick left');
    await pads.axis(0, 5, 0);
    await pads.axis(0, 9, -1);
    await until((g) => g.btn === BTN.Up, 'd-pad up on the hat axis');
    await pads.axis(0, 9, 3 / 7);
    await until((g) => g.btn === (BTN.Down | BTN.Left), 'd-pad down-left');
    await pads.axis(0, 9, 9 / 7);
    await pads.axis(0, 3, 0.1); // L part way: analog only
    await until((g) => g.btn === 0 && g.l > 40 && g.l < 140, 'light L press');
    await pads.axis(0, 3, 0.9);
    await pads.button(0, 4, true);
    await until((g) => g.btn === BTN.L && g.l >= 140, 'L pressed home');
    await pads.button(0, 4, false);
    await pads.axis(0, 3, -0.75);
    await idle(0);
    expect((await page.textContent('#pad .cv-title')).startsWith('P1 GameCube'), 'the chip shows player 1\'s GameCube controller');
    // Firefox's spelling of the same adapter, plugged in mid-game: player 2.
    const second = await pads.add(MAYFLASH_FIREFOX);
    await sleep(300);
    await pads.button(second, 14, true);
    const port = await until((g) => g.btn === BTN.Down, 'd-pad down as a button');
    expect(port === 1, `the second controller is player 2, not ${port + 1}`);
    return s;
  },

  // The official adapter over WebHID with its one controller in socket 3:
  // still player 1, raw values, rumble back to socket 3.
  async adapter(browser) {
    const s = await session(browser, { before: (page) => page.evaluate(() => { window.__hidAllowed = false; }) });
    const { page, until } = s;
    await page.locator('#gcadapter').click();
    await page.waitForFunction(() => document.querySelector('#gcadapter').hidden, null, { timeout: 5000 });
    await sleep(300);
    await page.evaluate(() => { window.__hid.buttons1 = 0x01; window.__hid.stickX = 231; });
    const port = await until((g) => g.btn === BTN.A && g.x >= 70, 'A and stick from socket 3');
    expect(port === 0, `socket 3's controller is player 1, not ${port + 1}`);
    await page.evaluate(() => { window.__hid.buttons1 = 0; window.__hid.stickX = 131; });
    expect((await page.textContent('#pad .cv-title')).includes('socket 3'), 'the chip names the socket');
    // Unplug and replug the controller: it comes back as player 1.
    await page.evaluate(() => { window.__hid.present = false; });
    await until((g) => g === s.game[0] && g.err !== 0, 'controller unplugged');
    await page.evaluate(() => { window.__hid.present = true; window.__hid.buttons2 = 0x01; });
    await until((g) => g === s.game[0] && g.btn === BTN.Start, 'Start after replugging');
    return s;
  },

  // No WebHID device to pick: the page explains instead of doing nothing.
  async 'adapter-help'(browser) {
    const s = await session(browser, { before: (page) => page.evaluate(() => { window.__hidAllowed = false; window.__hidListed = false; }) });
    await s.page.locator('#gcadapter').click();
    await s.page.waitForSelector('#paddialog[open]', { timeout: 5000 });
    const text = await s.page.textContent('#paddialog');
    expect(/black USB plug/.test(text), 'the help names the usual causes');
    await s.page.locator('#paddialog .actions button').click();
    expect(!(await s.page.locator('#paddialog').evaluate((d) => d.open)), 'the dialog closes');
    return s;
  },

  // A pad nobody has a layout for: the wizard makes one, the game then reads
  // it, and a second visit remembers it.
  async wizard(browser) {
    const s = await session(browser, { before: (page) => page.evaluate((u) => { window.__pads.add(...u); }, UNKNOWN) });
    const { page, pads, until, idle } = s;
    await page.waitForFunction(() => document.querySelector('#padsetup').classList.contains('attn'), null, { timeout: 5000 });
    await page.locator('#padsetup').click();
    const hold = async (change, undo) => {
      await change();
      await sleep(180);
      await undo();
      await sleep(180);
    };
    const prompt = () => page.textContent('#paddialog .prompt');
    await hold(() => pads.button(0, 2, true), () => pads.button(0, 2, false)); // pick this pad
    await page.waitForFunction(() => /Press A/.test(document.querySelector('#paddialog .prompt')?.textContent), null, { timeout: 5000 });
    // This pad: A=2 B=1 X=3 Y=0 Start=9 Z=5, L=6 R=7 (plain buttons), d-pad on
    // axes 2/3, one stick on axes 0/1 that only reaches 0.8, no C-stick.
    for (const b of [2, 1, 3, 0, 9, 5, 6, 7]) await hold(() => pads.button(0, b, true), () => pads.button(0, b, false));
    expect(/Up on the D-pad/.test(await prompt()), `expected the d-pad step, at "${await prompt()}"`);
    for (const [a, v] of [[3, -1], [3, 1], [2, -1], [2, 1]]) await hold(() => pads.axis(0, a, v), () => pads.axis(0, a, 0));
    await hold(() => pads.axis(0, 0, 0.8), () => pads.axis(0, 0, 0));
    await hold(() => pads.axis(0, 1, -0.8), () => pads.axis(0, 1, 0));
    expect(/C-Stick/.test(await prompt()), `expected the C-stick step, at "${await prompt()}"`);
    await page.locator('#paddialog .actions button', { hasText: 'Skip' }).click();
    await page.locator('#paddialog .actions button', { hasText: 'Skip' }).click();
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#paddialog .prompt')?.textContent), null, { timeout: 5000 });
    await page.locator('#paddialog .actions button', { hasText: 'Done' }).click();
    await sleep(300);

    await pads.button(0, 2, true);
    const port = await until((g) => g.btn === BTN.A, 'A as taught');
    expect(port === 0, `player 1, not ${port + 1}`);
    await pads.button(0, 2, false);
    await pads.button(0, 6, true);
    await until((g) => g.btn === BTN.L && g.l >= 140, 'a button taught as L reads as a full press');
    await pads.button(0, 6, false);
    await pads.axis(0, 2, -1);
    await until((g) => g.btn === BTN.Left, 'd-pad left on an axis');
    await pads.axis(0, 2, 0);
    await pads.axis(0, 0, 0.8);
    await until((g) => g.x >= 70, 'a short stick is scaled to full travel');
    await pads.axis(0, 0, 0);
    await idle(0);
    expect(!(await page.evaluate(() => document.querySelector('#padsetup').classList.contains('attn'))), 'no setup prompt once set up');

    // Second visit, same browser profile: the layout is there from the start.
    const again = await s.context.newPage();
    const seen = [];
    again.on('console', (m) => seen.push(m.text()));
    await again.addInitScript(devices);
    await again.goto(base);
    await again.evaluate((u) => { window.__pads.add(...u); }, UNKNOWN);
    await sleep(300);
    expect(await again.evaluate(() => navigator.getGamepads()[0] === null), 'the saved layout claims the pad on the next visit');
    await again.close();
    return s;
  },

  // One of each kind at once: they must not land on the same player.
  async mixed(browser) {
    const s = await session(browser, { before: (page) => page.evaluate(([x, m]) => { window.__pads.add(...x); window.__pads.add(...m); }, [XBOX, MAYFLASH]) });
    const { pads, until, idle } = s;
    await pads.button(0, 0, true);
    const xbox = await until((g) => g.btn === BTN.A, 'A on the standard pad');
    await pads.button(0, 0, false);
    await idle(xbox);
    await pads.button(1, 2, true);
    const gc = await until((g) => g.btn === BTN.B, 'B on the GameCube pad');
    await pads.button(1, 2, false);
    expect(xbox !== gc, `both controllers are player ${xbox + 1}`);
    expect(xbox < 2 && gc < 2, `two controllers use players 1 and 2, not ${xbox + 1} and ${gc + 1}`);
    return s;
  },
};

const wanted = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
let failed = 0;
try {
  for (const [name, run] of Object.entries(cases)) {
    if (wanted.length && !wanted.includes(name)) continue;
    let s = null;
    try {
      s = await run(browser);
      if (s.errors.length) throw Error(`page errors: ${s.errors.slice(0, 3).join(' | ')}`);
      console.log(`ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}: ${error.message}`);
      if (process.env.MELEE_TEST_VERBOSE && s) console.log(s.logs.filter((l) => /controller|GC adapter|game pad/.test(l)).slice(-30).join('\n'));
    } finally {
      await s?.context.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
