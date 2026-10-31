'use strict';
/* Multiple Surge accounts: header switcher, add dialog, manager.
   Only email + colour live here; each token stays encrypted in the main process. */

const ACCT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#22c55e', '#ef4444', '#6366f1'];
let accounts = [];            // [{ id, email, color }]
let userOk = null, sysEmail = '';   // result of the last "whoami" for the active account

const saveAccounts = () => store.set('surge.accounts', JSON.stringify(accounts));
const acct = (id) => accounts.find((a) => a.id === id) || null;
const activeId = () => (acct(prefs.activeAccount) ? prefs.activeAccount : '');   // '' = the Surge login on this PC
const siteAcct = (s) => (acct(s.accountId) ? s.accountId : '');
const acctLabel = (a) => (a ? a.email : 'Surge login on this PC');
const acctVisible = (s) => !accounts.length || !prefs.acctFilter || siteAcct(s) === activeId();

// Which account runs a command: the site's own account, else the active one.
function acctIdFor(siteId, domain) {
  const s = sites.find((x) => (siteId ? x.id === siteId : !!domain && x.domain === domain));
  return s ? siteAcct(s) : activeId();
}

function loadAccounts() {
  try { accounts = JSON.parse(store.get('surge.accounts') || '[]').filter((a) => a && a.id && a.email); } catch { accounts = []; }
  // Earlier versions kept one token per site (keyed by the site id). Turn those into shared accounts.
  let moved = false;
  sites.forEach((s) => {
    if (!s.account) return;
    let a = accounts.find((x) => x.email.toLowerCase() === s.account.toLowerCase());
    if (!a) { a = { id: s.id, email: s.account, color: ACCT_COLORS[accounts.length % ACCT_COLORS.length] }; accounts.push(a); }
    s.accountId = a.id; s.account = ''; moved = true;
  });
  if (moved) { saveAccounts(); saveSites(); }
  // An older build could save the account filter as off after “Show all”; start with it on once.
  if (!prefs.acctV) { prefs.acctFilter = true; prefs.acctV = 1; savePrefs(); }
}

// Move a site to another account (or '' = this PC's login); leave the view if it is no longer in scope.
function moveToAccount(s, id) {
  s.accountId = id; saveSites();
  if (!acctVisible(s)) {
    const f = visibleSites()[0]; selId = f ? f.id : null; saveSites();
    toast(`Moved “${s.name}” to ${acctLabel(acct(id))} · switch to that account to see it`);
  }
  render();
}

/* ---------- sidebar scope: this account | all ---------- */
let acctSeg = null;
function initAcctBar() {
  acctSeg = makeSeg($('acctSeg'), (k) => { prefs.acctFilter = k === 'acct'; savePrefs(); render(); });
}
function drawAcctBar() {
  const bar = $('acctBar');
  bar.hidden = !accounts.length;
  if (bar.hidden || !acctSeg) return;
  const a = acct(activeId()), live = sites.filter((s) => !s.archived);
  $('segAcct').replaceChildren(avatar(a, 'xs', sysEmail), h('span', { class: 'txt' }, a ? a.email : 'This PC'),
    h('span', { class: 'cnt' }, live.filter((s) => siteAcct(s) === activeId()).length));
  $('segAll').replaceChildren('All', h('span', { class: 'cnt' }, live.length));
  acctSeg.set(prefs.acctFilter ? 'acct' : 'all', true);
  requestAnimationFrame(() => acctSeg.place(true));
}

function avatar(a, extra = '', letter = '') {
  return h('span', { class: 'av ' + extra + (a ? '' : ' sys'), style: a ? `--ac:${a.color}` : null },
    (a ? a.email : letter || '?').charAt(0).toUpperCase());
}

/* ---------- header chip ---------- */
function drawChip() {
  const a = acct(activeId());
  const av = avatar(a, 'pop', sysEmail);
  av.append(h('span', { class: 'dot ' + (userOk === null ? '' : userOk ? 'ok' : 'bad') }));
  $('btnAcct').replaceChildren(av,
    h('span', { class: 'txt' }, a ? a.email : (userOk && sysEmail ? sysEmail : 'Not signed in')), h('span', { class: 'caret' }));
}

function switchAccount(id) {
  prefs.activeAccount = id; savePrefs();
  userOk = null; sysEmail = id ? '' : sysEmail;
  if (!sites.some((s) => s.id === selId && acctVisible(s))) {
    const first = sites.find(acctVisible);
    selId = first ? first.id : null;
  }
  saveSites(); drawChip(); render();
  toast('Switched to ' + acctLabel(acct(id)));
  refreshStatus();
}

/* ---------- switcher popover (Instagram-style) ---------- */
let swEl = null;
function swOut(e) { if (swEl && !swEl.contains(e.target) && !$('btnAcct').contains(e.target)) closeSwitcher(); }
function swKey(e) { if (e.key === 'Escape' && swEl) { e.stopPropagation(); closeSwitcher(); } }
function closeSwitcher() {
  if (!swEl) return;
  const el = swEl; swEl = null;
  document.removeEventListener('mousedown', swOut, true);
  document.removeEventListener('keydown', swKey, true);
  el.classList.add('closing'); setTimeout(() => el.remove(), 130);
}
function openSwitcher() {
  if (swEl) { closeSwitcher(); return; }
  closeMenu();
  const act = activeId();
  const count = (id) => sites.filter((s) => siteAcct(s) === id).length;
  const row = (a) => {
    const id = a ? a.id : '', on = id === act, n = count(id);
    return h('button', { class: 'ac-row keep' + (on ? ' on' : ''), onclick: () => { closeSwitcher(); if (!on) switchAccount(id); } },
      avatar(a, 'lg', sysEmail),
      h('span', { class: 'ac-txt' }, h('b', {}, acctLabel(a)), h('small', {}, `${n} site${n === 1 ? '' : 's'}${on ? ' · active' : ''}`)),
      on ? h('span', { class: 'ac-check' }, '✓') : null);
  };
  const el = h('div', { class: 'menu acctpop', role: 'menu' },
    h('div', { class: 'ac-title' }, 'Accounts'),
    accounts.map(row),
    !accounts.length || act === '' || count('') ? row(null) : null,
    h('hr'),
    h('button', { class: 'keep', onclick: () => { closeSwitcher(); openAddAccount(); } }, '＋ Add account'),
    h('button', { class: 'keep', onclick: () => { closeSwitcher(); openSettings('account'); } }, 'Manage accounts…'));
  document.body.appendChild(el);
  const r = $('btnAcct').getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = r.bottom + 8 + 'px';
  swEl = el;
  setTimeout(() => { document.addEventListener('mousedown', swOut, true); document.addEventListener('keydown', swKey, true); }, 0);
}

/* ---------- add account dialog ---------- */
function openAddAccount() {
  let mode = 'pw', close = () => {};
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'off', spellcheck: 'false' });
  const pass = h('input', { type: 'password', placeholder: 'password', autocomplete: 'off' });
  const tok = h('input', { type: 'password', placeholder: 'token from “surge token”', autocomplete: 'off', spellcheck: 'false' });
  const pwBox = h('div', {}, h('label', {}, 'Password', info('Used once to sign in, then thrown away. Only Surge’s token is kept, encrypted by Windows. A new email address creates a new Surge account.')), pass);
  const tokBox = h('div', { hidden: true }, h('label', {}, 'Token', info('Run “surge token” while logged in as this account and paste the result.')), tok);
  const err = h('div', { class: 'ac-err', hidden: true });
  const btn = h('button', { class: 'primary keep' }, 'Add account');
  const seg = h('div', { class: 'seg sm', id: 'acSeg' },
    h('button', { class: 'seg-btn keep on', 'data-k': 'pw', type: 'button' }, 'Email & password'),
    h('button', { class: 'seg-btn keep', 'data-k': 'tok', type: 'button' }, 'I have a token'));
  const fail = (m) => { err.textContent = m; err.hidden = false; };

  const go = async () => {
    const em = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(em)) return fail('Enter a valid email address.');
    const old = accounts.find((a) => a.email.toLowerCase() === em.toLowerCase());
    const id = old ? old.id : uid();
    err.hidden = true; btn.disabled = true; btn.textContent = mode === 'pw' ? 'Signing in…' : 'Saving…';
    const r = mode === 'pw'
      ? await window.api.accountLogin({ id, email: em, password: pass.value })
      : await window.api.secretSet({ id, email: em, token: tok.value.trim() });
    pass.value = ''; tok.value = '';
    btn.disabled = false; btn.textContent = 'Add account';
    if (!r || r.error) return fail((r && r.error) || 'Something went wrong.');
    if (old) old.email = r.email;
    else accounts.push({ id, email: r.email, color: ACCT_COLORS[accounts.length % ACCT_COLORS.length] });
    saveAccounts(); close();
    switchAccount(id);
  };
  btn.onclick = go;
  [email, pass, tok].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));

  modal({
    title: 'Add account', buttons: [],
    content: h('div', {}, seg, h('label', { style: 'margin-top:14px' }, 'Surge email'), email,
      h('div', { style: 'margin-top:12px' }, pwBox, tokBox), err, h('div', { class: 'actions' }, btn)),
    onOpen: (box, done) => {
      close = done;
      makeSeg(box.querySelector('#acSeg'), (k) => { mode = k; pwBox.hidden = k !== 'pw'; tokBox.hidden = k !== 'tok'; err.hidden = true; });
      email.focus();
    },
  });
}

async function removeAccount(a) {
  if (!(await confirmBox('Remove account?', `${a.email} will be signed out of this app.\nYour sites on Surge are not affected.`, 'Remove', true))) return;
  await window.api.secretClear(a.id);
  accounts = accounts.filter((x) => x !== a);
  sites.forEach((s) => { if (s.accountId === a.id) s.accountId = ''; });
  if (prefs.activeAccount === a.id) prefs.activeAccount = '';
  saveAccounts(); savePrefs(); saveSites();
  if (!sites.some((s) => s.id === selId && acctVisible(s))) { const f = sites.find(acctVisible); selId = f ? f.id : null; saveSites(); }
  drawChip(); render(); refreshStatus();
  toast('Account removed');
}

/* ---------- manager (used in Settings → Account) ---------- */
function acctManager() {
  const box = h('div', { class: 'acm' });
  const draw = () => {
    const act = activeId();
    const row = (a) => {
      const id = a ? a.id : '', n = sites.filter((s) => siteAcct(s) === id).length;
      return h('div', { class: 'acm-row' + (id === act ? ' on' : '') },
        avatar(a, 'lg', sysEmail),
        h('div', { class: 'ac-txt' }, h('b', {}, acctLabel(a)), h('small', {}, `${n} site${n === 1 ? '' : 's'}${id === act ? ' · active' : ''}`)),
        a ? h('input', { type: 'color', value: a.color, title: 'Account colour', class: 'keep', oninput: (e) => { a.color = e.target.value; saveAccounts(); drawChip(); renderList(); } }) : null,
        h('button', { onclick: () => listMySites(id), title: 'Add every site on this account to the list' }, 'List sites'),
        id === act ? null : h('button', { class: 'keep', onclick: () => { switchAccount(id); draw(); } }, 'Switch'),
        a ? h('button', { class: 'danger keep', onclick: async () => { await removeAccount(a); draw(); } }, 'Remove')
          : h('button', { class: 'keep', onclick: () => run({ action: 'logout' }).then(refreshStatus) }, 'Log out'));
    };
    box.replaceChildren(
      ...accounts.map(row), row(null),
      h('div', { class: 'actions' },
        h('button', { class: 'primary keep', onclick: () => openAddAccount() }, '＋ Add account'),
        h('button', { onclick: () => listMySites() }, 'List my Surge sites'),
        info('“List my Surge sites” adds every site on the active account to your list. “List sites” on a row does it for that account. Added sites are pinned to the account so they always publish with the right login.')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!prefs.acctFilter, onchange: (e) => { prefs.acctFilter = e.target.checked; savePrefs(); render(); } }),
        'Only show the active account’s sites'));
  };
  draw();
  return box;
}
