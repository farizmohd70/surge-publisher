'use strict';
/* Shared state and helpers for the Surge Publisher window. */

const $ = (id) => document.getElementById(id);

// Tiny DOM builder: h('div', {class:'x', onclick: fn}, child, child...)
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  let late;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') late = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['checked', 'disabled', 'hidden', 'draggable', 'tabIndex', 'selected', 'readOnly'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  if (late !== undefined) e.value = late;
  return e;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ---------- state ---------- */
const DEFAULT_PREFS = {
  theme: 'auto', accent: '', zoom: 1, density: 'comfortable',
  confirmPublish: true, checks: true, openAfter: false, notify: true, dropPublish: false,
  activeAccount: '', acctFilter: true, autoDelay: 3, paused: false, healthMinutes: 5, pgHide: 60, animations: true,
};
let prefs = { ...DEFAULT_PREFS };
let sites = [];
let selId = null;
let busy = false;
const health = {}; // domain -> { ok, status, ms, at }

function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function newSite(p = {}) {
  return {
    id: uid(), name: 'New site', folder: '', domain: '', last: null, watch: false,
    emoji: '', color: '', group: '', exclude: '', build: '', buildDir: '', spa: false,
    schedule: null, history: [], lastPreview: '', undo: null, muted: [], accountId: '', pinned: false, archived: false,
    ...p,
  };
}
function normalizeSite(s) {
  const o = newSite(s && typeof s === 'object' ? s : {});
  if (!Array.isArray(o.history)) o.history = [];
  if (!Array.isArray(o.muted)) o.muted = [];
  if (!/^#[0-9a-f]{6}$/i.test(o.color || '')) o.color = '';
  return o;
}
const cur = () => sites.find((s) => s.id === selId) || null;

function loadAll() {
  try { sites = JSON.parse(store.get('surge.sites') || '[]').map(normalizeSite); } catch { sites = []; }
  selId = store.get('surge.sel');
  if (!sites.find((s) => s.id === selId)) selId = sites[0] ? sites[0].id : null;
  prefs = { ...DEFAULT_PREFS };
  const raw = store.get('surge.prefs');
  if (raw) { try { Object.assign(prefs, JSON.parse(raw)); } catch {} }
  else { // carry over settings from earlier versions
    const p = parseInt(store.get('surge.pgHide'), 10);
    if (!isNaN(p)) prefs.pgHide = p;
    if (store.get('surge.autopub') === '1') prefs.dropPublish = true;
  }
}
function saveSites() {
  const ok = store.set('surge.sites', JSON.stringify(sites)) && store.set('surge.sel', selId || '');
  if (!ok) toast('Could not save your sites (storage full?)', 'err');
  scheduleSync();
  scheduleTray();
}
function savePrefs() { store.set('surge.prefs', JSON.stringify(prefs)); }

/* ---------- formatting ---------- */
function fmtB(n) {
  if (!isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : Math.round(n)) + ' ' + u[i];
}
function fmtT(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function fmtDT(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function parentOf(p) { return String(p || '').replace(/[\\/][^\\/]+[\\/]*$/, ''); }

/* ---------- output log & toasts ---------- */
function addLog(text, kind = 'out') {
  const log = $('log');
  log.appendChild(h('span', { class: kind }, text + '\n'));
  while (log.childNodes.length > 3000) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

/* ---------- modal dialogs ---------- */
const modalStack = [];
function modal({ title, content, buttons, wide = false, onOpen }) {
  buttons = buttons === undefined ? [{ label: 'Close', value: true, primary: true }] : buttons;
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'backdrop' });
    const entry = {};
    let closed = false;
    const done = (v) => {
      if (closed) return;
      closed = true;
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 170);
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      resolve(v);
    };
    entry.close = () => done(null);
    modalStack.push(entry);

    const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'x keep', title: 'Close (Esc)', onclick: () => done(null) }, '✕')),
      h('div', { class: 'modal-body' }, content),
      buttons.length ? h('div', { class: 'modal-foot' }, buttons.map((b) =>
        h('button', {
          class: b.primary ? 'primary' : b.danger ? 'danger' : '',
          onclick: () => done(typeof b.value === 'function' ? b.value() : b.value),
        }, b.label))) : null);
    backdrop.append(box);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) done(null); });
    $('modalRoot').appendChild(backdrop);
    const first = box.querySelector('.modal-foot .primary') || box.querySelector('input:not([type=checkbox]),select,textarea');
    if (first) first.focus();
    if (onOpen) onOpen(box, done);
  });
}
async function confirmBox(title, message, okLabel = 'OK', danger = false) {
  const v = await modal({
    title, content: h('p', { class: 'mtext' }, message),
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  });
  return v === true;
}


/* ---------- "!" info icon (hover or click to read) ---------- */
function info(text) {
  return h('button', { class: 'info keep', type: 'button', 'aria-label': 'More information', 'data-tip': text }, '!');
}

/* ---------- colour picker: swatches + visual selector + hex code ---------- */
function normHex(v) {
  v = String(v || '').trim();
  if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}
function colorPicker({ value, presets, allowNone, onChange }) {
  let current = normHex(value) || '';
  const native = h('input', { type: 'color', value: current || presets[0] || '#3b82f6', title: 'Pick a colour', 'aria-label': 'Pick a colour' });
  const hex = h('input', { class: 'cp-hex', value: current, placeholder: allowNone ? 'none' : '#RRGGBB', maxlength: '7', spellcheck: 'false', 'aria-label': 'Hex colour code' });
  const sw = h('div', { class: 'swatches' });
  const draw = () => {
    sw.textContent = '';
    if (allowNone) sw.append(h('button', { type: 'button', class: 'sw none keep' + (!current ? ' on' : ''), title: 'No colour', onclick: () => set('') }));
    presets.forEach((p) => sw.append(h('button', { type: 'button', class: 'sw keep' + (current === p ? ' on' : ''), style: `--c:${p}`, title: p, onclick: () => set(p) })));
  };
  const set = (v, fromHex) => {
    current = v;
    if (v) native.value = v;
    if (!fromHex) hex.value = v;
    draw();
    onChange(v);
  };
  native.addEventListener('input', () => set(native.value.toLowerCase()));
  hex.addEventListener('input', () => {
    const n = normHex(hex.value);
    if (n) set(n, true);
    else if (allowNone && hex.value.trim() === '') set('', true);
  });
  hex.addEventListener('blur', () => { hex.value = current; });
  draw();
  return h('div', { class: 'cpicker' }, sw, native, hex);
}

/* ---------- dropdown menu ---------- */
let menuEl = null, menuOutside = null, menuAnchor = null;
function closeMenu() {
  if (!menuEl) return;
  const m = menuEl;
  menuEl = null;
  document.removeEventListener('mousedown', menuOutside, true);
  m.classList.add('closing');
  setTimeout(() => m.remove(), 130);
}
function showMenu(anchor, items) {
  closeMenu();
  menuAnchor = anchor;
  const m = h('div', { class: 'menu', role: 'menu' }, items.map((it) => (it === '-' ? h('hr') : h('button', {
    class: it.danger ? 'danger' : '', disabled: !!it.off,
    onclick: () => { closeMenu(); setTimeout(it.run, 0); },
  }, it.label))));
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, hh = m.offsetHeight;
  const x = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let y = r.bottom + 6;
  if (y + hh > window.innerHeight - 8) y = Math.max(8, r.top - hh - 6);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  menuEl = m;
  menuOutside = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('mousedown', menuOutside, true), 0);
}

/* ---------- segmented control with a sliding indicator ---------- */
function makeSeg(wrap, onChange) {
  const ind = h('span', { class: 'seg-ind' });
  wrap.prepend(ind);
  const buttons = () => [...wrap.querySelectorAll('.seg-btn')];
  const place = (instant) => {
    const on = wrap.querySelector('.seg-btn.on');
    if (!on) return;
    if (instant) ind.style.transition = 'none';
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
    if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
  };
  const set = (k, silent) => {
    buttons().forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    place(false);
    if (!silent && onChange) onChange(k);
  };
  buttons().forEach((b) => b.addEventListener('click', () => set(b.dataset.k)));
  requestAnimationFrame(() => place(true));
  return { set, place };
}
