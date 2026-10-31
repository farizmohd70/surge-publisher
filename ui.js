'use strict';
/* Settings dialog, command palette, shortcuts, Surge commands tab, output box, file drop, startup. */

/* ---------- appearance ---------- */
function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#0b1020' : '#ffffff';
}
function applyPrefs() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = prefs.density;
  root.dataset.anim = prefs.animations === false ? 'off' : 'on';
  const acc = /^#[0-9a-f]{6}$/i.test(prefs.accent) ? prefs.accent : dark ? '#5b8cff' : '#2f6fed';
  root.style.setProperty('--accent', acc);
  root.style.setProperty('--accent-text', readableOn(acc));
  window.api.setZoom(prefs.zoom);
  updatePauseButton();
  applyStyle();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.theme === 'auto') applyPrefs(); });

/* ---------- UI styles (the CSS lives in themes.css; "default" = no data-style attribute) ---------- */
const UI_STYLES = [
  { id: 'default', name: 'Default', desc: 'The original clean look.',
    prev: 'background:#f5f6f8;border:1px solid #e4e7ec', dot: 'background:#2f6fed;border-radius:7px' },
  { id: 'glass', name: 'Glassmorphism', desc: 'Frosted translucent panels over a soft, slowly drifting gradient.',
    prev: 'background:linear-gradient(135deg,#7C5CFF,#29D3FF 55%,#FF6FB5)',
    dot: 'background:rgba(255,255,255,.3);border:1px solid rgba(255,255,255,.65);border-radius:12px;backdrop-filter:blur(6px)' },
  { id: 'neu', name: 'Neumorphism', desc: 'Soft UI: everything looks pressed into or raised out of one surface.',
    prev: 'background:#E6EAF2', dot: 'background:#E6EAF2;border-radius:12px;box-shadow:-4px -4px 8px #fff,4px 4px 8px #B8C0D0' },
  { id: 'skeuo', name: 'Skeuomorphism', desc: 'A brushed-metal audio rack: bevels, screws, LEDs and an LCD output.',
    prev: 'background:linear-gradient(180deg,#d9dce1,#8f949c)',
    dot: 'background:linear-gradient(180deg,#f4f5f7,#c0c4cb);border:1px solid #6c717a;border-radius:5px;box-shadow:inset 0 1px 0 #fff,0 2px 0 #6c717a' },
  { id: 'spatial', name: 'Spatial UI', desc: 'visionOS-style floating glass slabs with depth, glow and cursor parallax.',
    prev: 'background:linear-gradient(160deg,#16255a,#2a1b5e)',
    dot: 'background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.4);border-radius:999px;box-shadow:0 10px 24px rgba(0,0,0,.35)' },
  { id: 'max', name: 'Maximalism', desc: 'Loud colour, thick borders, hard shadows and patterns, with three colour moods.',
    prev: 'background:radial-gradient(circle at 1px 1px,#FF2E93 2px,transparent 2.6px) 0 0/14px 14px,#FFF4D6',
    dot: 'background:#FF2E93;border:3px solid #0B0B0F;border-radius:999px;box-shadow:4px 4px 0 #0B0B0F' },
  { id: 'clay', name: 'Claymorphism', desc: 'Soft, puffy, pastel 3D shapes that squish when pressed.',
    prev: 'background:#F6F1FF',
    dot: 'background:#FFB5A7;border-radius:16px;box-shadow:0 8px 14px rgba(217,100,80,.3),inset 4px 4px 8px rgba(255,255,255,.7),inset -5px -5px 9px rgba(217,100,80,.25)' },
];
const UI_MOODS = [['1', 'Candy pop'], ['2', 'Acid night'], ['3', 'Sunset riso']];
const UI_FX = {   // each style's own "reduce effects" switch: [label, help]
  glass: ['Reduce transparency', 'Swaps the frosted glass for solid tinted surfaces and stops the background drift.'],
  skeuo: ['Simple mode', 'Replaces the metal textures and screws with flat gradients.'],
  spatial: ['Reduce transparency and motion', 'Solid surfaces; turns off the cursor parallax, hover lift and glow.'],
  max: ['Calm mode', 'Removes the patterns, grain, tilt and wobble, and mutes the colours by 40%.'],
  clay: ['Reduce effects', 'Uses one soft shadow per element instead of the full clay shadow stack and stops the floating blobs.'],
};
const validStyle = (v) => UI_STYLES.some((s) => s.id === v);
function uiStyle() { const v = store.get('surge.style'); return validStyle(v) ? v : 'default'; }
function setUiStyle(id) { store.set('surge.style', validStyle(id) ? id : 'default'); applyStyle(); }
function resetUiStyle() { store.del('surge.style'); store.del('surge.mood'); store.del('surge.fx'); }

function applyStyle() {
  const root = document.documentElement, st = uiStyle();
  if (st === 'default') { delete root.dataset.style; delete root.dataset.mood; delete root.dataset.fx; }
  else {
    root.dataset.style = st;
    const mood = store.get('surge.mood');
    if (st === 'max') root.dataset.mood = ['1', '2', '3'].includes(mood) ? mood : '1'; else delete root.dataset.mood;
    if (UI_FX[st] && store.get('surge.fx') === '1') root.dataset.fx = 'reduced'; else delete root.dataset.fx;
  }
  syncSpatial();
  requestAnimationFrame(replaceSegs);   // button sizes differ per style: re-measure the sliding tab indicators
}
function replaceSegs() {
  document.querySelectorAll('.seg').forEach((w) => {
    const on = w.querySelector('.seg-btn.on'), ind = w.querySelector('.seg-ind');
    if (!on || !ind || !on.offsetWidth) return;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  });
}

/* Spatial style only: cursor parallax for the background + a light that follows the cursor over buttons and rows. */
let spatialOn = false, spatialRaf = 0, spatialEv = null;
const SPATIAL_HIT = '.site, button:not(.seg-btn):not(.slink):not(.foot-btn):not(.x):not(.sw):not(.info)';
function spatialMove(e) {
  spatialEv = e;
  if (spatialRaf) return;
  spatialRaf = requestAnimationFrame(() => {
    spatialRaf = 0;
    const ev = spatialEv, root = document.documentElement;
    root.style.setProperty('--px', (ev.clientX / window.innerWidth - 0.5).toFixed(3));
    root.style.setProperty('--py', (ev.clientY / window.innerHeight - 0.5).toFixed(3));
    const t = ev.target && ev.target.closest ? ev.target.closest(SPATIAL_HIT) : null;
    if (t) {
      const r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
      t.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    }
  });
}
function syncSpatial() {
  const root = document.documentElement;
  const want = root.dataset.style === 'spatial' && root.dataset.fx !== 'reduced' && prefs.animations !== false
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (want === spatialOn) return;
  spatialOn = want;
  if (want) document.addEventListener('mousemove', spatialMove, { passive: true });
  else {
    document.removeEventListener('mousemove', spatialMove);
    cancelAnimationFrame(spatialRaf); spatialRaf = 0;
    root.style.removeProperty('--px'); root.style.removeProperty('--py');
  }
}

/* ---------- tabs ---------- */
let topSeg = null;
function setTab(t) {
  $('sitePanel').hidden = t !== 'site';
  $('cmds').hidden = t !== 'cmds';
  if (topSeg) topSeg.set(t, true);
  const el = t === 'site' ? $('sitePanel') : $('cmds');
  el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
}

/* ---------- render everything ---------- */
function render() { renderList(); renderEditor(); syncCmds(); applyBusy(); }

/* ---------- settings dialog ---------- */
function sCheck(label, checked, onChange, sub) {
  const cb = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onChange(cb.checked) });
  return h('label', { class: 'srow', style: 'cursor:pointer' }, h('div', { class: 'lbl' }, label, sub ? info(sub) : null), cb);
}
function sNumber(label, value, min, max, onChange, sub) {
  const inp = h('input', { type: 'number', min, max, value });
  inp.onchange = () => {
    let v = parseInt(inp.value, 10);
    if (isNaN(v)) v = value;
    v = Math.min(max, Math.max(min, v));
    inp.value = v; onChange(v);
  };
  return h('div', { class: 'srow' }, h('div', { class: 'lbl' }, label, sub ? info(sub) : null), inp);
}
function sSelect(label, options, value, onChange) {
  const sel = h('select', { onchange: () => onChange(sel.value) }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  return h('div', { class: 'srow' }, h('div', { class: 'lbl' }, label), sel);
}
function setPref(k, v) { prefs[k] = v; savePrefs(); applyPrefs(); }

async function openSettings(tab = 'general') {
  const body = h('div');
  const main = await window.api.getSettings();
  const pushMain = async (patch) => { Object.assign(main, await window.api.setSettings({ ...main, ...patch })); };

  const panes = {
    general: () => [
      sCheck('Confirm before publishing', prefs.confirmPublish, (v) => setPref('confirmPublish', v), 'Shows the site, domain, folder and any warnings before each manual publish.'),
      sCheck('Run pre-publish checks', prefs.checks, (v) => setPref('checks', v), 'Warns about a missing index.html, private files (.env, keys), .git, node_modules and huge files.'),
      sCheck('Open the live site after publishing', prefs.openAfter, (v) => setPref('openAfter', v)),
      sCheck('Desktop notifications when the window is hidden', prefs.notify, (v) => setPref('notify', v)),
      sCheck('Publish automatically after dropping files', prefs.dropPublish, (v) => setPref('dropPublish', v)),
      sNumber('Auto-publish waits until files stop changing for (seconds)', prefs.autoDelay, 1, 120, (v) => setPref('autoDelay', v), 'Keeps it from publishing in the middle of a save or build.'),
      sCheck('Pause auto-publish', prefs.paused, (v) => setPaused(v)),
      sNumber('Hide the progress bar after (seconds, 0 = never)', prefs.pgHide, 0, 3600, (v) => setPref('pgHide', v)),
    ],
    appearance: () => [
      sSelect('Theme', [['auto', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']], prefs.theme, (v) => setPref('theme', v)),
      h('div', { class: 'srow', style: 'border-bottom:none;padding-bottom:4px' },
        h('div', { class: 'lbl' }, 'Accent colour', info('Used for buttons, highlights and selections. Pick a swatch, use the colour selector, or type a hex code.'))),
      h('div', { style: 'padding:0 0 12px;border-bottom:1px solid var(--line)' },
        colorPicker({ value: prefs.accent || '#2f6fed', presets: ['#2f6fed', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0891b2'], allowNone: false, onChange: (v) => setPref('accent', v) }),
        h('div', { class: 'actions', style: 'margin-top:8px' }, h('button', { class: 'sm', onclick: () => { setPref('accent', ''); draw('appearance'); } }, 'Reset to default'))),
      sSelect('Text size', [[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%']], prefs.zoom, (v) => setPref('zoom', parseFloat(v))),
      sSelect('Site list density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], prefs.density, (v) => setPref('density', v)),
      sCheck('Animations', prefs.animations !== false, (v) => setPref('animations', v), 'Smooth transitions and motion throughout the app. Turn off for a calmer, faster feel.'),
    ],
    style: () => {
      const cur = uiStyle();
      const grid = h('div', { class: 'stylegrid' });
      grid.setAttribute('role', 'radiogroup');
      UI_STYLES.forEach((s) => {
        const on = s.id === cur;
        const el = h('div', { class: 'stylecard' + (on ? ' on' : '') },
          h('div', { class: 'sc-prev', style: s.prev }, h('i', { class: 'sc-dot', style: s.dot })),
          h('div', { class: 'sc-name' }, s.name, on ? '✓' : null),
          h('div', { class: 'sc-desc' }, s.desc));
        el.setAttribute('role', 'radio'); el.setAttribute('aria-checked', String(on)); el.setAttribute('tabindex', '0');
        const pick = () => { setUiStyle(s.id); draw('style'); const n = body.querySelector('.stylecard.on'); if (n) n.focus(); };
        el.onclick = pick;
        el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
        grid.append(el);
      });
      const out = [
        h('div', { class: 'fieldnote', style: 'margin-bottom:6px' }, 'Choose how the whole app looks. Light / dark theme and the accent colour (Appearance) still apply on top of every style.'),
        grid,
      ];
      if (UI_FX[cur]) out.push(sCheck(UI_FX[cur][0], store.get('surge.fx') === '1', (v) => { store.set('surge.fx', v ? '1' : '0'); applyStyle(); }, UI_FX[cur][1]));
      if (cur === 'max') out.push(sSelect('Colour mood', UI_MOODS, store.get('surge.mood') || '1', (v) => { store.set('surge.mood', v); applyStyle(); }));
      return out;
    },
    background: () => [
      sCheck('Keep running in the tray when I close the window', main.tray, (v) => pushMain({ tray: v }), 'Needed for auto-publish and schedules to keep working in the background.'),
      sCheck('Start with Windows (hidden in the tray)', main.startup, async (v) => { await pushMain(v ? { startup: true, tray: true } : { startup: false }); }),
      sCheck('Global shortcut Ctrl+Alt+P publishes the selected site', main.globalShortcut, (v) => pushMain({ globalShortcut: v }), 'Works even when the app is in the tray.'),
      sNumber('Check whether my sites are online every (minutes, 0 = off)', prefs.healthMinutes, 0, 240, (v) => { setPref('healthMinutes', v); restartHealthTimer(); }),
    ],
    account: () => [acctManager()],
    data: () => [
      h('div', { class: 'actions', style: 'margin-top:0' },
        h('button', { onclick: exportSites }, 'Export site list'),
        h('button', { onclick: importSites }, 'Import site list'),
        h('button', { onclick: () => { const s = cur(); if (s) window.api.openBackups(s.name); else toast('Select a site first', 'err'); } }, 'Open backups folder'),
        info('Exports include names, folders, domains, groups, exclude rules and build commands. Account tokens are never exported.')),
      h('div', { class: 'actions' },
        h('button', { class: 'danger', onclick: async () => {
          if (await confirmBox('Clear all publish history?', 'This removes the history lists for every site.', 'Clear', true)) { sites.forEach((s) => { s.history = []; }); saveSites(); renderEditor(); toast('History cleared'); }
        } }, 'Clear all history'),
        h('button', { class: 'danger', onclick: async () => {
          if (await confirmBox('Reset settings?', 'All options in this window go back to their defaults. Your sites are kept.', 'Reset', true)) { prefs = { ...DEFAULT_PREFS }; resetUiStyle(); savePrefs(); applyPrefs(); restartHealthTimer(); toast('Settings reset'); }
        } }, 'Reset settings')),
    ],
  };
  const names = [['general', 'General'], ['appearance', 'Appearance'], ['style', 'Style'], ['background', 'Background'], ['account', 'Account'], ['data', 'Data']];
  const draw = (t) => {
    body.textContent = '';
    body.append(h('div', { class: 'settings-pane' }, ...panes[t]()));
  };
  const tabBar = h('div', { class: 'seg' }, names.map(([k, label]) => h('button', { class: 'seg-btn' + (k === tab ? ' on' : ''), 'data-k': k }, label)));
  makeSeg(tabBar, draw);
  draw(tab);
  await modal({ title: 'Settings', wide: true, content: h('div', {}, h('div', { style: 'margin-bottom:10px;display:flex' }, tabBar), body), buttons: [{ label: 'Done', value: true, primary: true }] });
  scheduleTray();
}

/* ---------- command palette ---------- */
let palItems = [], palSel = 0;
function paletteActions() {
  const s = cur();
  const act = (t, run, sub = '') => ({ t, run, sub });
  const list = [
    act('Add a new site', addSite, 'Ctrl N'),
    act('Publish selected site', () => s && publishSite(s), 'Ctrl P'),
    act('Publish preview of selected site', () => s && publishSite(s, { preview: true })),
    act('Publish all sites', publishAll, 'Ctrl Shift P'),
    act('Open selected site in browser', () => s && s.domain && window.api.openUrl('https://' + s.domain)),
    act('Copy link of selected site', () => s && copyLink(s)),
    act('Show QR code of selected site', () => s && showQR(s)),
    act('Local preview of selected site', () => s && localPreview(s)),
    act('Open selected site folder', () => s && window.api.openPath(s.folder)),
    act('Check whether sites are online now', () => checkHealth()),
    act(prefs.paused ? 'Resume auto-publish' : 'Pause auto-publish', togglePause),
    act('List my Surge sites (add to list)', listMySites),
    act('New category…', () => openCategoryDialog()),
    act('Add account', openAddAccount),
    act('Switch account', openSwitcher),
    ...[...accounts, null].filter((x) => (x ? x.id : '') !== activeId()).map((x) => act('Switch to ' + acctLabel(x), () => switchAccount(x ? x.id : ''), 'Account')),
    act('Open settings', () => openSettings(), 'Ctrl ,'),
    ...UI_STYLES.filter((x) => x.id !== uiStyle()).map((x) => act('UI style: ' + x.name, () => setUiStyle(x.id), 'Settings → Style')),
    act('Export site list', exportSites),
    act('Import site list', importSites),
    act('Show Surge commands', () => setTab('cmds')),
    act('Show site settings', () => setTab('site')),
    act('Expand / collapse output', () => toggleExpand()),
  ];
  if (s) {
    list.push(act(s.pinned ? 'Unpin selected site' : 'Pin selected site to top', () => togglePin(s)));
    list.push(act(s.archived ? 'Restore selected site from archive' : 'Archive selected site', () => toggleArchive(s)));
  }
  sites.forEach((x) => list.push(act((x.archived ? 'Go to (archived) ' : 'Go to ') + (x.name || x.domain), () => { selectSite(x.id); setTab('site'); }, x.domain)));
  sites.filter((x) => !x.archived).forEach((x) => list.push(act('Publish ' + (x.name || x.domain), () => publishSite(x), x.domain)));
  return list;
}
function drawPalette() {
  const q = $('palInput').value.toLowerCase().split(/\s+/).filter(Boolean);
  palItems = paletteActions().filter((a) => q.every((w) => (a.t + ' ' + a.sub).toLowerCase().includes(w))).slice(0, 40);
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  const box = $('palList');
  box.textContent = '';
  if (!palItems.length) { box.append(h('div', { class: 'empty' }, 'Nothing matches.')); return; }
  palItems.forEach((a, i) => box.append(h('div', {
    class: 'item' + (i === palSel ? ' on' : ''),
    onmousemove: () => { if (palSel !== i) { palSel = i; box.querySelectorAll('.item').forEach((el, j) => el.classList.toggle('on', j === i)); } },
    onclick: () => runPalette(i),
  }, h('span', {}, a.t), h('span', { class: 'sub' }, a.sub))));
  const on = box.querySelector('.item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function openPalette() { $('palette').hidden = false; $('palInput').value = ''; palSel = 0; drawPalette(); $('palInput').focus(); }
function closePalette() { $('palette').hidden = true; }
function runPalette(i) { const a = palItems[i]; closePalette(); if (a) setTimeout(a.run, 0); }
$('palInput').addEventListener('input', () => { palSel = 0; drawPalette(); });
$('palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); drawPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palSel); }
});
$('palette').addEventListener('mousedown', (e) => { if (e.target === $('palette')) closePalette(); });

/* ---------- keyboard shortcuts ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('tip').classList.remove('show');
    if (menuEl) { closeMenu(); return; }
    if (!$('palette').hidden) { closePalette(); return; }
    if (modalStack.length) { modalStack[modalStack.length - 1].close(); return; }
    toggleExpand(false);
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || modalStack.length) return;
  const k = e.key.toLowerCase();
  if (k === 'k') { e.preventDefault(); openPalette(); }
  else if (k === 'p') { e.preventDefault(); if (e.shiftKey) publishAll(); else if (cur()) publishSite(cur()); }
  else if (k === 'n') { e.preventDefault(); addSite(); }
  else if (k === ',') { e.preventDefault(); openSettings(); }
  else if (k === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const vis = visibleSites();
    const i = vis.findIndex((s) => s.id === selId);
    const n = vis[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (n) selectSite(n.id);
  }
});

/* ---------- tray & global shortcut actions ---------- */
window.api.onTray((a) => {
  const src = document.hidden ? 'all' : 'manual';   // dialogs can't be answered while the window is hidden
  if (a.type === 'publish') { const s = sites.find((x) => x.id === a.id); if (s) publishSite(s, { source: src }); }
  else if (a.type === 'publish-selected') { const s = cur(); if (s) publishSite(s, { source: src }); else toast('Select a site first', 'err'); }
  else if (a.type === 'publish-all') publishAll();
  else if (a.type === 'pause') setPaused(a.value);
});

/* ---------- Surge commands tab ---------- */
const CATALOG = [
  ['Publishing & revisions', [
    ['list', 'opt', 'List all your projects, or the revisions of one domain'],
    ['rollback', 'req', 'Make the previous revision live'],
    ['rollfore', 'req', 'Make the next revision live'],
    ['cutover', 'req', 'Make a specific revision live (put the revision in Extra arguments)'],
    ['discard', 'req', 'Delete a revision (put the revision in Extra arguments)', true],
    ['teardown', 'req', 'Take the project offline and remove it from the domain', true],
  ]],
  ['Domains & DNS', [
    ['dns', 'req', 'List DNS records (Extra arguments: add … / rem <id>)'],
    ['zone', 'req', 'Show the full DNS zone (supports add / rem)'],
  ]],
  ['SSL', [
    ['encrypt', 'req', 'Provision a free SSL certificate'],
    ['certs', 'req', 'Show the certificates for a domain'],
    ['ssl', 'req', 'Upload your own SSL certificate (interactive)'],
  ]],
  ['Settings & analytics', [
    ['config', 'req', 'View and change project settings (interactive)'],
    ['traffic', 'req', 'Traffic analytics'], ['audience', 'req', 'Audience analytics'],
    ['usage', 'req', 'Usage analytics'], ['load', 'req', 'Load analytics'],
  ]],
  ['Diagnostics', [
    ['files', 'req', 'List the files of the live project'],
    ['audit', 'req', 'Show the audit log for a domain'],
    ['bust', 'req', 'Clear the CDN cache for a domain'],
  ]],
  ['Collaborators', [
    ['invite', 'req', 'Invite collaborators (put emails in Extra arguments)'],
    ['revoke', 'req', 'Revoke publishing rights (put emails in Extra arguments)'],
  ]],
  ['Account', [
    ['login', 'none', 'Log in (use Settings → Account to enter email and password)'],
    ['logout', 'none', 'Remove the stored login'],
    ['whoami', 'none', 'Show the logged-in email and plan'],
    ['verify', 'none', 'Send an email verification link'],
    ['token', 'none', 'Print an auth token for CI or a per-site account (keep it private)'],
    ['plan', 'none', 'View or change your plan (interactive)'],
    ['nuke', 'none', 'Delete your entire Surge account', true],
  ]],
  ['Utility', [['--help', 'none', 'Show every command and flag'], ['--version', 'none', 'Show the Surge version']]],
];

async function runCmd(name, dom, desc, danger) {
  const domain = $('cDomain').value.trim();
  const args = $('cArgs').value.trim();
  if (dom === 'req' && !domain) { addLog(`"${name}" needs a domain. Enter one above or pick a saved site.`, 'err'); return; }
  if (name === 'login') { openAddAccount(); return; }
  if (name === 'logout' && activeId()) { removeAccount(acct(activeId())); return; }
  if (danger && !(await confirmBox('Run this command?', `${desc}.\n\nRun “surge ${name}${domain ? ' ' + domain : ''}”?`, 'Run', true))) return;
  if (name === 'nuke' && !(await confirmBox('Delete your account?', 'This permanently deletes your Surge account. Are you absolutely sure?', 'Delete account', true))) return;
  if (name === 'logout' || name === 'whoami') {
    await run({ action: name });
    refreshStatus();
    return;
  }
  const res = await run({ action: 'cmd', sub: name, domain: dom === 'none' ? '' : domain, args });
  if (name === 'list' && !domain && !args && res && res.code === 0) importSitesFromList(res.output);
}

function buildCmdsPanel() {
  const box = $('cmds');
  box.append(
    h('h2', { style: 'display:flex;align-items:center;gap:8px' }, 'Surge commands', info('Hover a button to see what it does. Commands that ask questions (plan, config, ssl, nuke…) can be answered in the box under Output. Run “--help” for full options.')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('input', { id: 'cDomain', placeholder: 'domain, e.g. example.surge.sh', spellcheck: 'false' }),
      h('select', { id: 'cSite', title: 'Fill the domain from a saved site', onchange: (e) => { if (e.target.value) $('cDomain').value = e.target.value; } })),
    h('label', { for: 'cArgs' }, 'Extra arguments (optional)'),
    h('input', { id: 'cArgs', placeholder: 'e.g. a revision, emails, add / rem …', spellcheck: 'false' }),
    h('div', { id: 'cGroups' }),
    h('label', { for: 'cRaw' }, 'Run any other command'),
    h('div', { class: 'row' },
      h('input', { id: 'cRaw', placeholder: 'only the part after “surge”, e.g. list --help', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') $('cRun').click(); } }),
      h('button', { id: 'cRun', onclick: () => { const a = $('cRaw').value.trim(); if (a) run({ action: 'raw', args: a }); } }, 'Run')),);
  const groups = $('cGroups');
  CATALOG.forEach(([title, cmds]) => {
    groups.append(h('div', { class: 'grp' }, h('h3', {}, title),
      h('div', { class: 'btns' }, cmds.map(([name, dom, desc, danger]) => h('button', {
        class: danger ? 'danger' : '',
        title: desc + (dom === 'req' ? ' — needs a domain' : dom === 'opt' ? ' — domain optional' : ''),
        onclick: () => runCmd(name, dom, desc, danger),
      }, name)))));
  });
}
let lastCmdSel = null;
function syncCmds() {
  const sel = $('cSite');
  if (!sel) return;
  sel.textContent = '';
  sel.append(h('option', { value: '' }, 'Saved sites…'));
  sites.filter((s) => s.domain).forEach((s) => sel.append(h('option', { value: s.domain }, s.name || s.domain)));
  if (selId !== lastCmdSel) { lastCmdSel = selId; const s = cur(); $('cDomain').value = s ? s.domain : ''; }
}

/* ---------- output box: expand, resize, answer prompts ---------- */
function toggleExpand(force) {
  const t = document.querySelector('.term');
  const on = typeof force === 'boolean' ? force : !t.classList.contains('big');
  t.classList.toggle('big', on);
  $('expand').textContent = on ? '⤡ Collapse' : '⤢ Expand';
  $('log').scrollTop = $('log').scrollHeight;
}
(function setupTerminal() {
  const term = document.querySelector('.term'), scroller = document.querySelector('.content'), grip = $('grip');
  const KEY = 'surge.termH2';
  const maxH = () => Math.max(200, scroller.clientHeight - 20);
  const setH = (v) => {
    if (!v) { term.style.flexBasis = ''; term.style.minHeight = ''; return; }
    const px = Math.min(maxH(), Math.max(160, v)) + 'px';
    term.style.flexBasis = px; term.style.minHeight = px;
  };
  const saved = parseInt(store.get(KEY), 10);
  if (saved) setH(saved);
  let startY = 0, startH = 0, startScroll = 0;
  grip.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startH = term.getBoundingClientRect().height; startScroll = scroller.scrollTop;
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); document.body.style.userSelect = 'none';
  });
  grip.addEventListener('pointermove', (e) => {
    if (!grip.classList.contains('drag')) return;
    setH(startH + (startY - e.clientY));                       // drag up = taller
    scroller.scrollTop = startScroll + (term.getBoundingClientRect().height - startH); // bottom edge stays, top edge moves up
    $('log').scrollTop = $('log').scrollHeight;
  });
  const end = () => {
    if (!grip.classList.contains('drag')) return;
    grip.classList.remove('drag'); document.body.style.userSelect = '';
    const v = parseInt(term.style.minHeight, 10);
    if (v) store.set(KEY, String(v));
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => { setH(0); store.del(KEY); });
  window.addEventListener('resize', () => { const c = parseInt(term.style.minHeight, 10); if (c && c > maxH()) setH(maxH()); });

  $('expand').onclick = () => toggleExpand();
  $('stop').onclick = () => window.api.stop();
  $('clear').onclick = () => { $('log').textContent = ''; };
  const send = async () => {
    const el = $('stdin'), t = el.value;
    if (await window.api.sendInput(t)) { addLog('> ' + t, 'cmd'); el.value = ''; }
    else addLog('No command is waiting for input.', 'err');
  };
  $('sendIn').onclick = send;
  $('stdin').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
})();

/* ---------- dropping files / folders onto the window ---------- */
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const rowOf = (e) => (e.target.closest ? e.target.closest('.site') : null);
function showOverlay(e) {
  const row = rowOf(e);
  const s = (row && sites.find((x) => x.id === row.dataset.id)) || cur();
  $('ovTitle').textContent = 'Drop files or a folder';
  $('ovSub').textContent = s ? 'Target site: ' + (s.name || 'Untitled') : 'A new site will be created';
  $('overlay').hidden = false;
}
document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; showOverlay(e); });
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.querySelectorAll('.site.over').forEach((x) => x.classList.remove('over'));
  const row = rowOf(e); if (row) row.classList.add('over');
  showOverlay(e);
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('overlay').hidden = true;
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('overlay').hidden = true;
  const row = rowOf(e);
  document.querySelectorAll('.site.over').forEach((x) => x.classList.remove('over'));
  handleDrop(e.dataTransfer.files, row ? row.dataset.id : null);
});

async function handleDrop(files, targetId) {
  if (busy) { addLog('Wait for the current command to finish, then drop again.', 'err'); return; }
  const paths = [...files].map((f) => window.api.getPath(f)).filter(Boolean);
  if (!paths.length) return;
  let s = sites.find((x) => x.id === targetId) || cur();
  if (!s) { s = newSite({ accountId: activeId() }); sites.push(s); }
  selId = s.id;
  const r = await window.api.drop({ paths, folder: s.folder, name: s.name, id: s.id });
  if (r.error) { addLog(r.error, 'err'); saveSites(); render(); return; }
  if (r.action === 'cancel') { saveSites(); render(); return; }
  if (r.folder) s.folder = r.folder;
  if (r.action === 'copied') s.undo = r.created + r.replaced > 0 ? { at: Date.now(), created: r.created, replaced: r.replaced } : null;
  addLog(r.message, 'ok');
  if (r.zip) toast(`Backed up ${r.replaced} replaced file(s) to a zip`);
  saveSites(); render();
  if (!s.domain) addLog('Enter a domain for this site, then click Publish.', 'cmd');
  else if (prefs.dropPublish && !s.watch && (r.action === 'set' || r.created + r.replaced > 0)) await publishSite(s, { source: 'drop' });
  else addLog('Ready. Click Publish when you want it live.', 'cmd');
}

/* ---------- "!" info popovers: hover or click to read ---------- */
(function setupTips() {
  const tip = $('tip');
  let pinned = null, hideT = null;
  const show = (el) => {
    clearTimeout(hideT);
    tip.textContent = el.dataset.tip || '';
    tip.classList.add('show');
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 8);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  const hide = () => { clearTimeout(hideT); tip.classList.remove('show'); pinned = null; };
  const infoOf = (e) => (e.target && e.target.closest ? e.target.closest('.info') : null);
  document.addEventListener('mouseover', (e) => { const el = infoOf(e); if (el && !pinned) show(el); });
  document.addEventListener('mouseout', (e) => { const el = infoOf(e); if (el && !pinned) hideT = setTimeout(() => tip.classList.remove('show'), 80); });
  document.addEventListener('focusin', (e) => { const el = infoOf(e); if (el && !pinned) show(el); });
  document.addEventListener('focusout', (e) => { if (infoOf(e) && !pinned) tip.classList.remove('show'); });
  document.addEventListener('click', (e) => {
    const el = infoOf(e);
    if (el) { e.preventDefault(); e.stopPropagation(); if (pinned === el) hide(); else { pinned = el; show(el); } }
    else if (pinned) hide();
  }, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();

/* ---------- startup ---------- */
window.api.onLog(({ text, kind }) => addLog(text, kind));   // command output from the main process

function init() {
  loadAll();
  loadAccounts();
  loadCats();
  initAcctBar();
  applyPrefs();
  buildCmdsPanel();

  $('add').onclick = addSite;
  $('pubAll').onclick = publishAll;
  $('addCat').append(icon('folderplus'));
  $('addCat').onclick = () => openCategoryDialog();
  $('btnPause').onclick = togglePause;
  $('btnAcct').onclick = openSwitcher;
  drawChip();
  $('btnPalette').onclick = openPalette;
  $('btnSettings').onclick = () => openSettings();
  topSeg = makeSeg($('topSeg'), setTab);
  $('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });
  $('installBtn').onclick = async () => { await run({ action: 'install' }); refreshStatus(); };

  render();
  scheduleSync();
  scheduleTray();
  restartHealthTimer();
  setTimeout(() => checkHealth(), 2500);
  setInterval(checkSchedules, 15000);
  refreshStatus();
}
init();
