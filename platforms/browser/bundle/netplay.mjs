// SPDX-License-Identifier: GPL-3.0-or-later
// Netplay's link to the other player, for src/pc/net_match_web.c and
// src/pc/net_web.c. The engine's rollback session (src/pc/net.c) is the
// native one; a page just cannot open a UDP socket, so this carries its
// datagrams instead:
//
//   1. Rendezvous: a room on the Cloudflare Worker (../netplay-worker), named
//      by the host's code, reached over a WebSocket.
//   2. A WebRTC data channel between the two browsers, signalled through that
//      room, opened unordered with no retransmits (UDP's contract, which the
//      netcode is built for: it resends inputs itself).
//   3. When the two networks cannot reach each other directly, the room's
//      WebSocket relays the datagrams instead (TCP through the nearest
//      Cloudflare location: works everywhere, a little more latency).
//
// Datagrams cross into the engine through two rings in shared wasm memory
// (net_web.c); nothing here parses them, and net.c authenticates each one.

export const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Must match net_match_web.c's WEB_* link states.
export const LINK = { IDLE: 0, SIGNALLING: 1, WAITING: 2, NEGOTIATING: 3, OPEN: 4, FAILED: -1 };
const PROTOCOL = 1; // the room protocol below; the Worker refuses others
const DIRECT_TIMEOUT_MS = 6000; // then fall back to the relay
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** 'k3x-q2m 7a', '#K3XQ2M7A', 'NAME#K3XQ2M7A' -> 'K3XQ2M7A', or null. */
export function normalizeCode(text) {
  const tail = String(text ?? '').split('#').pop().toUpperCase().replace(/[\s-]/g, '');
  return tail.length === 8 && [...tail].every((c) => CODE_ALPHABET.includes(c)) ? tail : null;
}

/** 'K3XQ2M7A' -> 'K3X-Q2M-7A', how a person reads a code aloud. */
export const formatCode = (code) => `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;

/** This browser's code, made once and kept. */
export function localCode(storage = globalThis.localStorage) {
  let code = null;
  try { code = normalizeCode(storage?.getItem('melee-net-code')); } catch {}
  if (!code) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    code = [...bytes].map((b) => CODE_ALPHABET[b & 31]).join('');
    try { storage?.setItem('melee-net-code', code); } catch {}
  }
  return code;
}

/** The link that joins `code`'s match from this page. */
export function inviteLink(code, href = location.href) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('join', code);
  return url.href;
}

// The engine's datagram rings (net_web.c WebRing): head u32, tail u32,
// len[slots] u32, then slots * bytes of data.
export function datagramRing(link, base) {
  const u32 = new Uint32Array(link.buffer);
  const i32 = new Int32Array(link.buffer);
  const lens = (base >> 2) + 2;
  const data = base + 8 + 4 * link.slots;
  return {
    i32, head: base >> 2,
    // Everything the engine queued, oldest first.
    drain(send) {
      const head = Atomics.load(u32, base >> 2);
      let tail = Atomics.load(u32, (base >> 2) + 1);
      while (tail !== head) {
        const slot = tail & (link.slots - 1);
        const at = data + slot * link.bytes;
        send(new Uint8Array(link.buffer, at, u32[lens + slot]).slice()); // SAB -> plain copy
        tail = (tail + 1) >>> 0;
      }
      Atomics.store(u32, (base >> 2) + 1, tail);
    },
    // One datagram in; dropped when full or oversized, as a socket would.
    put(bytes) {
      const head = Atomics.load(u32, base >> 2);
      const tail = Atomics.load(u32, (base >> 2) + 1);
      if (bytes.length > link.bytes || ((head - tail) >>> 0) >= link.slots) return false;
      const slot = head & (link.slots - 1);
      new Uint8Array(link.buffer, data + slot * link.bytes, bytes.length).set(bytes);
      u32[lens + slot] = bytes.length;
      Atomics.store(u32, base >> 2, (head + 1) >>> 0);
      Atomics.notify(i32, base >> 2); // net.c's receive thread
      return true;
    },
  };
}

/**
 * The page's netplay link. `signalUrl` is the Worker's origin
 * (wss://… or https://…); without one, online play is off.
 */
export function createNetplay({ signalUrl, log = console.log, onChange = () => {}, storage } = {}) {
  const code = localCode(storage);
  const base = signalUrl ? new URL(signalUrl) : null;
  let state = LINK.IDLE;
  let reason = '';
  let role = null;
  let room = null;
  let peer = '';
  let ws = null;
  let pc = null;
  let dc = null;
  let relay = false;
  let pendingIce = [];
  let directTimer = 0;
  let pingTimer = 0;
  let session = 0; // bumped by stop(): late callbacks of an old attempt do nothing
  let tx = null;
  let rx = null;
  let pump = () => {};
  let path = '';
  let rttMs = null;
  const counts = { sent: 0, received: 0, dropped: 0 };

  const set = (next, why = '') => {
    if (state === next && reason === why) return;
    state = next;
    reason = why;
    onChange(api.info());
  };
  const fail = (why) => {
    log(`netplay: ${why}`);
    set(LINK.FAILED, why);
    teardown();
  };

  function httpUrl(pathname) {
    const url = new URL(pathname, base);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    return url;
  }

  function signal(message) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function send(bytes) {
    if (dc?.readyState === 'open') dc.send(bytes);
    else if (relay && ws?.readyState === WebSocket.OPEN) ws.send(bytes);
    else { counts.dropped++; return; }
    counts.sent++;
  }

  function receive(data) {
    counts.received++;
    if (!rx?.put(new Uint8Array(data))) counts.dropped++;
    // The engine's receive gate runs now, not at its next tick: the ack goes
    // out on arrival and the round trip it times is the link's own.
    pump();
  }

  function opened(how) {
    clearTimeout(directTimer);
    if (path !== how) log(`netplay: link open (${how === 'direct' ? 'direct WebRTC' : 'relayed by the server'})`);
    path = how;
    if (how === 'direct') watchRtt();
    set(LINK.OPEN);
  }

  // The engine calls in (net_web.c) once its rings exist; `onDatagram` runs
  // its receive gate (net_web_pump).
  function attach(link, onDatagram = () => {}) {
    pump = onDatagram;
    tx = datagramRing(link, link.tx);
    rx = datagramRing(link, link.rx);
    const wait = () => {
      tx.drain(send);
      const seen = Atomics.load(tx.i32, tx.head);
      if (Atomics.waitAsync) {
        const result = Atomics.waitAsync(tx.i32, tx.head, seen);
        (result.async ? result.value : Promise.resolve()).then(wait);
      } else {
        setTimeout(wait, 2);
      }
    };
    wait();
  }

  async function iceServers() {
    try {
      const response = await fetch(httpUrl('/ice'), { cache: 'no-store' });
      if (response.ok) {
        const { iceServers } = await response.json();
        if (Array.isArray(iceServers) && iceServers.length) return iceServers;
      }
    } catch {}
    return STUN;
  }

  async function startDirect(mine) {
    const servers = await iceServers();
    if (mine !== session) return;
    pc = new RTCPeerConnection({ iceServers: servers });
    pc.onicecandidate = ({ candidate }) => candidate && signal({ t: 'signal', candidate });
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed' && state === LINK.OPEN && path === 'direct') {
        log('netplay: direct link failed, switching to the relay');
        relay = true;
        signal({ t: 'relay' });
        opened('relay');
      }
    };
    const wire = (channel) => {
      dc = channel;
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => mine === session && opened('direct');
      dc.onmessage = ({ data }) => receive(data);
    };
    pc.ondatachannel = ({ channel }) => wire(channel);
    if (role === 'host') {
      wire(pc.createDataChannel('melee', { ordered: false, maxRetransmits: 0 }));
      await pc.setLocalDescription(await pc.createOffer());
      signal({ t: 'signal', sdp: pc.localDescription });
    }
    directTimer = setTimeout(() => {
      if (mine !== session || state === LINK.OPEN) return;
      log(`netplay: no direct link after ${DIRECT_TIMEOUT_MS / 1000} s, using the relay`);
      relay = true;
      signal({ t: 'relay' });
      opened('relay');
    }, DIRECT_TIMEOUT_MS);
  }

  async function onSignal(message, mine) {
    if (!pc) return;
    if (message.sdp) {
      await pc.setRemoteDescription(message.sdp);
      for (const candidate of pendingIce.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
      if (message.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        if (mine === session) signal({ t: 'signal', sdp: pc.localDescription });
      }
    } else if (message.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(message.candidate).catch(() => {});
      else pendingIce.push(message.candidate);
    }
  }

  function teardown() {
    clearTimeout(directTimer);
    clearInterval(pingTimer);
    clearInterval(rttTimer);
    dc?.close();
    pc?.close();
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
    ws = pc = dc = null;
    relay = false;
    pendingIce = [];
    path = '';
    rttMs = null;
  }

  function start(as, target) {
    stop();
    const mine = ++session;
    role = as;
    room = normalizeCode(target) ?? (as === 'host' ? code : null);
    if (!base) return fail('Online play is not set up for this site');
    if (!room) return fail('That is not a valid code');
    peer = '';
    set(LINK.SIGNALLING);
    const url = new URL(`/room/${room}`, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    url.searchParams.set('role', as);
    url.searchParams.set('code', code);
    url.searchParams.set('v', PROTOCOL);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (mine !== session) return;
      set(LINK.WAITING);
      pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 20000);
    };
    ws.onmessage = ({ data }) => {
      if (mine !== session) return;
      if (typeof data !== 'string') return receive(data);
      if (data === 'pong') return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.t === 'paired') {
        peer = `#${message.peer}`;
        log(`netplay: paired with #${formatCode(message.peer)} in room ${formatCode(room)}`);
        set(LINK.NEGOTIATING);
        startDirect(mine).catch((error) => log(`netplay: WebRTC unavailable (${error.message}); relay only`));
      } else if (message.t === 'signal') {
        onSignal(message, mine).catch((error) => log(`netplay: signalling: ${error.message}`));
      } else if (message.t === 'relay') {
        relay = true;
        if (state !== LINK.OPEN) opened('relay');
      } else if (message.t === 'peer-left') {
        log('netplay: the other player left the room');
        if (state !== LINK.OPEN) {
          // Not playing yet: wait for them (or someone else) again.
          clearTimeout(directTimer);
          dc?.close();
          pc?.close();
          pc = dc = null;
          relay = false;
          peer = '';
          set(LINK.WAITING);
        }
      } else if (message.t === 'error') {
        fail(message.reason || 'The matchmaking server refused the room');
      }
    };
    ws.onclose = (event) => {
      if (mine !== session) return;
      clearInterval(pingTimer);
      if (state === LINK.OPEN && path === 'direct') return; // the direct link does not need it
      if (state !== LINK.FAILED) fail(event.reason || 'Lost the connection to the matchmaking server');
    };
    ws.onerror = () => mine === session && log('netplay: matchmaking server connection error');
  }

  function stop() {
    session++;
    teardown();
    role = room = null;
    peer = '';
    if (state !== LINK.IDLE) set(LINK.IDLE);
  }

  // Round trip for the status chip, from the selected ICE candidate pair;
  // runs only while a direct link is up (opened, torn down with it).
  let rttTimer = 0;
  function watchRtt() {
    clearInterval(rttTimer);
    rttTimer = setInterval(async () => {
      if (!pc || path !== 'direct') return;
      try {
        for (const stat of (await pc.getStats()).values()) {
          if (stat.type === 'candidate-pair' && stat.nominated && stat.currentRoundTripTime != null) {
            rttMs = Math.round(stat.currentRoundTripTime * 1000);
            onChange(api.info());
          }
        }
      } catch {}
    }, 2000);
  }

  const api = {
    enabled: !!base,
    status: () => state,
    failure: () => reason,
    localCode: () => `#${code}`,
    opponentCode: () => peer,
    start,
    stop,
    attach,
    // net_web.c's synchronous send, from the engine on this thread.
    sendNow: send,
    copyCode() {
      navigator.clipboard?.writeText(inviteLink(code)).catch(() => {});
      return true;
    },
    info: () => ({ state, reason, role, room, code, peer, path, rttMs, ...counts }),
  };
  return api;
}
