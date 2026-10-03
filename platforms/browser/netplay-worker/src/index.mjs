// SPDX-License-Identifier: GPL-3.0-or-later
// Matchmaking and relay for browser netplay (platforms/browser/bundle/netplay.mjs).
//
// GET /room/<CODE>?role=host|guest&code=<OWN CODE>&v=1   (WebSocket)
//   One Durable Object per room, named by the host's code, holds at most one
//   host and one guest. When both are in it tells each who the other is
//   ({t:'paired'}), then forwards every text message (WebRTC offer, answer and
//   ICE candidates) and every binary message (game datagrams, when the two
//   browsers could not open a direct link) to the other side untouched.
// GET /ice
//   ICE servers for WebRTC: Cloudflare's STUN, plus short-lived Cloudflare
//   TURN credentials when TURN_KEY_ID / TURN_KEY_API_TOKEN are set.
//
// Game traffic is authenticated end to end by the engine (net.c's per-datagram
// MAC), so this relays bytes it cannot read or forge usefully.
import { DurableObject } from 'cloudflare:workers';

const PROTOCOL = '1';
const CODE = /^[A-Z2-7]{8}$/;
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// ALLOWED_ORIGINS entries are exact origins, or patterns with one "*" for a
// subdomain (https://*.example.com: preview deployments).
function originMatches(origin, pattern) {
  if (!pattern.includes('*')) return origin === pattern;
  const [head, tail] = pattern.split('*');
  return origin.startsWith(head) && origin.endsWith(tail) &&
    /^[a-z0-9-]+$/i.test(origin.slice(head.length, origin.length - tail.length));
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!allowed.length || allowed.includes('*')) return origin || '*';
  return origin && allowed.some((pattern) => originMatches(origin, pattern)) ? origin : null;
}

function cors(origin, response) {
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    // The game page is cross-origin isolated (COEP require-corp).
    response.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }
  return response;
}

async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN;
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
    },
  );
  if (!response.ok) return STUN;
  const { iceServers } = await response.json();
  return [...STUN, ...(Array.isArray(iceServers) ? iceServers : [iceServers])];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') return cors(origin, new Response(null, { status: 204 }));
    if (url.pathname === '/health') return cors(origin, new Response('ok'));
    if (url.pathname === '/ice') {
      if (!origin) return new Response('origin not allowed', { status: 403 });
      return cors(origin, Response.json({ iceServers: await iceServers(env) }, {
        headers: { 'Cache-Control': 'no-store' },
      }));
    }
    const match = /^\/room\/([A-Z2-7]{8})$/.exec(url.pathname);
    if (!match) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    if (!origin) return new Response('origin not allowed', { status: 403 });
    const role = url.searchParams.get('role');
    const code = url.searchParams.get('code') || '';
    if (url.searchParams.get('v') !== PROTOCOL) {
      return new Response('this page is out of date; reload it', { status: 409 });
    }
    if ((role !== 'host' && role !== 'guest') || !CODE.test(code) || (role === 'host' && code !== match[1])) {
      return new Response('bad room request', { status: 400 });
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return room.fetch(request);
  },
};

// A room: one host, one guest. Hibernatable WebSockets, so an idle room (a
// host waiting for a friend) costs nothing while nobody sends anything.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  sockets(role) {
    return this.ctx.getWebSockets(role);
  }

  other(ws) {
    const { role } = ws.deserializeAttachment() || {};
    return this.sockets(role === 'host' ? 'guest' : 'host')[0];
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const code = url.searchParams.get('code');
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, code });
    const taken = this.sockets(role).filter((ws) => ws !== server);
    if (taken.length) {
      server.send(JSON.stringify({
        t: 'error',
        reason: role === 'host' ? 'This code is already hosting in another tab or browser'
                                : 'That player is already in a match',
      }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const other = this.sockets(role === 'host' ? 'guest' : 'host')[0];
    if (other) {
      const them = other.deserializeAttachment();
      server.send(JSON.stringify({ t: 'paired', peer: them.code, role }));
      other.send(JSON.stringify({ t: 'paired', peer: code, role: them.role }));
    } else {
      server.send(JSON.stringify({ t: 'waiting' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const other = this.other(ws);
    if (!other) return;
    try {
      other.send(message); // text: signalling; binary: relayed datagrams
    } catch {}
  }

  webSocketClose(ws, code) {
    const other = this.other(ws);
    try {
      other?.send(JSON.stringify({ t: 'peer-left' }));
    } catch {}
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {}
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011);
  }
}
