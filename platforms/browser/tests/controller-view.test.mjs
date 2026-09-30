// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { isGameCubePad } from '../bundle/controller-view.mjs';

test('GameCube adapters and pads get the GameCube drawing, everything else the generic one', () => {
  for (const id of ['MAYFLASH GameCube Controller Adapter (STANDARD GAMEPAD Vendor: 0079 Product: 1846)',
    'USB GamePad (Vendor: 057e Product: 0337)', 'Nintendo GameCube Controller', 'WUP-028']) {
    assert.equal(isGameCubePad(id), true, id);
  }
  for (const id of ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', '']) {
    assert.equal(isGameCubePad(id), false, id);
  }
});
