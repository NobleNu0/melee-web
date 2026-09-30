// SPDX-License-Identifier: GPL-3.0-or-later
// Decodes melee.pak LZMA blocks off the game's thread (pak-reader.mjs).
import { decodeLzmaAlone } from './lzma.mjs';

self.onmessage = ({ data: { id, stored, raw } }) => {
  try {
    const out = decodeLzmaAlone(stored, raw);
    self.postMessage({ id, out }, [out.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
