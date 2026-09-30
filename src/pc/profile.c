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
