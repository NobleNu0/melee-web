// SPDX-License-Identifier: GPL-3.0-or-later
// The dialog behind the two buttons in the controller chip: the setup wizard
// (gamepads.mjs createWizard, driven here from the live Gamepad API) and the
// help for an adapter that did not connect (gc-adapter.mjs adapterHelp).

import { createWizard, parseId } from './gamepads.mjs';

function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

export function createPadDialog(dialog, { gamepads, onClose = () => {} }) {
  const title = dialog.querySelector('h2');
  const body = dialog.querySelector('.body');
  const actions = dialog.querySelector('.actions');
  let stop = null; // ends whatever is running in the dialog

  dialog.addEventListener('close', () => {
    stop?.();
    stop = null;
    onClose();
  });

  function show(heading, parts, buttons) {
    title.textContent = heading;
    body.replaceChildren(...parts);
    actions.replaceChildren(...buttons.map(([label, action]) => {
      const button = node('button', label);
      button.type = 'button';
      button.addEventListener('click', action);
      return button;
    }));
    if (!dialog.open) dialog.showModal();
  }
  const close = () => dialog.close();

  /** Paragraphs of help; a line that looks like a udev rule is shown as code. */
  function help(heading, lines) {
    stop?.();
    stop = null;
    show(heading, lines.map((line) => node(/^(KERNEL|SUBSYSTEM)==/.test(line) ? 'code' : 'p', line)), [['Close', close]]);
  }

  /** Walk the player through every GameCube input on one of their gamepads. */
  function setup() {
    stop?.();
    let pad = null;
    let wizard = null;
    let shown = '';
    let frame = 0;
    let finished = false;
    const prompt = node('p', '', 'prompt');
    const progress = node('p', '', 'note');
    const name = node('p', '', 'note');

    const release = () => { if (pad) gamepads.mute(pad, false); };
    stop = () => {
      cancelAnimationFrame(frame);
      if (!finished) release();
    };

    function pick() {
      pad = wizard = null;
      const saved = gamepads.connected().filter((p) => gamepads.hasCustom(p));
      const buttons = [['Cancel', close]];
      if (saved.length) {
        buttons.unshift(['Forget saved layout', () => {
          for (const p of saved) gamepads.setProfile(p, null);
          close();
        }]);
      }
      show('Set up a controller', [
        node('p', 'Press any button on the controller you want to set up.', 'prompt'),
        node('p', 'You will be asked for each GameCube button and stick in turn; press whatever you want to use for it. '
          + 'The layout is remembered for that kind of controller in this browser.', 'note'),
        node('p', 'Controllers on the official adapter, connected with the "GameCube adapter" button, need no setup.', 'note'),
      ], buttons);
    }

    function begin(chosen) {
      pad = chosen;
      gamepads.mute(pad, true); // the game must not act on what the wizard is asking for
      wizard = createWizard({ name: parseId(pad.id).name || 'Custom controller' });
      shown = '';
      name.textContent = parseId(pad.id).name || 'Controller';
      show('Set up a controller', [name, prompt, progress, node('p', 'Skip anything this controller does not have.', 'note')], [
        ['Skip', () => wizard?.skip()],
        ['Start over', () => { release(); pick(); }],
        ['Cancel', close],
      ]);
    }

    function save() {
      finished = true;
      const profile = wizard.result;
      const count = Object.keys(profile.buttons).length + Object.keys(profile.sticks).length;
      if (count) gamepads.setProfile(pad, profile);
      release();
      show('Set up a controller', [
        node('p', count ? 'Saved. The controller is ready.' : 'Nothing was assigned, so nothing was saved.', 'prompt'),
        node('p', count ? 'To change it, run the setup again; "Forget saved layout" there goes back to the default.' : '', 'note'),
      ], [['Done', close]]);
    }

    function tick() {
      frame = requestAnimationFrame(tick);
      if (finished) return;
      if (!pad) {
        const chosen = gamepads.connected().find((p) => p.buttons.some((b) => b.pressed));
        if (chosen) begin(chosen);
        return;
      }
      const live = gamepads.raw()[pad.index];
      if (!live || !live.connected) {
        finished = true;
        show('Set up a controller', [node('p', 'The controller was disconnected.', 'prompt')], [['Close', close]]);
        return;
      }
      wizard.feed(live);
      if (wizard.done) {
        save();
      } else if (wizard.prompt !== shown) {
        shown = wizard.prompt;
        prompt.textContent = shown;
        progress.textContent = wizard.step < 0 ? '' : `${wizard.step + 1} of ${wizard.total}`;
      }
    }

    pick();
    frame = requestAnimationFrame(tick);
  }

  return { help, setup };
}
