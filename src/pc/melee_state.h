/* SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef MELEE_PC_STATE_H
#define MELEE_PC_STATE_H

/* Mach-O's linker-defined section boundaries follow ASLR automatically. ELF
 * uses melee_state.ld; PE uses sorted input sections with explicit markers. */
#ifdef __APPLE__
extern char __melee_data_start[] __asm("section$start$__DATA$__melee_data");
extern char __melee_data_end[] __asm("section$end$__DATA$__melee_data");
extern char __melee_bss_start[] __asm("section$start$__DATA$__melee_bss");
extern char __melee_bss_end[] __asm("section$end$__DATA$__melee_bss");
#elif defined(__EMSCRIPTEN__)
/* wasm-ld brackets every segment named as a C identifier; the game objects'
 * .data/.bss are renamed to these by tools/browser/wasm_state_sections.py. */
extern char __start_melee_data[], __stop_melee_data[];
extern char __start_melee_bss[], __stop_melee_bss[];
#define __melee_data_start __start_melee_data
#define __melee_data_end __stop_melee_data
#define __melee_bss_start __start_melee_bss
#define __melee_bss_end __stop_melee_bss
#else
extern char __melee_data_start[], __melee_data_end[];
extern char __melee_bss_start[], __melee_bss_end[];
#endif

#endif
