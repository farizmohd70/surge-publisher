'use strict';
/* Categories: named, coloured sections in the site list. Stored apart from the sites so an empty one survives.
   A site's category is still its `group` string, so older data and exports keep working. */

let cats = [];   // [{ name, emoji, color, keep }]  keep = made or edited by you, so it stays when empty

const saveCats = () => store.set('surge.cats', JSON.stringify(cats));
const catOf = (name) => cats.find((c) => c.name === name) || null;
// Context-menu anchor at the mouse pointer (showMenu only needs these two methods).
const atCursor = (e) => ({ getBoundingClientRect: () => ({ right: e.clientX + 230, left: e.clientX, top: e.clientY, bottom: e.clientY }), contains: () => false });

function loadCats() {
  try {
    cats = JSON.parse(store.get('surge.cats') || '[]')
      .filter((c) => c && typeof c.name === 'string' && c.name)
      .map((c) => ({ name: c.name, emoji: String(c.emoji || ''), color: normHex(c.color) || '', keep: !!c.keep }));
  } catch { cats = []; }
}

// Every site's group is a category; groups that nobody uses and you never made disappear.
function syncCats() {
  const used = new Set(sites.map((s) => s.group).filter(Boolean));
  const n = cats.length;
  used.forEach((name) => { if (!catOf(name)) cats.push({ name, emoji: '', color: '', keep: false }); });
  cats = cats.filter((c) => c.keep || used.has(c.name));
  if (cats.length !== n) saveCats();
}

function catError(name, except) {
  if (!name) return 'Give the category a name.';
  if (name.length > 40) return 'Use 40 characters or fewer.';
  if (name.startsWith('__')) return 'That name is reserved.';
  if (cats.some((c) => c !== except && c.name.toLowerCase() === name.toLowerCase())) return 'A category with that name already exists.';
  return '';
}

function setCategory(s, name) {
  s.group = name; saveSites(); render();
  toast(name ? `Moved “${s.name}” to ${name}` : `Removed “${s.name}” from its category`);
}
function categoryItems(s) {   // menu used from a site's “Category…” entry
  return [
    ...cats.map((c) => ({ label: (c.emoji ? c.emoji + ' ' : '') + c.name + (s.group === c.name ? '  ✓' : ''), run: () => setCategory(s, c.name), off: s.group === c.name })),
    cats.length ? '-' : null,
    s.group ? { label: 'No category', run: () => setCategory(s, '') } : null,
    { label: '＋ New category…', run: () => openCategoryDialog({ assign: s.id }) },
  ].filter(Boolean);
}

function reorderCat(from, to) {
  const a = catOf(from), b = catOf(to);
  if (!a || !b || a === b) return;
  cats.splice(cats.indexOf(a), 1);
  cats.splice(cats.indexOf(b), 0, a);
  saveCats(); renderList();
}
function moveCat(name, delta) {
  const i = cats.findIndex((c) => c.name === name), j = i + delta;
  if (i < 0 || j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  saveCats(); renderList();
}
async function deleteCategory(c) {
  const n = sites.filter((s) => s.group === c.name).length;
  const msg = `“${c.name}” will be removed.\n` + (n ? `Its ${n} site${n > 1 ? 's' : ''} stay in your list, without a category.` : 'No sites are affected.');
  if (!(await confirmBox('Delete category?', msg, 'Delete', true))) return;
  sites.forEach((s) => { if (s.group === c.name) s.group = ''; });
  cats = cats.filter((x) => x !== c);
  saveCats(); saveSites(); render(); toast('Category deleted');
}
function categoryMenu(c) {
  const i = cats.indexOf(c), col = collapsedGroups();
  return [
    { label: 'Edit category…', run: () => openCategoryDialog({ edit: c }) },
    { label: 'Add a site here', run: () => addSite({ group: c.name }) },
    { label: col.has(c.name) ? 'Expand' : 'Collapse', run: () => { if (!col.delete(c.name)) col.add(c.name); saveCollapsed(col); renderList(); } },
    '-',
    { label: 'Move up', run: () => moveCat(c.name, -1), off: i <= 0 },
    { label: 'Move down', run: () => moveCat(c.name, 1), off: i >= cats.length - 1 },
    '-',
    { label: 'Delete category…', run: () => deleteCategory(c), danger: true },
  ];
}

/* ---------- create / edit dialog ---------- */
function openCategoryDialog({ edit = null, assign = null } = {}) {
  let close = () => {}, color = edit ? edit.color : '';
  const name = h('input', { value: edit ? edit.name : '', placeholder: 'e.g. Clients', maxlength: '40', spellcheck: 'false', autocomplete: 'off' });
  const emoji = h('input', { class: 'emoji-in', value: edit ? edit.emoji : '', placeholder: '🗂', maxlength: '4', autocomplete: 'off' });
  const dot = h('span', { class: 'gdot' }), pvName = h('span', {}), pvEmoji = h('span', { class: 'gemoji' });
  const preview = h('div', { class: 'cat-preview' }, dot, pvEmoji, pvName);
  const paint = () => {
    preview.style.setProperty('--cc', color || 'var(--muted)');
    pvName.textContent = name.value.trim() || 'New category';
    pvEmoji.textContent = emoji.value.trim(); pvEmoji.hidden = !emoji.value.trim(); dot.hidden = !!emoji.value.trim();
  };
  name.addEventListener('input', paint); emoji.addEventListener('input', paint);
  const picker = colorPicker({ value: color, presets: SWATCHES, allowNone: true, onChange: (v) => { color = v; paint(); } });

  // sites you can drop in: the ones in scope, plus anything already in this category
  const pool = sites.filter((s) => !s.archived && (acctVisible(s) || (edit && s.group === edit.name)));
  const checks = new Map(pool.map((s) => [s.id, h('input', { type: 'checkbox', checked: edit ? s.group === edit.name : s.id === assign })]));
  const pick = h('div', { class: 'cat-pick' }, pool.length ? pool.map((s) => h('label', { class: 'chk' }, checks.get(s.id),
    h('span', { class: 'cp-name' }, (s.emoji ? s.emoji + ' ' : '') + (s.name || 'Untitled')),
    h('small', {}, s.group && !(edit && s.group === edit.name) ? s.group : s.domain || ''))) : h('div', { class: 'empty' }, 'No sites to add yet.'));

  const err = h('div', { class: 'ac-err', hidden: true });
  const save = () => {
    const nm = name.value.trim(), e = catError(nm, edit);
    if (e) { err.textContent = e; err.hidden = false; name.focus(); return; }
    let c = edit;
    if (c) {
      if (c.name !== nm) {
        sites.forEach((s) => { if (s.group === c.name) s.group = nm; });
        const col = collapsedGroups();
        if (col.delete(c.name)) { col.add(nm); saveCollapsed(col); }
        c.name = nm;
      }
      Object.assign(c, { emoji: emoji.value.trim(), color, keep: true });
    } else { c = { name: nm, emoji: emoji.value.trim(), color, keep: true }; cats.push(c); }
    pool.forEach((s) => { if (checks.get(s.id).checked) s.group = nm; else if (s.group === nm) s.group = ''; });
    const col = collapsedGroups(); col.delete(nm); saveCollapsed(col);   // show it open
    saveCats(); saveSites(); render(); close();
    toast(edit ? 'Category saved' : `Created “${nm}”`);
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  paint();
  modal({
    title: edit ? 'Edit category' : 'New category', buttons: [],
    content: h('div', {},
      preview,
      h('div', { class: 'cat-grid' }, h('div', {}, h('label', {}, 'Name'), name), h('div', {}, h('label', {}, 'Emoji'), emoji)),
      h('label', { style: 'margin-top:14px' }, 'Colour', info('Tints the category’s header and the line beside its sites.')), picker,
      h('label', { style: 'margin-top:14px' }, 'Sites in this category', info('Tick the sites that belong here. You can also drag a site onto a category header, or use “Category…” in a site’s menu.')), pick,
      err, h('div', { class: 'actions' }, h('button', { class: 'primary keep', onclick: save }, edit ? 'Save category' : 'Create category'))),
    onOpen: (box, done) => { close = done; name.focus(); name.select(); },
  });
}
