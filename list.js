'use strict';
/* Left-hand site list: search, pinned / groups / archive, health dots, drag-to-reorder. */

let dragId = null, dragCat = null;
let query = '';
const renderedIds = new Set();   // rows already shown (only new rows animate in)

const collapsedGroups = () => { try { return new Set(JSON.parse(store.get('surge.gcol') || '[]')); } catch { return new Set(); } };
const saveCollapsed = (set) => store.set('surge.gcol', JSON.stringify([...set]));
const archOpen = () => store.get('surge.archOpen') === '1';

/* ---------- icons (static strings, stroke follows the text colour) ---------- */
const ICONS = {
  pin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 14v7"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  folderplus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
};
function icon(name) {
  const s = h('span', { class: 'ico' });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

function selectSite(id) {
  selId = id;
  saveSites();
  // update the highlight in place so it can animate, then redraw only the editor
  document.querySelectorAll('.site').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  renderEditor(); syncCmds(); applyBusy();
}

/* ---------- which sites are shown, and in what order ---------- */
const matches = (s, q) => !q || [s.name, s.domain, s.group].join(' ').toLowerCase().includes(q);
function orderSites(list) {   // pinned first, then ungrouped, then each group (same order the list draws)
  const rest = list.filter((s) => !s.pinned);
  const names = cats.map((c) => c.name);
  return [...list.filter((s) => s.pinned), ...rest.filter((s) => !s.group), ...names.flatMap((g) => rest.filter((s) => s.group === g))];
}
function visibleSites() {
  const q = query.trim().toLowerCase();
  return orderSites(sites.filter((s) => !s.archived && acctVisible(s) && matches(s, q)));
}
function archivedSites() {
  const q = query.trim().toLowerCase();
  return sites.filter((s) => s.archived && acctVisible(s) && matches(s, q));
}

/* ---------- pin / archive ---------- */
function togglePin(s) {
  s.pinned = !s.pinned;
  if (s.pinned) s.archived = false;
  saveSites(); render();
  toast(s.pinned ? `Pinned “${s.name}” to the top` : `Unpinned “${s.name}”`);
}
function toggleArchive(s) {
  s.archived = !s.archived;
  if (s.archived) {
    s.pinned = false; s.schedule = null;                  // a parked site should not publish by itself
    if (selId === s.id) { const f = visibleSites()[0]; if (f) selId = f.id; }
  }
  saveSites(); render();
  toast(s.archived ? `Archived “${s.name}” · find it under Archived` : `Restored “${s.name}”`);
}
function setSection(id, patch) {
  const s = sites.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch);
  if (s.archived) s.schedule = null;
  saveSites(); render();
}

/* ---------- reordering ---------- */
const sameSection = (a, b) => a.group === b.group && !!a.pinned === !!b.pinned && !!a.archived === !!b.archived;
function neighbor(id, delta) {
  const i = sites.findIndex((x) => x.id === id);
  if (i < 0) return -1;
  let j = i + delta;
  while (j >= 0 && j < sites.length && !sameSection(sites[j], sites[i])) j += delta;
  return j < 0 || j >= sites.length ? -1 : j;
}
function moveBy(id, delta) {
  const i = sites.findIndex((x) => x.id === id), j = neighbor(id, delta);
  if (i < 0 || j < 0) return;
  [sites[i], sites[j]] = [sites[j], sites[i]];
  saveSites(); render();
}
function moveSite(fromId, toId, after) {
  const from = sites.findIndex((x) => x.id === fromId);
  if (from < 0 || fromId === toId) return;
  const [item] = sites.splice(from, 1);
  let to = sites.findIndex((x) => x.id === toId);
  if (to < 0) { sites.splice(from, 0, item); return; }
  item.group = sites[to].group;           // dropping next to a site adopts its group and section
  item.pinned = !!sites[to].pinned; item.archived = !!sites[to].archived;
  if (item.archived) item.schedule = null;
  if (after) to++;
  sites.splice(to, 0, item);
  saveSites(); render();
}
function moveToGroupEnd(fromId, group) {
  const from = sites.findIndex((x) => x.id === fromId);
  if (from < 0) return;
  const [item] = sites.splice(from, 1);
  item.group = group; item.pinned = false; item.archived = false;
  let last = -1;
  sites.forEach((x, i) => { if (x.group === group) last = i; });
  sites.splice(last + 1, 0, item);
  saveSites(); render();
}
function clearMarks() {
  document.querySelectorAll('.site.drop-before, .site.drop-after, .ghead.over').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'over'));
}

function addSite(o) {   // addSite({ group }) adds into that category; as a click handler it gets an event instead
  const s = newSite();
  const c = cur();
  if (o && typeof o.group === 'string') s.group = o.group;
  else if (c && c.group) s.group = c.group;
  s.accountId = activeId();
  sites.push(s);
  selId = s.id;
  query = ''; $('search').value = '';
  saveSites(); render(); setTab('site');
  const first = document.querySelector('#editor input');
  if (first) { first.focus(); first.select(); }
}

/* ---------- section headers: o = { label, icon, toggle, drop, cat } ---------- */
function groupHead(key, count, closed, o = {}) {
  const c = o.cat;
  const lead = o.icon ? icon(o.icon) : c ? (c.emoji ? h('span', { class: 'gemoji' }, c.emoji) : h('span', { class: 'gdot' })) : null;
  const el = h('div', { class: 'ghead' + (o.icon ? ' special' : '') + (c ? ' cat' : ''), draggable: !!c, style: c && c.color ? `--cc:${c.color}` : null },
    h('span', { class: 'chev' + (closed ? ' closed' : '') }), lead, o.label || key,
    c ? h('span', { class: 'gacts' },
      h('button', { class: 'gb keep', title: 'Add a site to this category', onclick: (ev) => { ev.stopPropagation(); addSite({ group: key }); } }, icon('plus')),
      h('button', { class: 'gb keep', title: 'Category options', onclick: (ev) => { ev.stopPropagation(); showMenu(ev.currentTarget, categoryMenu(c)); } }, icon('dots'))) : null,
    h('span', { class: 'cnt' }, count));
  el.onclick = o.toggle || (() => {
    const col = collapsedGroups();
    if (col.has(key)) col.delete(key); else col.add(key);
    saveCollapsed(col); renderList();
  });
  if (c) {
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(atCursor(e), categoryMenu(c)); });
    el.addEventListener('dragstart', (e) => { dragCat = key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'cat:' + key); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { dragCat = null; el.classList.remove('dragging'); clearMarks(); });
  }
  el.addEventListener('dragover', (e) => {
    if (dragCat) { if (c && key !== dragCat) { e.preventDefault(); clearMarks(); el.classList.add('over'); } return; }
    if (!dragId) return;
    e.preventDefault(); clearMarks(); el.classList.add('over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    if (dragCat) {
      if (!c) return;
      e.preventDefault(); e.stopPropagation();
      const from = dragCat; dragCat = null; clearMarks();
      reorderCat(from, key);
      return;
    }
    if (!dragId) return;
    e.preventDefault(); e.stopPropagation();
    const from = dragId; dragId = null; clearMarks();
    if (o.drop) o.drop(from); else moveToGroupEnd(from, key);
  });
  return el;
}

// Shown inside a category that has no visible sites yet; also a drop target.
function emptyHint(c) {
  const el = h('div', { class: 'cat-empty' }, 'Drop a site here');
  el.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { if (!dragId) return; e.preventDefault(); e.stopPropagation(); const from = dragId; dragId = null; moveToGroupEnd(from, c.name); });
  el.onclick = () => addSite({ group: c.name });
  el.title = 'Click to add a site here';
  return el;
}

function siteRow(s, index) {
  const hl = health[s.domain];
  const hcls = hl ? (hl.ok ? 'ok' : 'bad') : '';
  const htitle = hl
    ? (hl.ok ? `Online · ${hl.status} · ${hl.ms} ms` : `Not reachable (${hl.status || hl.error || 'error'})`)
    : 'Status not checked yet';
  const lastTxt = s.last ? (s.last.ok ? 'Published ' + fmtAgo(s.last.at) : 'Last attempt failed ' + fmtAgo(s.last.at)) : 'Not published yet';
  const isNew = !renderedIds.has(s.id);
  renderedIds.add(s.id);
  const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };

  const buttons = s.archived
    ? [h('button', { class: 'ri keep', title: 'Restore from archive', onclick: stop(() => toggleArchive(s)) }, icon('restore'))]
    : [h('button', { class: 'ri pin keep' + (s.pinned ? ' on' : ''), title: s.pinned ? 'Unpin' : 'Pin to top', onclick: stop(() => togglePin(s)) }, icon('pin')),
      h('button', { class: 'ri keep', title: 'Archive', onclick: stop(() => toggleArchive(s)) }, icon('archive')),
      h('button', { class: 'ri go', title: 'Publish', onclick: stop(() => { selectSite(s.id); publishSite(s); }) }, icon('play'))];

  const el = h('div', {
    class: 'site' + (s.id === selId ? ' sel' : '') + (s.color ? ' colored' : '') + (isNew ? ' enter' : '') + (s.archived ? ' arch' : ''),
    'data-id': s.id, draggable: true, title: `${lastTxt} · drag to reorder · right-click for more`,
    style: [s.color ? `--sc:${s.color}` : '', isNew ? `--i:${Math.min(index, 12)}` : ''].filter(Boolean).join(';') || null,
  },
    h('div', { class: 'fill' }),
    h('span', { class: 'hdot ' + hcls, title: htitle }),
    s.emoji ? h('span', { class: 'emoji' }, s.emoji) : null,
    siteAcct(s) ? h('span', { title: acct(s.accountId).email }, avatar(acct(s.accountId), 'xs')) : null,
    h('div', { class: 'sinfo' },
      h('div', { class: 'name' }, s.name || 'Untitled'),
      h('div', { class: 'sub' }, s.domain || 'no domain', s.watch && !s.archived ? h('span', { class: 'auto' }, ' · auto') : null, s.schedule ? ' · ⏰' : null)),
    h('div', { class: 'racts' }, buttons));

  el.onclick = () => selectSite(s.id);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectSite(s.id);
    showMenu(atCursor(e), moreItems(s));
  });
  el.addEventListener('dragstart', (e) => {
    dragId = s.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', s.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearMarks(); });
  el.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearMarks();
    if (s.id !== dragId) el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const from = dragId; dragId = null; clearMarks();
    moveSite(from, s.id, after);
  });
  return el;
}

function renderList() {
  drawAcctBar(); syncCats();
  const box = $('sites');
  box.textContent = '';
  if (!sites.length && !cats.length) { box.append(h('div', { class: 'empty' }, 'No sites yet.')); return; }
  const q = query.trim().toLowerCase();
  const vis = visibleSites(), arch = archivedSites();
  const hidden = sites.filter((s) => !acctVisible(s)).length;
  const hiddenNote = hidden ? h('button', { class: 'hidden-note keep', onclick: () => { prefs.acctFilter = false; savePrefs(); render(); } },
    `${hidden} site${hidden > 1 ? 's' : ''} on other accounts hidden · Show all`) : null;

  const emptyCats = q ? [] : cats.filter((c) => !sites.some((s) => s.group === c.name));
  if (!vis.length && !arch.length && !emptyCats.length) {
    box.append(h('div', { class: 'empty' }, q ? 'No sites match your search.' : 'No sites on this account yet.',
      !q && accounts.length ? h('div', { class: 'actions', style: 'justify-content:center' }, h('button', { onclick: () => listMySites(activeId()) }, 'List my Surge sites')) : null), hiddenNote);
    return;
  }

  const col = collapsedGroups();
  let n = 0;
  const pinned = vis.filter((s) => s.pinned), rest = vis.filter((s) => !s.pinned);
  if (pinned.length) {
    const closed = col.has('__pinned') && !q;
    box.append(groupHead('__pinned', pinned.length, closed, { label: 'Pinned', icon: 'pin', drop: (id) => setSection(id, { pinned: true, archived: false }) }));
    if (!closed) pinned.forEach((s) => box.append(siteRow(s, n++)));
  }
  rest.filter((s) => !s.group).forEach((s) => box.append(siteRow(s, n++)));
  for (const c of cats) {
    const members = rest.filter((s) => s.group === c.name);
    if (!members.length && (q || sites.some((s) => s.group === c.name))) continue;   // empty ones show only when truly empty
    const closed = col.has(c.name) && !q;
    box.append(groupHead(c.name, members.length, closed, { cat: c }));
    if (!closed) box.append(h('div', { class: 'cat-body', style: c.color ? `--cc:${c.color}` : null }, members.length ? members.map((s) => siteRow(s, n++)) : emptyHint(c)));
  }
  if (arch.length) {
    const open = archOpen() || !!q;
    box.append(groupHead('__archived', arch.length, !open, {
      label: 'Archived', icon: 'archive',
      toggle: () => { store.set('surge.archOpen', open ? '0' : '1'); renderList(); },
      drop: (id) => setSection(id, { archived: true, pinned: false }),
    }));
    if (open) arch.forEach((s) => box.append(siteRow(s, n++)));
  }
  if (hiddenNote) box.append(hiddenNote);
  applyRowFill();
  applyBusy();
}
