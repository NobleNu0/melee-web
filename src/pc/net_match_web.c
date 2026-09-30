/* SPDX-License-Identifier: GPL-3.0-or-later */
/*
 * Browser matchmaking: net_match.h without the DHT (net_match.c needs UDP).
 *
 * The page pairs two players (platforms/browser/bundle/netplay.mjs): a room
 * on the Cloudflare Worker (platforms/browser/netplay-worker) named by the
 * host's code, WebRTC signalling through it, and its WebSocket relay when a
 * direct link cannot be made. Once the page's link is open this hands it to
 * net.c as the session socket (net_web.c) and runs the same RULES/READY
 * handshake and ready barrier a native Direct Connect runs, so everything
 * from the lobby on -- rollback, time sync, resume, desync checks -- is the
 * native session unchanged.
 *
 * Codes are "#" plus eight characters of the in-game code keyboard's
 * alphabet (gmonlinemode.c direct_keys), so a friend's code can be typed
 * there too; the page keeps ours per browser. The host waits in the room
 * named by its own code, the caller joins the one named by the friend's.
 * Ranked, publication and contacts are native-only (no identity store).
 */
#ifdef __EMSCRIPTEN__
#include "net_match.h"
#include "net.h"
#include "net_lan.h"
#include "compat.h"
#include "net_internal.h"
#include "pc.h"

#include <SDL3/SDL_timer.h>
#include <emscripten.h>
#include <stdio.h>
#include <string.h>

/* Page link states (netplay.mjs LINK_*). */
enum { WEB_IDLE, WEB_SIGNALLING, WEB_WAITING, WEB_NEGOTIATING, WEB_OPEN, WEB_FAILED = -1 };

static enum PcNetMatchMode mode;
static int state = PC_MATCH_FAIL;
static const char* failure = "not started";
static bool host;
static uint32_t seed;
static int32_t start_frame = -1;
static bool handshake_done, barrier_sent, barrier_received;
static uint64_t started_ms;
static char target[18];
static char local_code[18];
static char opponent[18];
static char page_reason[96];
static PcNetIdentity identity; /* no signing keys in the browser */
static uint8_t peer_key[32];

// clang-format off
EM_JS_DEPS(net_match_web, "$stringToUTF8,$UTF8ToString");
EM_JS(int, web_match_status, (void), {
  return Module.meleeNetplay ? Module.meleeNetplay.status() : -1;
});
/* which: 0 our code, 1 the opponent's code, 2 the failure reason. */
EM_JS(void, web_match_text, (int which, char* out, int cap), {
  const n = Module.meleeNetplay;
  const s = !n ? '' : which === 0 ? n.localCode() : which === 1 ? n.opponentCode() : n.failure();
  stringToUTF8(s || '', out, cap);
});
EM_JS(void, web_match_start, (int as_host, const char* room), {
  Module.meleeNetplay?.start(as_host ? 'host' : 'guest', UTF8ToString(room));
});
EM_JS(void, web_match_stop, (void), { Module.meleeNetplay?.stop(); });
EM_JS(int, web_match_copy, (void), { return Module.meleeNetplay?.copyCode() ? 1 : 0; });
EM_JS(uint32_t, web_random32, (void), {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
});
// clang-format on

static void fail(const char* why) {
    state = PC_MATCH_FAIL;
    failure = why;
    if (pc_net_active())
        pc_net_disconnect();
}

/* "#K3XQ2M7A", "NAME#K3XQ2M7A" or "K3XQ2M7A" -> "K3XQ2M7A". */
static const char* room_of(const char* code) {
    const char* hash = code ? strchr(code, '#') : NULL;
    return hash ? hash + 1 : code ? code : "";
}

bool pc_net_match_start(enum PcNetMatchMode m, const char* target_code) {
    pc_net_match_stop();
    if (m != PC_MATCH_DIRECT) {
        failure = "Only Direct Connect is available in the browser";
        return false;
    }
    mode = m;
    host = target_code == NULL || target_code[0] == '\0';
    snprintf(target, sizeof target, "%s", host ? "" : target_code);
    opponent[0] = '\0';
    seed = 0;
    start_frame = -1;
    handshake_done = barrier_sent = barrier_received = false;
    started_ms = SDL_GetTicks();
    web_match_start(host, host ? room_of(pc_net_match_local_code()) : room_of(target));
    state = PC_MATCH_SEARCH;
    failure = NULL;
    pc_log_line("match: web %s room %s", host ? "hosting" : "calling",
        host ? room_of(pc_net_match_local_code()) : room_of(target));
    return true;
}

void pc_net_match_stop(void) {
    web_match_stop();
    if (pc_net_active())
        pc_net_disconnect();
    state = PC_MATCH_FAIL;
    failure = "cancelled";
}

void pc_net_match_poll(void) {
    int link = web_match_status();
    if (state == PC_MATCH_SEARCH) {
        if (link == WEB_FAILED) {
            web_match_text(2, page_reason, sizeof page_reason);
            fail(page_reason[0] ? page_reason : "Could not reach the matchmaking server");
            return;
        }
        /* Progress lines the lobby shows while it waits (gmonlinemode.c). */
        failure = link == WEB_NEGOTIATING ? "Found them - connecting..." : NULL;
        if (link != WEB_OPEN)
            return;
        web_match_text(1, opponent, sizeof opponent);
        if (host)
            seed = web_random32() | 1u;
        pc_log_line("match: page link open, %s, opponent %s", host ? "host" : "guest", opponent);
        if (!pc_net_connect_socket(NET_WEB_SOCK, "web", 1, host ? 0 : 1, host ? seed : 0)) {
            fail("connection failed");
            return;
        }
        state = PC_MATCH_CONNECT;
        failure = NULL;
    } else if (state == PC_MATCH_CONNECT) {
        /* The same steps as net_match.c's Direct Connect once connected. */
        pc_net_poll();
        if (!handshake_done)
            handshake_done = host ? pc_net_host_match(seed, &start_frame) :
                                    pc_net_guest_wait_match(&seed, &start_frame);
        if (handshake_done && !barrier_sent) {
            if (!pc_net_send_reliable(0x11, NULL, 0)) {
                fail("ready barrier not sent");
                return;
            }
            barrier_sent = true;
        }
        if (barrier_sent && !barrier_received) {
            uint8_t type, buf[256];
            int n;
            while ((n = pc_net_recv_reliable(&type, buf, sizeof buf)) >= 0) {
                if (type == 0x11 && n == 0)
                    barrier_received = true;
            }
        }
        if (barrier_received) {
            if (pc_net_frame() > start_frame) {
                fail("late ready barrier");
                return;
            }
            state = PC_MATCH_READY;
        }
        if (pc_net_handshake_state() == 3)
            fail("match handshake failed");
    }
}

int pc_net_match_state(const char** why) {
    if (why)
        *why = failure;
    return state;
}

void pc_net_match_progress(PcNetMatchProgress* p) {
    int link = web_match_status();
    memset(p, 0, sizeof *p);
    p->elapsed_ms = state == PC_MATCH_SEARCH && started_ms ? SDL_GetTicks() - started_ms : 0;
    p->network_ready = link >= WEB_WAITING;
    p->found = link >= WEB_NEGOTIATING || state == PC_MATCH_CONNECT || state == PC_MATCH_READY;
    p->calling = !host;
}

const char* pc_net_match_local_code(void) {
    web_match_text(0, local_code, sizeof local_code);
    return local_code;
}
const char* pc_net_match_opponent_code(void) {
    return opponent;
}
bool pc_net_match_copy_code(void) {
    return web_match_copy() != 0;
}
bool pc_net_match_is_host(void) {
    return host;
}
int32_t pc_net_match_start_frame(void) {
    return start_frame;
}
uint32_t pc_net_match_seed(void) {
    return seed;
}
enum PcNetMatchMode pc_net_match_mode(void) {
    return mode;
}

/* Native-only: contacts and the clipboard (the page offers its own copy
 * button and invite link), identity files, ranked publication. */
int pc_net_match_contacts(PcNetContact* out, int max) {
    (void)out, (void)max;
    return 0;
}
bool pc_net_match_clipboard_code(char out[18]) {
    (void)out;
    return false;
}
bool pc_net_match_publish_rank(void) {
    return false;
}
void pc_net_match_poll_publication(void) {}
int pc_net_match_publication(const char** reason) {
    if (reason)
        *reason = NULL;
    return 0;
}
const char* pc_net_match_profile_error(void) {
    return "";
}
const char* pc_net_match_profile_directory(void) {
    return "";
}
const PcNetIdentity* pc_net_match_identity(void) {
    return &identity;
}
const uint8_t* pc_net_match_peer_key(void) {
    return peer_key;
}
#endif
