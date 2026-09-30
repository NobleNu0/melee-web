/* SPDX-License-Identifier: GPL-3.0-or-later */
/*
 * VS-only profile (MELEE_VS_ONLY=1). The game boots to the title screen with
 * no memory-card scene or opening movie, Start goes straight to VS character
 * select (1v1 against a CPU by default), everything is unlocked, nothing is
 * saved, and stage select offers only the tournament-legal stages. Adventure,
 * Classic, trophies and the other modes stay compiled but unreachable, and
 * Training is kept intact for a later return.
 *
 * The bundled web app (tools/browser/bundle.py) always runs this profile:
 * its melee.pak leaves out movies, trophies and every other stage.
 */
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "pc/pc.h"

bool pc_vs_only(void) {
    static int state = -1;
    if (state < 0) {
        const char* env = getenv("MELEE_VS_ONLY");
        state = env != NULL && env[0] != '\0' && env[0] != '0';
    }
    return state;
}

/* Fountain of Dreams, Pokemon Stadium, Yoshi's Story, Dream Land,
 * Battlefield and Final Destination, as StKind: the same list ranked
 * netplay uses (net_rank_session.c). */
bool pc_is_legal_stage(unsigned stkind) {
    switch (stkind) {
    case 0x02:
    case 0x03:
    case 0x08:
    case 0x1C:
    case 0x1F:
    case 0x20:
        return true;
    default:
        return false;
    }
}

/* MELEE_ONLINE: the page asked for a netplay session (bundle/netplay.mjs):
 * "host" waits for a friend under our own code, anything else is the code
 * to call. The profile then boots into the online lobby instead of the
 * title, and the lobby dials once; after that the lobby's own menu (and the
 * title's Start, offline) take over. */
static bool s_online_taken;

bool pc_online_requested(void) {
    const char* env = getenv("MELEE_ONLINE");
    return pc_vs_only() && !s_online_taken && env != NULL && env[0] != '\0';
}

bool pc_online_take(const char** target) {
    if (!pc_online_requested()) {
        return false;
    }
    const char* env = getenv("MELEE_ONLINE");
    s_online_taken = true;
    *target = strcmp(env, "host") == 0 ? NULL : env;
    return true;
}
