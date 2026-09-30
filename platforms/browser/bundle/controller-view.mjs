// SPDX-License-Identifier: GPL-3.0-or-later
// Live view of the first connected controller, drawn as a GameCube controller
// or a generic (standard-mapping) gamepad. It reads the same Gamepad API state
// SDL does and labels each control with the GameCube input aurora maps it to
// (extern/aurora/lib/dolphin/pad/pad.cpp: g_defaultButtonsStandard and
// g_defaultButtonsGamecube), so what lights up is what the game receives.

const SVG = 'http://www.w3.org/2000/svg';

// Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping).
const STD = { south: 0, east: 1, west: 2, north: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9,
  up: 12, down: 13, left: 14, right: 15 };

// Which physical button is each GameCube input, per layout (aurora's tables:
// a GameCube pad swaps B and X relative to a generic one).
const LAYOUTS = {
  generic: { A: STD.south, B: STD.east, X: STD.west, Y: STD.north, Z: STD.rb, L: STD.lt, R: STD.rt, Start: STD.start },
  gamecube: { A: STD.south, B: STD.west, X: STD.east, Y: STD.north, Z: STD.rb, L: STD.lt, R: STD.rt, Start: STD.start },
};

/** A GameCube controller: an official or third-party adapter, or a pad that says so. */
export function isGameCubePad(id) {
  return /gamecube|game cube|wup-028|\bgc\b|057e.{0,20}0337|0337.{0,20}057e|mayflash/i.test(id || '');
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

function label(parent, x, y, text, size = 9) {
  const t = el('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'cv-label', 'font-size': size }, parent);
  t.textContent = text;
  return t;
}

// Each drawing returns { svg, parts }: parts maps a control name to an update
// function taken from the live gamepad state.
function button(parent, x, y, r, text, cls, index) {
  const g = el('g', {}, parent);
  const c = el('circle', { cx: x, cy: y, r, class: `cv-btn ${cls}` }, g);
  label(g, x, y, text, Math.max(7, r * 0.9));
  return (pad) => c.classList.toggle('on', !!pad.buttons[index]?.pressed);
}

function pill(parent, x, y, w, h, text, index) {
  const g = el('g', {}, parent);
  const r = el('rect', { x, y, width: w, height: h, rx: h / 2, class: 'cv-btn cv-small' }, g);
  label(g, x + w / 2, y + h / 2, text, 7);
  return (pad) => r.classList.toggle('on', !!pad.buttons[index]?.pressed);
}

function trigger(parent, x, y, w, h, text, index) {
  const g = el('g', {}, parent);
  el('rect', { x, y, width: w, height: h, rx: 3, class: 'cv-trigger' }, g);
  const fill = el('rect', { x, y, width: 0, height: h, rx: 3, class: 'cv-trigger-fill' }, g);
  label(g, x + w / 2, y + h / 2, text, 8);
  return (pad) => {
    const b = pad.buttons[index];
    const v = b ? Math.max(b.value || 0, b.pressed ? 1 : 0) : 0;
    fill.setAttribute('width', (w * v).toFixed(1));
    fill.classList.toggle('on', v > 0.95);
  };
}

function stick(parent, x, y, r, text, axisX, axisY, cls = '') {
  const g = el('g', {}, parent);
  el('circle', { cx: x, cy: y, r, class: `cv-gate ${cls}` }, g);
  const knob = el('circle', { cx: x, cy: y, r: r * 0.45, class: `cv-knob ${cls}` }, g);
  const t = label(g, x, y, text, 7);
  return (pad) => {
    const dx = (pad.axes[axisX] || 0) * r * 0.6;
    const dy = (pad.axes[axisY] || 0) * r * 0.6;
    knob.setAttribute('cx', (x + dx).toFixed(1));
    knob.setAttribute('cy', (y + dy).toFixed(1));
    t.setAttribute('x', (x + dx).toFixed(1));
    t.setAttribute('y', (y + dy).toFixed(1));
    knob.classList.toggle('on', Math.hypot(pad.axes[axisX] || 0, pad.axes[axisY] || 0) > 0.3);
  };
}

function dpad(parent, x, y, s) {
  const g = el('g', {}, parent);
  const arm = (dx, dy, index) => {
    const r = el('rect', { x: x + dx * s - s / 2, y: y + dy * s - s / 2, width: s, height: s, rx: 1.5, class: 'cv-btn cv-small' }, g);
    return (pad) => r.classList.toggle('on', !!pad.buttons[index]?.pressed);
  };
  el('rect', { x: x - s / 2, y: y - s / 2, width: s, height: s, class: 'cv-dpad-mid' }, g);
  const arms = [arm(0, -1, STD.up), arm(0, 1, STD.down), arm(-1, 0, STD.left), arm(1, 0, STD.right)];
  return (pad) => arms.forEach((f) => f(pad));
}

function drawGameCube() {
  const svg = el('svg', { viewBox: '0 0 220 120', class: 'cv-svg' });
  const m = LAYOUTS.gamecube;
  el('path', { class: 'cv-body cv-gc-body', d: 'M40 30 Q30 18 55 16 L165 16 Q190 18 180 30 L200 88 Q206 112 182 112 Q164 112 150 92 L70 92 Q56 112 38 112 Q14 112 20 88 Z' }, svg);
  const parts = [
    trigger(svg, 26, 2, 52, 11, 'L', m.L),
    trigger(svg, 142, 2, 52, 11, 'R', m.R),
    pill(svg, 150, 16, 34, 9, 'Z', m.Z),
    stick(svg, 58, 46, 17, 'stick', 0, 1),
    dpad(svg, 80, 84, 7),
    pill(svg, 100, 52, 20, 9, 'Start', m.Start),
    button(svg, 160, 50, 12, 'A', 'cv-a', m.A),
    button(svg, 140, 64, 7.5, 'B', 'cv-b', m.B),
    button(svg, 180, 38, 7, 'X', 'cv-xy', m.X),
    button(svg, 150, 32, 7, 'Y', 'cv-xy', m.Y),
    stick(svg, 140, 90, 13, 'C', 2, 3, 'cv-c'),
  ];
  return { svg, parts };
}

function drawGeneric() {
  const svg = el('svg', { viewBox: '0 0 220 120', class: 'cv-svg' });
  const m = LAYOUTS.generic;
  el('path', { class: 'cv-body', d: 'M44 24 L176 24 Q200 26 206 60 L212 94 Q214 114 194 112 Q180 110 166 90 L54 90 Q40 110 26 112 Q6 114 8 94 L14 60 Q20 26 44 24 Z' }, svg);
  const parts = [
    trigger(svg, 20, 2, 52, 11, 'L', m.L),
    trigger(svg, 148, 2, 52, 11, 'R', m.R),
    pill(svg, 150, 15, 44, 8, 'Z', m.Z),
    pill(svg, 26, 15, 44, 8, '—', STD.lb),
    stick(svg, 52, 50, 14, 'stick', 0, 1),
    dpad(svg, 82, 78, 7),
    pill(svg, 100, 44, 20, 9, 'Start', m.Start),
    button(svg, 168, 64, 8, 'A', 'cv-a', m.A),
    button(svg, 184, 50, 8, 'B', 'cv-b', m.B),
    button(svg, 152, 50, 8, 'X', 'cv-xy', m.X),
    button(svg, 168, 36, 8, 'Y', 'cv-xy', m.Y),
    stick(svg, 138, 78, 12, 'C', 2, 3, 'cv-c'),
  ];
  return { svg, parts };
}

/**
 * Keep `root` showing the first connected controller. `root` gets the drawing,
 * a name line and a hint while nothing is connected (browsers only reveal a
 * controller after one of its buttons is pressed).
 */
export function startControllerView(root, { getGamepads = () => navigator.getGamepads?.() ?? [] } = {}) {
  const title = document.createElement('div');
  title.className = 'cv-title';
  const holder = document.createElement('div');
  holder.className = 'cv-holder';
  root.append(title, holder);
  let current = null; // { index, id, kind, parts }

  function frame() {
    const pad = [...getGamepads()].find((p) => p && p.connected);
    if (!pad) {
      if (current || !title.textContent) {
        current = null;
        holder.replaceChildren();
        title.textContent = 'No controller: plug one in and press any button';
        root.dataset.kind = 'none';
      }
    } else {
      if (!current || current.index !== pad.index || current.id !== pad.id) {
        const kind = isGameCubePad(pad.id) ? 'gamecube' : 'generic';
        const { svg, parts } = kind === 'gamecube' ? drawGameCube() : drawGeneric();
        holder.replaceChildren(svg);
        const name = pad.id.replace(/\s*\((?:STANDARD GAMEPAD|XInput STANDARD GAMEPAD)?[^)]*\)\s*$/, '').trim() || 'Controller';
        title.textContent = `${kind === 'gamecube' ? 'GameCube' : 'Controller'} · ${name}`;
        root.dataset.kind = kind;
        current = { index: pad.index, id: pad.id, kind, parts };
      }
      for (const update of current.parts) update(pad);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { get kind() { return current?.kind ?? 'none'; } };
}
