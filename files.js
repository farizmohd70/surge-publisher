const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('./zip');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const safeName = (s) => (String(s || 'site').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'site');

/* ---------- exclude rules (a small gitignore-style matcher) ---------- */
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

function makeMatcher(text) {
  const rules = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const re = new RegExp(anchored ? '^' + globToRe(line) + '$' : '(?:^|/)' + globToRe(line) + '$', 'i');
    rules.push({ neg, dirOnly, re });
  }
  const fn = (rel, isDir) => {
    let ex = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ex = !r.neg;
    }
    return ex;
  };
  fn.empty = rules.length === 0;
  return fn;
}

/* ---------- scanning ---------- */
function scan(root, matcher, cap = 50000) {
  const files = [], dirs = [];
  let total = 0, truncated = false;
  const stack = [['', root]];
  while (stack.length) {
    const [rel, abs] = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (matcher(r, true)) continue;
        dirs.push(r); stack.push([r, p]);
      } else if (e.isFile()) {
        if (matcher(r, false)) continue;
        let size = 0;
        try { size = fs.statSync(p).size; } catch {}
        files.push({ rel: r, abs: p, size });
        total += size;
        if (files.length >= cap) { truncated = true; return { files, dirs, total, truncated }; }
      }
    }
  }
  return { files, dirs, total, truncated };
}

/* ---------- pre-publish checks ---------- */
const SECRET_RES = [
  /^\.env(\..*)?$/i, /\.(pem|key|pfx|p12)$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.npmrc$/i, /^\.htpasswd$/i, /^credentials.*\.json$/i, /^service-account.*\.json$/i, /^secrets?\./i,
];
const MB = 1024 * 1024;

function precheck(root, excludeText) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { issues: [{ level: 'error', code: 'NO_FOLDER', msg: 'The folder does not exist.' }], count: 0, total: 0, suggest: [] };
  }
  const m = makeMatcher(excludeText);
  const sc = scan(root, m);
  const issues = [];
  const suggest = [];

  if (!sc.files.length) {
    issues.push({ level: 'error', code: 'EMPTY', msg: 'There are no files to publish (the folder is empty, or everything is excluded).' });
  } else {
    if (!sc.files.some((f) => /^index\.html?$/i.test(f.rel))) {
      issues.push({ level: 'warn', code: 'NO_INDEX', msg: 'No index.html in the folder root, so visitors may see an error page.' });
    }
    const secrets = sc.files.filter((f) => SECRET_RES.some((re) => re.test(path.basename(f.rel))));
    if (secrets.length) {
      issues.push({ level: 'warn', code: 'SECRET', msg: 'Possible private files would be uploaded:', files: secrets.slice(0, 6).map((f) => f.rel) });
      secrets.slice(0, 10).forEach((f) => suggest.push(f.rel));
    }
    if (sc.dirs.includes('.git')) {
      issues.push({ level: 'warn', code: 'GIT', msg: 'The folder contains a .git directory (your full project history).' });
      suggest.push('.git/');
    }
    if (sc.dirs.some((d) => /(^|\/)node_modules$/.test(d))) {
      issues.push({ level: 'warn', code: 'NODE_MODULES', msg: 'The folder contains node_modules, which is usually huge and not needed.' });
      suggest.push('node_modules/');
    }
    const big = sc.files.filter((f) => f.size > 25 * MB).sort((a, b) => b.size - a.size);
    if (big.length) {
      issues.push({ level: 'warn', code: 'LARGE', msg: 'Very large files:', files: big.slice(0, 5).map((f) => `${f.rel} (${(f.size / MB).toFixed(1)} MB)`) });
    }
    if (sc.total > 200 * MB) issues.push({ level: 'warn', code: 'BIG', msg: `The upload is large (${(sc.total / MB).toFixed(0)} MB) and may be slow.` });
    if (sc.truncated || sc.files.length >= 20000) issues.push({ level: 'warn', code: 'MANY', msg: 'The folder has a very large number of files.' });
  }
  return { issues, count: sc.files.length, total: sc.total, suggest: [...new Set(suggest)] };
}

/* ---------- staging (publish a filtered copy) ---------- */
function stage(root, excludeText, spa) {
  const m = makeMatcher(excludeText);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-stage-'));
  const sc = scan(root, m, 200000);
  for (const d of sc.dirs) fs.mkdirSync(path.join(dir, ...d.split('/')), { recursive: true });
  for (const f of sc.files) {
    const t = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.copyFileSync(f.abs, t);
  }
  if (spa) {
    const idx = path.join(dir, 'index.html'), two = path.join(dir, '200.html');
    if (fs.existsSync(idx) && !fs.existsSync(two)) fs.copyFileSync(idx, two);
  }
  return { dir, count: sc.files.length, total: sc.total };
}
function cleanupStage(dir) {
  if (dir && path.basename(dir).startsWith('surge-stage-')) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/* ---------- drop: copy with backup of replaced files + undo journal ---------- */
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

function copyNode(src, target, ctx, rel) {
  const st = fs.statSync(src);
  const rs = path.resolve(src), rt = path.resolve(target);
  if (st.isDirectory()) {
    if (rs === rt) return;
    if (rt.startsWith(rs + path.sep)) throw new Error('Cannot copy a folder into itself.');
    fs.mkdirSync(target, { recursive: true });
    for (const n of fs.readdirSync(src)) copyNode(path.join(src, n), path.join(target, n), ctx, rel + '/' + n);
    return;
  }
  if (rs === rt) return;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    if (sameContent(src, target)) { ctx.same++; return; }
    const keep = path.join(ctx.undoDir, 'old', ...rel.split('/'));
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.copyFileSync(target, keep);
    ctx.replaced.push(rel);
  } else {
    ctx.created.push(rel);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
}

// items: [{ src, rel }]  (rel = path relative to dest)
function performDrop({ items, dest, backupRoot, undoDir, label }) {
  fs.rmSync(undoDir, { recursive: true, force: true });
  fs.mkdirSync(undoDir, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  const ctx = { undoDir, created: [], replaced: [], same: 0 };
  for (const it of items) copyNode(it.src, path.join(dest, ...it.rel.split('/')), ctx, it.rel);

  let zip = null;
  if (ctx.replaced.length) {
    const entries = ctx.replaced.map((rel) => {
      const abs = path.join(undoDir, 'old', ...rel.split('/'));
      return { name: rel, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtime };
    });
    fs.mkdirSync(backupRoot, { recursive: true });
    zip = path.join(backupRoot, `${safeName(label)}_${stamp()}.zip`);
    writeZip(zip, entries);
  }
  fs.writeFileSync(path.join(undoDir, 'journal.json'), JSON.stringify({ dest, created: ctx.created, replaced: ctx.replaced, at: Date.now() }));
  return { created: ctx.created.length, replaced: ctx.replaced.length, same: ctx.same, zip };
}

function undoDrop({ dest, undoDir }) {
  const jf = path.join(undoDir, 'journal.json');
  if (!fs.existsSync(jf)) return { error: 'Nothing to undo.' };
  const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const base = path.resolve(dest);
  const inside = (p) => path.resolve(p).startsWith(base + path.sep);
  let removed = 0, restored = 0;
  for (const rel of j.created || []) {
    const t = path.join(dest, ...rel.split('/'));
    if (!inside(t)) continue;
    try { fs.unlinkSync(t); removed++; } catch {}
    let d = path.dirname(t);
    while (inside(d)) { try { fs.rmdirSync(d); } catch { break; } d = path.dirname(d); }
  }
  for (const rel of j.replaced || []) {
    const t = path.join(dest, ...rel.split('/'));
    const old = path.join(undoDir, 'old', ...rel.split('/'));
    if (!inside(t) || !fs.existsSync(old)) continue;
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.copyFileSync(old, t); restored++;
  }
  fs.rmSync(undoDir, { recursive: true, force: true });
  return { removed, restored };
}

/* ---------- Surge's .netrc: "machine surge.surge.sh login <email> password <token>" ---------- */
function parseNetrc(text) {
  const m = /machine\s+surge\.surge\.sh\s+login\s+(\S+)\s+password\s+(\S+)/.exec(String(text || ''));
  return m ? { email: m[1], token: m[2] } : null;
}

module.exports = { parseNetrc, stamp, safeName, makeMatcher, scan, precheck, stage, cleanupStage, performDrop, undoDrop };
