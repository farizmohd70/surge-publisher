'use strict';
/* The selected site's panel: header, actions, and Settings / Advanced / History tabs. */

const SWATCHES = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
let editorTab = 'settings';
const excludeCount = (s) => String(s.exclude || '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
const pad2 = (n) => String(n).padStart(2, '0');
const toLocalInput = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/* ---------- small building blocks ---------- */
function fbox(label, value, placeholder, onInput, opts = {}) {
  const input = h('input', {
    value: value || '', placeholder, list: opts.list || null, class: opts.cls || null, maxlength: opts.max || null, spellcheck: 'false',
    oninput: () => onInput(input.value.trim()),
  });
  return h('div', { class: 'fbox' },
    h('label', {}, label, opts.note ? info(opts.note) : null),
    opts.browse
      ? h('div', { class: 'row' }, input, h('button', { class: 'keep', onclick: async () => { const p = await window.api.pickFolder(); if (p) { input.value = p; onInput(p); } } }, 'Browse'))
      : input);
}

// A compact row: title and a short summary on the right; click to expand the full options below.
function expander(key, title, note, fillSummary, bodyEl) {
  const k = 'surge.open.' + key;
  let open = store.get(k) === '1';
  const chev = h('span', { class: 'chev' + (open ? ' open' : '') });
  const sum = h('span', { class: 'xsum' });
  const head = h('div', { class: 'xhead', tabIndex: 0, role: 'button', 'aria-expanded': String(open) },
    h('span', { class: 'xtitle' }, title, note ? info(note) : null), sum, chev);
  const wrap = h('div', { class: 'xwrap' + (open ? ' open' : '') }, head, h('div', { class: 'xbody' }, h('div', { class: 'xin' }, bodyEl)));
  const refresh = () => { sum.textContent = ''; fillSummary(sum); };
  const toggle = (ev) => {
    if (ev && ev.target && ev.target.closest && ev.target.closest('.info')) return;
    open = !open;
    store.set(k, open ? '1' : '0');
    wrap.classList.toggle('open', open);
    chev.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  refresh();
  return { el: wrap, refresh };
}
const switchRow = (label, checked, onChange, note) => {
  const cb = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onChange(cb.checked) });
  return h('label', { class: 'chk' }, cb, label, note ? info(note) : null);
};

/* ---------- header (name, domain, status chips) ---------- */
function liveHeader(s) {
  const root = $('editor');
  const nm = root.querySelector('.sname'); if (nm) nm.textContent = s.name || 'Untitled';
  const av = root.querySelector('.savatar'); if (av) av.textContent = s.emoji || (s.name || '?').slice(0, 1).toUpperCase();
  const lk = root.querySelector('.slink'); if (lk) { lk.textContent = (s.domain || '') + ' ↗'; lk.hidden = !s.domain; }
  const dm = root.querySelector('.sdim'); if (dm) dm.hidden = !!s.domain;
}
function headerEl(s) {
  return h('div', { class: 'shead' },
    h('div', { class: 'stitle' },
      h('span', { class: 'savatar', style: s.color ? `--c:${s.color}` : null }, s.emoji || (s.name || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'snames' },
        h('div', { class: 'sname' }, s.name || 'Untitled'),
        h('button', { class: 'slink keep', hidden: !s.domain, title: 'Open the live site', onclick: () => cur() && cur().domain && window.api.openUrl('https://' + cur().domain) }, (s.domain || '') + ' ↗'),
        h('span', { class: 'sdim', hidden: !!s.domain }, 'No domain yet'))),
    h('div', { class: 'chips', id: 'last' }));
}
function chip(cls, text, o = {}) {
  return h('button', { class: `chip keep ${cls}${o.onclick ? ' click' : ''}`, title: o.title || null, onclick: o.onclick || null, tabIndex: o.onclick ? 0 : -1 },
    o.dot === false ? null : h('span', { class: 'cd' }), text);
}
function fillChips(el, s) {
  el.textContent = '';
  const hl = health[s.domain];
  if (s.domain) {
    el.append(hl
      ? chip(hl.ok ? 'ok' : 'bad', hl.ok ? `Online · ${hl.ms} ms` : 'Not reachable', { title: `${hl.ok ? 'Status ' + hl.status : hl.status || hl.error} · checked ${fmtAgo(hl.at)} · click to check again`, onclick: () => checkHealth([s.domain]) })
      : chip('', 'Check status', { title: 'Check whether the site is online', onclick: () => checkHealth([s.domain]) }));
  }
  el.append(s.last
    ? chip(s.last.ok ? 'ok' : 'bad', (s.last.ok ? 'Published ' : 'Failed ') + fmtAgo(s.last.at), { title: fmtDT(s.last.at), dot: false })
    : chip('', 'Not published yet', { dot: false }));
  if (s.watch) el.append(chip(prefs.paused ? 'warn' : 'accent', prefs.paused ? 'Auto paused' : 'Auto-publish', { dot: false }));
  if (s.schedule) el.append(chip('', '⏰ ' + fmtDT(s.schedule.at), { dot: false, title: 'Scheduled publish' }));
  if (s.lastPreview) el.append(chip('', 'Preview link ⧉', { dot: false, title: 'Copy the last preview link', onclick: () => { window.api.copy(s.lastPreview); toast('Preview link copied'); } }));
}
function updateLast() { const el = $('last'), s = cur(); if (el && s) fillChips(el, s); }

/* ---------- actions ---------- */
function copyLink(s) {
  if (!s.domain) { toast('Enter a domain first', 'err'); return; }
  window.api.copy('https://' + s.domain);
  toast('Link copied');
}
async function localPreview(s) {
  if (!s.folder) { toast('Choose a folder first', 'err'); return; }
  const r = await window.api.previewStart({ folder: s.folder, spa: s.spa });
  if (r.error) { toast(r.error, 'err'); return; }
  window.api.openUrl(r.url);
  toast('Local preview: ' + r.url);
}
async function showQR(s) {
  if (!s.domain) { toast('Enter a domain first', 'err'); return; }
  const url = 'https://' + s.domain;
  const canvas = h('canvas', { class: 'qr' });
  try { QR.draw(canvas, url, 8, 3); } catch (e) { toast(e.message, 'err'); return; }
  await modal({
    title: 'QR code · ' + (s.name || s.domain),
    content: h('div', { class: 'qrbox' }, canvas, h('div', { class: 'qrurl' }, url),
      h('div', { class: 'actions', style: 'justify-content:center;margin-top:6px' },
        h('button', { onclick: () => { window.api.copy(url); toast('Link copied'); } }, 'Copy link'),
        h('button', {
          onclick: async () => {
            const r = await window.api.savePng({ name: s.domain + '-qr.png', dataUrl: canvas.toDataURL('image/png') });
            if (r.path) toast('Saved ' + r.path); else if (r.error) toast(r.error, 'err');
          },
        }, 'Save PNG'))),
  });
}
async function takeOffline(s) {
  if (!s.domain) return;
  if (!(await confirmBox('Take site offline?', `${s.domain} will be removed from Surge.\nYour saved settings stay in this app.`, 'Take offline', true))) return;
  const r = await run({ action: 'teardown', domain: s.domain, siteId: s.id });
  if (r && r.code === 0) { s.last = null; saveSites(); render(); checkHealth([s.domain]); }
}
async function deleteSite(s) {
  if (!(await confirmBox('Delete from app?', `"${s.name}" will be removed from this app.\nThe live site is not affected.`, 'Delete', true))) return;
  sites = sites.filter((x) => x.id !== s.id);
  selId = sites[0] ? sites[0].id : null;
  saveSites(); render();
}
function moreItems(s) {
  return [
    { label: 'Open site', run: () => s.domain && window.api.openUrl('https://' + s.domain) },
    { label: 'Copy link', run: () => copyLink(s) },
    { label: 'Show QR code', run: () => showQR(s) },
    '-',
    { label: 'Local preview', run: () => localPreview(s) },
    { label: 'Open folder', run: () => window.api.openPath(s.folder) },
    s.lastPreview ? { label: 'Open preview link', run: () => window.api.openUrl(s.lastPreview) } : null,
    '-',
    { label: 'Category…', run: () => showMenu(menuAnchor, categoryItems(s)) },
    { label: s.pinned ? 'Unpin' : 'Pin to top', run: () => togglePin(s), off: !!s.archived },
    { label: s.archived ? 'Restore from archive' : 'Archive', run: () => toggleArchive(s) },
    ...accounts.filter((a) => a.id !== siteAcct(s)).map((a) => ({ label: 'Move to ' + a.email, run: () => moveToAccount(s, a.id) })),
    accounts.length && siteAcct(s) ? { label: 'Move to ' + acctLabel(null), run: () => moveToAccount(s, '') } : null,
    '-',
    { label: 'Move up', run: () => moveBy(s.id, -1), off: neighbor(s.id, -1) < 0 },
    { label: 'Move down', run: () => moveBy(s.id, 1), off: neighbor(s.id, 1) < 0 },
    '-',
    { label: 'Take offline…', run: () => takeOffline(s), danger: true },
    { label: 'Delete from app…', run: () => deleteSite(s), danger: true },
  ].filter(Boolean);
}
function actionRow(s) {
  return h('div', { class: 'acts' },
    h('button', { class: 'primary big', title: 'Publish (Ctrl+P)', onclick: () => publishSite(s) }, 'Publish'),
    h('button', { title: 'Upload a preview URL without changing the live site', onclick: () => publishSite(s, { preview: true }) }, 'Preview'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'keep ibtn' + (s.pinned ? ' on' : ''), title: s.pinned ? 'Unpin' : 'Pin to top', disabled: !!s.archived, onclick: () => togglePin(s) }, icon('pin')),
    h('button', { class: 'keep ibtn', title: s.archived ? 'Restore from archive' : 'Archive', onclick: () => toggleArchive(s) }, icon(s.archived ? 'restore' : 'archive')),
    h('button', { class: 'keep', title: 'More actions', onclick: (e) => showMenu(e.currentTarget, moreItems(s)) }, 'More ▾'));
}

/* ---------- Settings tab ---------- */
function settingsPane(s) {
  let persona = null;
  const refreshPersona = () => { if (persona) persona.refresh(); };

  const groupBox = h('div', { class: 'fbox' },
    h('label', {}, 'Category', info('Sites in the same category are listed together under a collapsible header. Create and edit categories with the folder button above the site list.')),
    h('select', {
      onchange: (ev) => {
        if (ev.target.value === '__new') { ev.target.value = s.group || ''; openCategoryDialog({ assign: s.id }); return; }
        s.group = ev.target.value; saveSites(); renderList(); refreshPersona();
      },
    }, h('option', { value: '' }, 'No category'),
    cats.map((c) => h('option', { value: c.name, selected: s.group === c.name }, (c.emoji ? c.emoji + ' ' : '') + c.name)),
    h('option', { value: '__new' }, '＋ New category…')));
  const emojiBox = fbox('Emoji', s.emoji, '', (v) => { s.emoji = v; saveSites(); renderList(); liveHeader(s); refreshPersona(); }, { cls: 'emoji-in', max: 4 });
  const colourBox = h('div', { class: 'fbox' },
    h('label', {}, 'Colour tag', info('Adds a coloured stripe to this site in the list. Pick a swatch, use the colour selector, or type a hex code.')),
    colorPicker({
      value: s.color, presets: SWATCHES, allowNone: true,
      onChange: (v) => {
        s.color = v; saveSites(); renderList(); refreshPersona();
        const av = $('editor').querySelector('.savatar');
        if (av) { if (v) av.style.setProperty('--c', v); else av.style.removeProperty('--c'); }
      },
    }));

  persona = expander('persona', 'Personalise', 'Optional: an emoji, a group and a colour tag make this site easier to spot in the list.',
    (el) => {
      if (s.emoji) el.append(h('span', {}, s.emoji));
      if (s.color) el.append(h('span', { class: 'cdot', style: `--c:${s.color}` }));
      if (s.group) el.append(h('span', {}, s.group));
      if (!s.emoji && !s.color && !s.group) el.append(h('span', {}, 'Emoji · group · colour'));
    },
    h('div', {}, h('div', { class: 'fgrid g-ne' }, groupBox, emojiBox), colourBox));

  return h('div', { class: 'pane' },
    h('div', { class: 'fgrid' },
      fbox('Name', s.name, 'My portfolio', (v) => { s.name = v; saveSites(); renderList(); liveHeader(s); }, { note: 'Just a label for you. It is not published anywhere.' }),
      fbox('Domain', s.domain, 'example.surge.sh', (v) => { s.domain = v.toLowerCase(); saveSites(); renderList(); liveHeader(s); updateLast(); },
        { note: 'Any new name ending in .surge.sh is created the first time you publish. Use your own domain (mysite.com) if its DNS points to Surge.' })),
    fbox('Folder to publish', s.folder, 'C:\\sites\\portfolio\\dist', (v) => { s.folder = v; saveSites(); renderList(); },
      { browse: true, note: 'The folder that contains your index.html. Everything inside it is uploaded (except files you exclude in Advanced).' }),
    persona.el,
    switchRow('Auto-publish when files in this folder change', s.watch, (v) => {
      s.watch = v; saveSites(); renderList(); updateLast();
      addLog(v ? `Watching "${s.name}": changes publish automatically while the app is open or in the tray.` : `Stopped watching "${s.name}".`, 'cmd');
    }, `Publishes ${prefs.autoDelay} seconds after your last change and skips the build step. You can change the delay in Settings → General.`),
    h('div', { class: 'dropzone' }, 'Drop files or a folder anywhere on this window',
      info('Files are copied into this site’s folder. If a file already exists, the old version is saved to a zip first. Turn on “Publish automatically after dropping” in Settings → General.')));
}

/* ---------- Advanced tab ---------- */
async function create404(s) {
  const r = await window.api.create404(s.folder);
  if (r.error) toast(r.error, 'err');
  else if (r.exists) toast('404.html already exists in that folder');
  else toast('Created 404.html');
}
async function undoDrop(s) {
  if (!(await confirmBox('Undo last drop?', 'New files from the last drop will be removed and replaced files restored.', 'Undo drop', true))) return;
  const r = await window.api.undoDrop({ id: s.id, name: s.name, folder: s.folder });
  if (r.error) { toast(r.error, 'err'); return; }
  s.undo = null; saveSites(); render();
  addLog(`Undo complete: removed ${r.removed} new file(s), restored ${r.restored} replaced file(s).`, 'ok');
}

function advancedPane(s) {
  const sx = {};
  const row = (key, title, note, summary, ...els) => {
    const x = expander('adv.' + key, title, note, (el) => el.append(h('span', {}, summary())), h('div', {}, ...els));
    sx[key] = x.refresh;
    return x.el;
  };
  const dt = h('input', { type: 'datetime-local', value: s.schedule ? toLocalInput(s.schedule.at) : '' });
  const n = () => excludeCount(s);

  return h('div', { class: 'pane' },
    row('exclude', 'Exclude files', 'One pattern per line: *.psd (any .psd file), drafts/ (a folder), /notes.txt (only in the root). Excluded files are left out of the upload; your folder is not changed.',
      () => (n() ? `${n()} rule${n() > 1 ? 's' : ''}` : 'None'),
      h('textarea', { rows: '4', spellcheck: 'false', placeholder: '*.psd\ndrafts/\n.env', value: s.exclude || '', oninput: (ev) => { s.exclude = ev.target.value; saveSites(); sx.exclude(); } })),

    row('build', 'Build step', 'Runs before Publish, Publish all and scheduled publishes, for example “npm run build”. Auto-publish does not run it. Leave the folder empty to use the folder above your publish folder.',
      () => s.build || 'None',
      fbox('Command', s.build, 'npm run build', (v) => { s.build = v; saveSites(); sx.build(); }),
      fbox('Run it in', s.buildDir, s.folder ? parentOf(s.folder) : 'your project folder', (v) => { s.buildDir = v; saveSites(); }, { browse: true })),

    row('spa', 'Single-page app', 'Adds 200.html when publishing so every route loads index.html. The 404 button creates a simple 404.html in your folder if you don’t have one.',
      () => (s.spa ? 'On' : 'Off'),
      switchRow('Add 200.html when publishing', s.spa, (v) => { s.spa = v; saveSites(); sx.spa(); }),
      h('div', { class: 'actions' }, h('button', { class: 'keep', onclick: () => create404(s) }, 'Create 404.html'))),

    row('schedule', 'Schedule', 'One-time publish at the time you choose. The app must be open or in the tray at that time.',
      () => (s.schedule ? fmtDT(s.schedule.at) : 'Not scheduled'),
      h('div', { class: 'row' }, dt,
        h('button', {
          class: 'keep', onclick: () => {
            const t = new Date(dt.value).getTime();
            if (!dt.value || isNaN(t) || t <= Date.now()) { toast('Pick a time in the future', 'err'); return; }
            s.schedule = { at: t }; saveSites(); renderList(); renderEditor(); toast('Scheduled for ' + fmtDT(t));
          },
        }, 'Schedule'),
        s.schedule ? h('button', { class: 'keep', onclick: () => { s.schedule = null; saveSites(); renderList(); renderEditor(); } }, 'Cancel') : null)),

    row('account', 'Account', 'The Surge login that publishes this site. A domain belongs to the account that first published it. Add and manage accounts from the account button at the top.',
      () => acctLabel(acct(s.accountId)),
      h('div', { class: 'row' },
        h('select', {
          onchange: (ev) => moveToAccount(s, ev.target.value),
        }, h('option', { value: '', selected: !siteAcct(s) }, acctLabel(null)),
        accounts.map((a) => h('option', { value: a.id, selected: siteAcct(s) === a.id }, a.email))),
        h('button', { class: 'keep', onclick: () => openAddAccount() }, '＋ Add'))),

    row('backups', 'Backups', 'When a dropped file replaces an existing one, the old version is saved in a zip named with the date and time.',
      () => (s.undo ? 'Undo available' : 'Zip on replace'),
      h('div', { class: 'actions', style: 'margin-top:0' },
        h('button', { class: 'keep', onclick: () => window.api.openBackups(s.name) }, 'Open backups folder'),
        s.undo ? h('button', { class: 'keep', onclick: () => undoDrop(s) }, `Undo last drop (${s.undo.created} new, ${s.undo.replaced} replaced)`) : null)));
}

/* ---------- History tab ---------- */
const SOURCE_LABEL = { watch: 'auto', schedule: 'scheduled', all: 'publish all', drop: 'after drop' };
function viewLog(e) {
  return modal({ title: 'Publish log · ' + fmtDT(e.at), wide: true, content: h('pre', { class: 'logview' }, e.log || '(no output was saved)') });
}
async function revisionCmd(sub, s) {
  if (!s.domain) { toast('Enter a domain first', 'err'); return; }
  if (sub === 'rollback' && !(await confirmBox('Roll back?', `Make the previous revision of ${s.domain} live again?`, 'Roll back'))) return;
  const r = await run({ action: 'cmd', sub, domain: s.domain, args: '', siteId: s.id });
  if (r && r.code === 0 && sub !== 'list') { toast(sub === 'rollback' ? 'Rolled back' : 'Rolled forward'); setTimeout(() => checkHealth([s.domain]), 3000); }
}
function historyPane(s) {
  const p = h('div', { class: 'pane' });
  p.append(h('div', { class: 'row' },
    h('button', { title: 'Make the previous revision live again', onclick: () => revisionCmd('rollback', s) }, 'Roll back'),
    h('button', { onclick: () => revisionCmd('rollfore', s) }, 'Roll forward'),
    h('button', { onclick: () => revisionCmd('list', s) }, 'Show revisions'),
    info('Roll back / forward use Surge’s own revisions of this domain. Some of these may need a Surge plan.'),
    h('span', { class: 'spacer' }),
    s.history.length ? h('button', { class: 'danger', onclick: () => { s.history = []; saveSites(); renderEditor(); } }, 'Clear') : null));
  if (!s.history.length) { p.append(h('div', { class: 'empty' }, 'No publishes recorded yet.')); return p; }
  p.append(h('div', { class: 'hist' }, s.history.map((e, i) => h('div', { class: 'hrow' + (e.ok ? '' : ' bad'), style: `--i:${Math.min(i, 10)}` },
    h('span', { class: 'st' }),
    h('div', { class: 'grow' },
      fmtDT(e.at) + ' · ' + (e.ok ? 'Published' : e.stage === 'build' ? 'Build failed' : 'Failed') + ' ',
      e.preview ? h('span', { class: 'tagp' }, 'preview') : null, ' ',
      SOURCE_LABEL[e.source] ? h('span', { class: 'tagp' }, SOURCE_LABEL[e.source]) : null,
      h('span', { class: 'meta' }, ` ${(e.ms / 1000).toFixed(1)}s${e.bytes ? ' · ' + fmtB(e.bytes) : ''}${e.files ? ' · ' + e.files + ' files' : ''}`)),
    h('button', { class: 'sm keep', onclick: () => viewLog(e) }, 'Log')))));
  return p;
}

/* ---------- assemble ---------- */
function renderEditor() {
  const box = $('editor');
  const s = cur();
  const changed = box.dataset.sid !== (s ? s.id : '');
  box.dataset.sid = s ? s.id : '';
  box.textContent = '';
  if (!s) {
    box.append(h('div', { class: 'none' },
      h('div', { class: 'none-t' }, 'No site selected'),
      h('div', {}, 'Add a site to start publishing.'),
      h('button', { class: 'primary', onclick: addSite }, '+ Add site')));
    return;
  }

  const head = headerEl(s), acts = actionRow(s);
  const host = h('div', { class: 'panehost' });
  const draw = (animate) => {
    host.textContent = '';
    const pane = editorTab === 'advanced' ? advancedPane(s) : editorTab === 'history' ? historyPane(s) : settingsPane(s);
    if (!animate) pane.classList.add('noanim');
    host.append(pane);
    applyBusy();
  };
  const seg = h('div', { class: 'seg sm' },
    h('button', { class: 'seg-btn keep' + (editorTab === 'settings' ? ' on' : ''), 'data-k': 'settings' }, 'Settings'),
    h('button', { class: 'seg-btn keep' + (editorTab === 'advanced' ? ' on' : ''), 'data-k': 'advanced' }, 'Advanced'),
    h('button', { class: 'seg-btn keep' + (editorTab === 'history' ? ' on' : ''), 'data-k': 'history' }, 'History', s.history.length ? h('span', { class: 'cnt' }, s.history.length) : null));
  const banner = s.archived ? h('div', { class: 'arch-banner' }, icon('archive'),
    h('span', {}, 'Archived: skipped by Publish all, auto-publish and schedules.'),
    h('button', { class: 'keep', onclick: () => toggleArchive(s) }, 'Restore')) : null;
  box.append(head, banner, acts, seg, host);
  makeSeg(seg, (k) => { editorTab = k; draw(true); });
  draw(changed);
  if (changed) { head.classList.add('enter'); acts.classList.add('enter'); }
  updateLast();
  applyBusy();
}

// Re-render after a background publish without stealing focus from a field being edited
function refreshEditorSoft() {
  const ed = $('editor'), ae = document.activeElement;
  if (ae && ed.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) updateLast();
  else renderEditor();
}
