'use strict';
/* Everything that runs commands: busy state, publish pipeline, progress bar,
   auto-publish watcher, schedules, health checks, import/export. */

let pgLabel = '', pgSiteId = null, batch = null, pg = null, pgTimer = null, pgHideTimer = null;

/* ---------- busy state & running commands ---------- */
function setBusy(v) { busy = v; $('spin').hidden = !v; applyBusy(); }
function applyBusy() {
  document.querySelectorAll('main button:not(.keep)').forEach((b) => { b.disabled = busy || b.dataset.off === '1'; });
}
async function run(payload) {
  if (busy) { addLog('Another command is still running. Wait for it to finish, or press Stop.', 'err'); return null; }
  setBusy(true);
  const res = await window.api.run({ acct: acctIdFor(payload.siteId, payload.domain), ...payload });
  if (res && res.error) addLog(res.error, 'err');
  setBusy(false);
  return res;
}

/* ---------- progress bar ---------- */
function pgDraw() {
  if (!pg) return;
  const started = pg.pct > 0;
  $('pg').classList.toggle('indet', !started && !pg.finished);
  $('pgLabel').textContent = pgLabel + (pg.finished ? (pg.ok ? ' · done' : ' · failed') : !started ? ' · preparing…' : ' · uploading');
  const shown = pg.finished && pg.ok ? 100 : pg.pct;
  $('pgFill').style.width = shown + '%';
  $('pgPct').textContent = started || pg.finished ? shown + '%' : '';
  const done = pg.total ? (pg.total * shown) / 100 : 0;
  $('pgSpeed').textContent = 'Speed: ' + (pg.speed > 0 ? fmtB(pg.speed) + '/s' : '—');
  $('pgSize').textContent = pg.total ? `${fmtB(done)} / ${fmtB(pg.total)}` : '';
  $('pgEta').textContent = !pg.finished && pg.eta != null ? `ETA ${Math.ceil(pg.eta)}s` : '';
  $('pgTime').textContent = 'Elapsed ' + fmtT((pg.end || Date.now()) - pg.t0);
  applyRowFill();
}
// low-opacity fill behind the site's row in the sidebar, following the upload percentage
function applyRowFill() {
  document.querySelectorAll('.site').forEach((row) => {
    const f = row.querySelector('.fill');
    if (!f) return;
    if (!pg || row.dataset.id !== pg.siteId) { f.className = 'fill'; f.style.width = '0%'; return; }
    const pct = pg.finished ? (pg.ok ? 100 : pg.pct) : pg.pct;
    const cls = ['fill'];
    if (pg.finished) cls.push(pg.ok ? 'ok' : 'bad'); else if (!pct) cls.push('indet');
    if (pg.fading) cls.push('fade');
    f.className = cls.join(' ');
    f.style.width = pg.finished || pct ? pct + '%' : '';
  });
}
window.api.onProgress((p) => {
  if (p.phase === 'start') {
    clearTimeout(pgHideTimer);
    pg = { siteId: pgSiteId, t0: Date.now(), pct: 0, total: p.total || 0, files: 0, speed: 0, eta: null, samples: [], finished: false };
    $('pgWrap').classList.remove('collapsed'); $('pg').className = 'pg';
    clearInterval(pgTimer); pgTimer = setInterval(pgDraw, 400);
    pgDraw();
  } else if (p.phase === 'update' && pg) {
    pg.pct = p.pct;
    if (p.bytes) pg.total = p.bytes;
    if (p.files) pg.files = p.files;
    pg.eta = p.eta;
    const d = pg.total * p.pct / 100;
    pg.samples.push({ t: p.t, d });
    pg.samples = pg.samples.filter((x) => p.t - x.t <= 4000);
    const a = pg.samples[0], b = pg.samples[pg.samples.length - 1];
    if (b.t > a.t) pg.speed = (b.d - a.d) / ((b.t - a.t) / 1000);
    pgDraw();
  } else if (p.phase === 'end' && pg) {
    clearInterval(pgTimer);
    pg.finished = true; pg.ok = p.ok; pg.end = Date.now(); pg.eta = null;
    const secs = Math.max(0.001, (pg.end - pg.t0) / 1000);
    if (p.ok && pg.total) pg.speed = pg.total / secs;   // average speed for the whole publish
    $('pg').className = 'pg ' + (p.ok ? 'done' : 'fail');
    pgDraw();
    const mine = pg;
    if (prefs.pgHide > 0) pgHideTimer = setTimeout(() => { if (pg === mine) $('pgWrap').classList.add('collapsed'); }, prefs.pgHide * 1000);
    setTimeout(() => {
      if (pg !== mine) return;
      mine.fading = true; applyRowFill();
      setTimeout(() => { if (pg === mine) { mine.siteId = null; applyRowFill(); } }, 650);
    }, 2500);
  }
});

/* ---------- publish dialog (confirmation + pre-publish checks) ---------- */
function issueList(issues, err = false) {
  return h('div', { class: 'issues' + (err ? ' err' : '') },
    h('ul', {}, issues.map((i) => h('li', {}, (i.level === 'error' ? '⛔ ' : '⚠ ') + i.msg,
      i.files ? h('div', { class: 'files' }, i.files.join('\n')) : null))));
}
function kvRow(k, v) { return [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)]; }

function publishDialog(s, chk, warns, preview) {
  const dont = h('input', { type: 'checkbox' });
  const mute = h('input', { type: 'checkbox' });
  const content = h('div', {},
    h('div', { class: 'kv' },
      kvRow('Site', (s.emoji ? s.emoji + ' ' : '') + s.name), kvRow('Domain', s.domain), kvRow('Folder', s.folder),
      chk ? kvRow('Files', `${chk.count} files · ${fmtB(chk.total)}`) : null,
      kvRow('Mode', preview ? 'Preview (the live site is not changed)' : 'Live'),
      s.build ? kvRow('Build', s.build) : null,
      excludeCount(s) ? kvRow('Excluded', `${excludeCount(s)} rule(s)`) : null,
      s.spa ? kvRow('SPA', '200.html will be added') : null,
      siteAcct(s) ? kvRow('Account', acct(s.accountId).email) : null),
    warns.length
      ? h('div', {}, h('div', { class: 'fieldnote' }, 'Check before publishing:'), issueList(warns))
      : (chk ? h('div', { class: 'allgood' }, '✓ No problems found') : null),
    prefs.confirmPublish ? h('label', { class: 'chk' }, dont, 'Don’t ask me again before publishing (you can turn it back on in Settings)') : null,
    warns.length ? h('label', { class: 'chk' }, mute, 'Don’t warn me about these again for this site') : null);

  const buttons = [{ label: 'Cancel', value: null }];
  const result = (extra) => () => ({ go: true, dontAsk: dont.checked, mute: mute.checked, ...extra });
  if (chk && chk.suggest.length && warns.some((w) => ['SECRET', 'GIT', 'NODE_MODULES'].includes(w.code))) {
    buttons.push({ label: 'Exclude them & publish', value: result({ exclude: chk.suggest }) });
  }
  buttons.push({ label: preview ? 'Publish preview' : 'Publish', primary: true, value: result({}) });
  return modal({ title: (preview ? 'Publish preview of ' : 'Publish ') + (s.name || 'site') + '?', content, buttons });
}

/* ---------- build step ---------- */
const suppressUntil = {};
async function runBuildStep(s) {
  if (busy) return false;
  const cwd = (s.buildDir || '').trim() || parentOf(s.folder);
  setBusy(true);
  suppressUntil[s.folder] = Infinity;      // ignore the folder changes the build itself makes
  const r = await window.api.build({ cmd: s.build, cwd });
  suppressUntil[s.folder] = Date.now() + (prefs.autoDelay + 3) * 1000;
  setBusy(false);
  if (r.error) addLog(r.error, 'err');
  return r.code === 0;
}

/* ---------- history ---------- */
const tail = (t, n = 2000) => { t = String(t || ''); return t.length > n ? '…' + t.slice(-n) : t; };
function recordHistory(s, e) {
  s.history.unshift({ at: Date.now(), ...e });
  if (s.history.length > 25) s.history.length = 25;
}

/* ---------- the publish pipeline ---------- */
// source: 'manual' (dialogs allowed) | 'all' | 'watch' | 'schedule' | 'drop'
async function publishSite(s, o = {}) {
  const source = o.source || 'manual';
  const quiet = source !== 'manual';
  const preview = !!o.preview;

  if (!s.folder || !s.domain) {
    addLog(`"${s.name}": choose a folder and enter a domain first.`, 'err');
    if (!quiet) { toast('Choose a folder and a domain first', 'err'); if (s.id !== selId) selectSite(s.id); }
    return false;
  }
  if (busy) { addLog('Another command is still running. Try again in a moment.', 'err'); if (!quiet) toast('Another command is still running', 'err'); return false; }

  // 1. pre-publish checks
  let chk = null;
  if (prefs.checks) {
    chk = await window.api.precheck({ folder: s.folder, exclude: s.exclude });
    const errs = chk.issues.filter((i) => i.level === 'error');
    if (errs.length) {
      addLog(`"${s.name}": ${errs.map((e) => e.msg).join(' ')}`, 'err');
      if (!quiet) await modal({ title: 'Cannot publish', content: issueList(errs, true), buttons: [{ label: 'OK', value: true, primary: true }] });
      return false;
    }
  }
  const warns = chk ? chk.issues.filter((i) => i.level === 'warn' && !s.muted.includes(i.code)) : [];

  // 2. confirmation / warnings
  if (source === 'manual' && !o.skipDialog && (prefs.confirmPublish || warns.length)) {
    const r = await publishDialog(s, chk, warns, preview);
    if (!r || !r.go) return false;
    if (r.dontAsk) { prefs.confirmPublish = false; savePrefs(); toast('Confirmation turned off (Settings → General)'); }
    if (r.mute) s.muted = [...new Set([...s.muted, ...warns.map((w) => w.code)])];
    if (r.exclude && r.exclude.length) s.exclude = (s.exclude.trim() ? s.exclude.trim() + '\n' : '') + r.exclude.join('\n');
    saveSites();
  } else if (warns.length) {
    addLog(`Warning for "${s.name}": ${warns.map((w) => w.msg).join(' ')}`, 'err');
  }

  // 3. build
  const noBuild = source === 'watch' || source === 'drop';
  if (s.build && !noBuild) {
    addLog(`--- Building "${s.name}" ---`, 'cmd');
    if (!(await runBuildStep(s))) {
      recordHistory(s, { ok: false, stage: 'build', preview, source, ms: 0, log: 'Build step failed.' });
      s.last = { ok: false, at: Date.now() };
      saveSites(); renderList(); refreshEditorSoft();
      return false;
    }
  }

  // 4. upload
  pgSiteId = s.id;
  pgLabel = s.name + (preview ? ' (preview)' : '') + (batch ? `  (${batch.i}/${batch.n})` : '');
  addLog(`--- Publishing "${s.name}"${preview ? ' (preview)' : ''} ---`, 'cmd');
  const t0 = Date.now();
  const res = await run({ action: 'publish', folder: s.folder, domain: s.domain, preview, exclude: s.exclude, spa: !!s.spa, siteId: s.id });
  if (!res) return false;
  const ok = res.code === 0;

  recordHistory(s, {
    ok, preview, source, ms: Date.now() - t0,
    bytes: pg ? pg.total : 0, files: pg ? pg.files : 0, log: tail(res.output || res.error),
  });
  if (!preview) s.last = { ok, at: Date.now() };
  if (preview && ok) {
    const urls = String(res.output || '').match(/https?:\/\/[^\s)'"]+/g) || [];
    s.lastPreview = urls.find((u) => /surge\.sh/i.test(u)) || urls[0] || '';
    if (s.lastPreview) addLog('Preview link: ' + s.lastPreview, 'ok');
  }
  saveSites(); renderList(); refreshEditorSoft();

  if (ok && !preview) setTimeout(() => checkHealth([s.domain]), 4000);
  if (ok && !preview && prefs.openAfter && source === 'manual') window.api.openUrl('https://' + s.domain);
  if (document.hidden && prefs.notify) {
    window.api.notify(ok ? 'Published' : 'Publish failed', `${s.name}: ${ok ? (preview ? 'preview ready' : 'live at ' + s.domain) : 'see the app for details'}`);
  }
  return ok;
}

async function publishAll() {
  const todo = sites.filter((s) => s.folder && s.domain && !s.archived && acctVisible(s));   // what the list shows, minus archived
  if (!todo.length) { toast('Nothing to publish: add folders and domains first', 'err'); return; }
  if (prefs.confirmPublish && !document.hidden) {
    const ok = await confirmBox(`Publish ${todo.length} site${todo.length > 1 ? 's' : ''}?`,
      todo.map((s) => `• ${s.name} → ${s.domain}`).join('\n'), 'Publish all');
    if (!ok) return;
  }
  let okCount = 0;
  for (let i = 0; i < todo.length; i++) {
    batch = { i: i + 1, n: todo.length };
    if (await publishSite(todo[i], { source: 'all' })) okCount++;
  }
  batch = null;
  addLog(`Publish all finished: ${okCount}/${todo.length} succeeded.`, okCount === todo.length ? 'ok' : 'err');
}

/* ---------- auto-publish (folder watcher) ---------- */
let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const folders = [...new Set(sites.filter((s) => s.watch && s.folder && !s.archived).map((s) => s.folder))];
    window.api.watchSync(folders);
  }, 1500);
}
const pending = {};
window.api.onChange((folder) => {
  if ((suppressUntil[folder] || 0) > Date.now()) return;
  sites.filter((s) => s.watch && s.folder === folder && !s.archived).forEach((s) => {
    if (prefs.paused) return;
    if (!pending[s.id]) addLog(`Change detected in "${s.name}". Publishing in ${prefs.autoDelay}s…`, 'cmd');
    clearTimeout(pending[s.id]);
    pending[s.id] = setTimeout(() => autoPublish(s.id), prefs.autoDelay * 1000);
  });
});
function autoPublish(id) {
  const s = sites.find((x) => x.id === id);
  if (!s || !s.watch || prefs.paused) { delete pending[id]; return; }
  if (busy) { pending[id] = setTimeout(() => autoPublish(id), 2000); return; }
  delete pending[id];
  publishSite(s, { source: 'watch' });
}
function updatePauseButton() {
  const b = $('btnPause');
  b.textContent = 'Auto-publish: ' + (prefs.paused ? 'paused' : 'on');
  b.classList.toggle('paused', !!prefs.paused);
}
function setPaused(v) {
  prefs.paused = !!v; savePrefs(); updatePauseButton(); scheduleTray();
  if (v) Object.keys(pending).forEach((k) => { clearTimeout(pending[k]); delete pending[k]; });
  addLog(v ? 'Auto-publish paused.' : 'Auto-publish resumed.', 'cmd');
}
const togglePause = () => setPaused(!prefs.paused);

/* ---------- scheduled publishes ---------- */
function checkSchedules() {
  if (busy) return;
  const now = Date.now();
  const s = sites.find((x) => x.schedule && !x.archived && x.schedule.at <= now);
  if (!s) return;
  const late = now - s.schedule.at > 2 * 60 * 1000;
  s.schedule = null;
  saveSites(); renderList(); refreshEditorSoft();
  addLog(late ? `Missed schedule for "${s.name}" (the app was closed); publishing now.` : `Scheduled publish for "${s.name}" is due.`, 'cmd');
  publishSite(s, { source: 'schedule' });
}

/* ---------- site health ---------- */
async function checkHealth(domains) {
  const list = domains || [...new Set(sites.filter((s) => !s.archived).map((s) => s.domain).filter(Boolean))];
  if (!list.length) return;
  let res = [];
  try { res = await window.api.ping(list); } catch { return; }
  const now = Date.now();
  res.forEach((r) => { health[r.domain] = { ...r, at: now }; });
  renderList();
  updateLast();
}
let healthTimer = null;
function restartHealthTimer() {
  clearInterval(healthTimer);
  if (prefs.healthMinutes > 0) healthTimer = setInterval(() => checkHealth(), prefs.healthMinutes * 60000);
}

/* ---------- tray ---------- */
let trayTimer = null;
function scheduleTray() {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => {
    window.api.trayUpdate({ sites: sites.filter((s) => !s.archived).map((s) => ({ id: s.id, name: (s.emoji ? s.emoji + ' ' : '') + s.name })), paused: prefs.paused });
  }, 500);
}

/* ---------- Surge account: status, list, import from list ---------- */
async function refreshStatus() {
  const c = await run({ action: 'check' });
  const ok = c && c.code === 0;
  $('dotCli').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('txtCli').textContent = ok ? 'Surge ' + c.output.split('\n').pop() : 'Surge not installed';
  $('setup').hidden = ok;
  if (!ok) { $('setup').open = true; return; }
  const w = await run({ action: 'whoami' });
  const text = w && w.output ? w.output.split('\n').pop().trim() : '';
  const signed = w && w.code === 0 && /@/.test(text);
  userOk = signed; sysEmail = signed ? text : sysEmail;
  drawChip();
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
function importSitesFromList(output, accountId = activeId()) {
  const seen = new Set(sites.map((s) => (s.domain || '').toLowerCase()));
  const added = [];
  for (const line of String(output || '').split('\n')) {
    const tok = line.trim().split(/\s+/)[0] || '';
    const d = tok.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!DOMAIN_RE.test(d) || seen.has(d)) continue;
    seen.add(d); added.push(d);
    sites.push(newSite({ name: d.split('.')[0], domain: d, accountId }));
  }
  if (added.length) {
    if (!selId) selId = sites[0].id;
    saveSites(); render();
    addLog(`Added ${added.length} site${added.length > 1 ? 's' : ''} from your Surge account: ${added.join(', ')}. Choose a folder for each before publishing.`, 'ok');
    toast(`Added ${added.length} site${added.length > 1 ? 's' : ''} from your account`);
  } else {
    addLog('No new sites to add: everything on your account is already in the list.', 'cmd');
  }
}
async function listMySites(id = activeId()) {
  const res = await run({ action: 'list', acct: id });   // explicit acct wins over the active account
  if (res && res.code === 0) {
    importSitesFromList(res.output, id);
    if (id !== activeId() && prefs.acctFilter) addLog(`Switch to ${acctLabel(acct(id))} to see its sites (the list only shows the active account).`, 'cmd');
  }
}

/* ---------- import / export of the site list ---------- */
async function exportSites() {
  const data = {
    app: 'surge-publisher', version: 2, exportedAt: new Date().toISOString(),
    categories: cats.map(({ name, emoji, color }) => ({ name, emoji, color })),
    sites: sites.map((s) => ({ ...s, history: [], undo: null, last: null, lastPreview: '', accountId: '' })),
  };
  const r = await window.api.exportJson({ name: 'surge-sites.json', text: JSON.stringify(data, null, 2) });
  if (r.path) toast('Exported to ' + r.path);
}
const IMPORT_FIELDS = ['name', 'folder', 'domain', 'emoji', 'group', 'exclude', 'build', 'buildDir'];
async function importSites() {
  const r = await window.api.importJson();
  if (r.canceled) return;
  if (r.error) { toast(r.error, 'err'); return; }
  let data;
  try { data = JSON.parse(r.text); } catch { toast('That file is not valid JSON.', 'err'); return; }
  const incoming = Array.isArray(data) ? data : data && Array.isArray(data.sites) ? data.sites : null;
  if (!incoming) { toast('No sites found in that file.', 'err'); return; }
  const seen = new Set(sites.map((s) => (s.domain || '').toLowerCase()).filter(Boolean));
  let added = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const d = String(raw.domain || '').toLowerCase();
    if (d && seen.has(d)) continue;
    const s = newSite();
    IMPORT_FIELDS.forEach((k) => { if (typeof raw[k] === 'string') s[k] = raw[k].slice(0, 2000); });
    s.domain = d; s.watch = !!raw.watch; s.spa = !!raw.spa; s.pinned = !!raw.pinned && !raw.archived; s.archived = !!raw.archived;
    if (/^#[0-9a-f]{6}$/i.test(raw.color || '')) s.color = raw.color;
    if (d) seen.add(d);
    sites.push(s); added++;
  }
  if (Array.isArray(data.categories)) {
    data.categories.forEach((c) => {
      if (c && typeof c.name === 'string' && c.name && c.name.length <= 40 && !c.name.startsWith('__') && !cats.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) {
        cats.push({ name: c.name, emoji: String(c.emoji || '').slice(0, 4), color: normHex(c.color) || '', keep: true });
      }
    });
    saveCats();
  }
  if (!selId && sites[0]) selId = sites[0].id;
  saveSites(); render();
  toast(added ? `Imported ${added} site${added > 1 ? 's' : ''}` : 'Nothing new to import');
}
