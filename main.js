const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification, clipboard, safeStorage, globalShortcut,
} = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const F = require('./files');

let win;
let child = null;

/* ======================= settings (main-process side) ======================= */
const hiddenStart = process.argv.includes('--hidden');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const SECRETS_FILE = path.join(app.getPath('userData'), 'secrets.json');
const ICON = path.join(__dirname, 'icon.png');
const APP_ID = 'local.surge.gui';   // must match "appId" in package.json
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);   // groups the taskbar button and lets Windows pin this app, not Electron

let settings = { tray: true, startup: false, globalShortcut: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {}
}

/* ======================= window / tray ======================= */
let tray = null, quitting = false, shownTip = false;
let trayState = { sites: [], paused: false };

function sendToUI(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function log(text, kind = 'out') { sendToUI('log', { text, kind }); }
function sendTray(action) { sendToUI('tray-action', action); }

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function buildTrayMenu() {
  const siteItems = trayState.sites.length
    ? trayState.sites.slice(0, 30).map((s) => ({ label: s.name || s.id, click: () => sendTray({ type: 'publish', id: s.id }) }))
    : [{ label: '(no sites yet)', enabled: false }];
  return Menu.buildFromTemplate([
    { label: 'Open Surge Publisher', click: showWindow },
    { type: 'separator' },
    { label: 'Publish all', click: () => sendTray({ type: 'publish-all' }) },
    { label: 'Publish site', submenu: siteItems },
    { label: 'Pause auto-publish', type: 'checkbox', checked: !!trayState.paused, click: (mi) => sendTray({ type: 'pause', value: mi.checked }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
}
function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Surge Publisher');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);
}
function destroyTray() { if (tray) { tray.destroy(); tray = null; } }

function applyStartup() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  try { app.setLoginItemSettings({ openAtLogin: !!settings.startup, path: exe, args }); } catch {}
}
function applyGlobalShortcut() {
  try { globalShortcut.unregisterAll(); } catch {}
  if (!settings.globalShortcut) return;
  try { globalShortcut.register('CommandOrControl+Alt+P', () => sendTray({ type: 'publish-selected' })); } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 820, minHeight: 600,
    title: 'Surge Publisher',
    icon: ICON,
    show: !(hiddenStart && settings.tray),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    // “Pin to taskbar” stores this window's relaunch command and icon, so give it ones that start THIS app.
    // Built app: the real .exe you started (a portable build runs from a temporary folder, so not process.execPath).
    // npm start: electron.exe plus this project's folder, with the .ico from the repo.
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const how = app.isPackaged
      ? { appIconPath: exe, relaunchCommand: `"${exe}"` }
      : { appIconPath: path.join(__dirname, 'build', 'icon.ico'), relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"` };
    try { win.setAppDetails({ appId: APP_ID, appIconIndex: 0, relaunchDisplayName: 'Surge Publisher', ...how }); } catch {}
  }
  win.loadFile('index.html');
  win.on('close', (e) => {
    if (!quitting && settings.tray) {
      e.preventDefault();
      win.hide();
      if (!shownTip && tray && process.platform === 'win32') {
        shownTip = true;
        tray.displayBalloon({ title: 'Surge Publisher is still running', content: 'Auto-publish keeps working. Right-click the tray icon to quit.' });
      }
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    if (settings.tray) createTray();
    createWindow();
    applyGlobalShortcut();
  });
}
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} stopAllPreviews(); });
app.on('window-all-closed', () => app.quit());

ipcMain.handle('settings-get', () => ({ ...settings }));
ipcMain.handle('settings-set', (_e, s) => {
  for (const k of ['tray', 'startup', 'globalShortcut']) if (typeof s[k] === 'boolean') settings[k] = s[k];
  saveSettings();
  if (settings.tray) createTray(); else destroyTray();
  applyStartup();
  applyGlobalShortcut();
  return { ...settings };
});
ipcMain.handle('tray-update', (_e, st) => {
  trayState = { sites: Array.isArray(st.sites) ? st.sites.map((s) => ({ id: String(s.id), name: String(s.name || '') })) : [], paused: !!st.paused };
  if (tray) tray.setContextMenu(buildTrayMenu());
});
ipcMain.handle('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), icon: ICON }).show();
});
ipcMain.handle('set-zoom', (_e, f) => { if (win) win.webContents.setZoomFactor(Math.min(1.6, Math.max(0.7, Number(f) || 1))); });
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

/* ======================= running surge ======================= */
const SAFE_DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const SAFE_PATH = /^[^"%&|<>^`$;\r\n]+$/;
const SAFE_ARGS = /^[A-Za-z0-9@._:\/=,+ -]*$/;
const SUBCOMMANDS = ['list', 'rollback', 'rollfore', 'cutover', 'discard', 'dns', 'zone', 'encrypt', 'certs', 'ssl', 'config',
  'traffic', 'audience', 'usage', 'load', 'files', 'audit', 'bust', 'invite', 'revoke', 'verify', 'token', 'plan', 'nuke',
  'teardown', '--help', '--version'];
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const PROGRESS_LINE = /upload:.*?(\d{1,3})\s*%/i;
const PROGRESS_ETA = /eta:\s*([\d.]+)\s*s/i;
const PROGRESS_SIZE = /\((\d+)\s+files?,\s*(\d+)\s+bytes?\)/i;

function buildCommand(a) {
  switch (a.action) {
    case 'check': return 'surge --version';
    case 'install': return 'npm install --global surge';
    case 'whoami': return 'surge whoami';
    case 'login': return 'surge login';
    case 'logout': return 'surge logout';
    case 'list': return 'surge list';
    case 'publish':
      if (!a.folder || !SAFE_PATH.test(a.folder)) throw new Error('Choose a valid folder.');
      if (!fs.existsSync(a.folder) || !fs.statSync(a.folder).isDirectory()) throw new Error('Folder not found: ' + a.folder);
      if (!a.domain || !SAFE_DOMAIN.test(a.domain)) throw new Error('Enter a valid domain, e.g. mysite.surge.sh');
      return `surge "${a.folder}" ${a.domain}${a.preview ? ' --preview' : ''}`;
    case 'teardown':
      if (!a.domain || !SAFE_DOMAIN.test(a.domain)) throw new Error('Enter a valid domain to remove.');
      return `surge teardown ${a.domain}`;
    case 'cmd':
      if (!SUBCOMMANDS.includes(a.sub)) throw new Error('Unsupported command.');
      if (a.domain && !SAFE_DOMAIN.test(a.domain)) throw new Error('Invalid domain.');
      if (a.args && !SAFE_ARGS.test(a.args)) throw new Error('Extra arguments contain unsupported characters.');
      return ['surge', a.sub, a.domain, a.args].filter(Boolean).join(' ');
    case 'raw':
      if (!a.args || !SAFE_ARGS.test(a.args)) throw new Error('Enter a command using only letters, numbers and . _ : / = , + - @');
      return 'surge ' + a.args.trim();
    default: throw new Error('Unknown action.');
  }
}

/* ---- per-site Surge accounts (token stored encrypted with the OS) ---- */
function readSecrets() { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { return {}; } }
function writeSecrets(o) { fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true }); fs.writeFileSync(SECRETS_FILE, JSON.stringify(o)); }
function secretCreds(id) {
  const s = readSecrets()[id];
  if (!s || !safeStorage.isEncryptionAvailable()) return null;
  try { return { email: s.email, token: safeStorage.decryptString(Buffer.from(s.token, 'base64')) }; } catch { return null; }
}
ipcMain.handle('secret-set', (_e, { id, email, token }) => {
  if (!id || !email || !token) return { error: 'Enter both the account email and its token.' };
  if (!safeStorage.isEncryptionAvailable()) return { error: 'Secure storage is not available on this system.' };
  const o = readSecrets();
  o[id] = { email: String(email).slice(0, 200), token: safeStorage.encryptString(String(token)).toString('base64') };
  writeSecrets(o);
  return { ok: true, email: o[id].email };
});
// Sign in with email + password inside a throw-away home folder, so the PC's own Surge login is never touched.
ipcMain.handle('account-login', (_e, { id, email, password }) => new Promise((resolve) => {
  if (!id || !email || !password) return resolve({ error: 'Enter the email and password.' });
  if (!safeStorage.isEncryptionAvailable()) return resolve({ error: 'Secure storage is not available on this system.' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-login-'));
  const env = { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home };
  delete env.SURGE_LOGIN; delete env.SURGE_TOKEN;
  const p = spawn('surge login', { shell: true, windowsHide: true, env });
  let sentEmail = false, sentPass = false, out = '';
  const done = (r) => { clearTimeout(timer); fs.rmSync(home, { recursive: true, force: true }); resolve(r); };
  const timer = setTimeout(() => { p.kill(); }, 45000);
  const onData = (buf) => {
    const t = buf.toString().replace(ANSI, ''); out += t;
    if (!sentEmail && /email/i.test(t)) { p.stdin.write(email + '\n'); sentEmail = true; }
    else if (sentEmail && !sentPass && /password/i.test(t)) { p.stdin.write(password + '\n'); sentPass = true; }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', (e) => done({ error: e.message }));
  p.on('close', () => {
    let got = null;
    try { got = F.parseNetrc(fs.readFileSync(path.join(home, '.netrc'), 'utf8')); } catch {}
    if (!got) return done({ error: /not found|not recognized/i.test(out) ? 'Surge is not installed yet.' : 'Sign-in failed. Check the email and password, or use “I have a token”.' });
    const o = readSecrets();
    o[id] = { email: got.email.slice(0, 200), token: safeStorage.encryptString(got.token).toString('base64') };
    writeSecrets(o);
    done({ ok: true, email: o[id].email });
  });
}));
ipcMain.handle('secret-get', (_e, id) => { const s = readSecrets()[id]; return s ? { has: true, email: s.email } : { has: false }; });
ipcMain.handle('secret-clear', (_e, id) => { const o = readSecrets(); delete o[id]; writeSecrets(o); return { ok: true }; });

function dirSize(dir, cap = 20000) {
  let total = 0, seen = 0;
  const stack = [dir];
  while (stack.length && seen < cap) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      try { if (e.isDirectory()) stack.push(p); else if (e.isFile()) total += fs.statSync(p).size; } catch {}
    }
  }
  return total;
}
const sendProgress = (p) => sendToUI('progress', p);

function run(a) {
  return new Promise((resolve) => {
    if (child) return resolve({ code: -1, error: 'Another command is still running.' });

    let cmd, stageDir = null;
    try {
      cmd = buildCommand(a);
      if (a.action === 'publish' && (a.spa || (a.exclude && a.exclude.trim()))) {
        const st = F.stage(a.folder, a.exclude, !!a.spa);
        stageDir = st.dir;
        cmd = buildCommand({ ...a, folder: stageDir });
      }
    } catch (e) { F.cleanupStage(stageDir); return resolve({ code: -1, error: e.message }); }

    // Run as the chosen account: a private home folder holds only that account's login, so the PC's own login can never leak in.
    let credHome = null, env = { ...process.env, NO_COLOR: '1' };
    if (a.acct) {
      const c = secretCreds(a.acct);
      if (!c) { F.cleanupStage(stageDir); return resolve({ code: -1, error: 'This account’s saved login could not be read. Remove the account and add it again.' }); }
      credHome = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-home-'));
      fs.writeFileSync(path.join(credHome, '.netrc'), `machine surge.surge.sh\n  login ${c.email}\n  password ${c.token}\n`, { mode: 0o600 });
      Object.assign(env, { SURGE_LOGIN: c.email, SURGE_TOKEN: c.token, HOME: credHome, USERPROFILE: credHome });
      if (a.action !== 'check' && a.action !== 'install') log(`Account: ${c.email}`, 'cmd');
    } else if (a.action !== 'check' && a.action !== 'install') log('Account: Surge login on this PC', 'cmd');
    log(`> ${cmd}`, 'cmd');
    if (stageDir) log('(publishing a filtered copy: exclude rules / single-page-app file applied)', 'cmd');
    const isLogin = a.action === 'login';
    const interactive = a.action === 'cmd' || a.action === 'raw';
    const isPublish = a.action === 'publish';
    let lastPct = -1;
    if (isPublish) sendProgress({ phase: 'start', total: dirSize(stageDir || a.folder) });
    let sentEmail = false, sentPass = false, output = '';

    child = spawn(cmd, { shell: true, windowsHide: true, env });

    const finish = (payload) => {
      clearTimeout(timer);
      child = null;
      F.cleanupStage(stageDir);
      if (credHome) try { fs.rmSync(credHome, { recursive: true, force: true }); } catch {}
      resolve(payload);
    };
    const timer = setTimeout(() => {
      log('Timed out. If Surge asked for a login, use the Account section first.', 'err');
      child && child.kill();
    }, isLogin ? 45000 : interactive ? 600000 : 180000);

    const onData = (buf, kind) => {
      const text = buf.toString().replace(ANSI, '');
      output += text;
      for (const line of text.split(/\r|\n/)) {
        if (!line.trim()) continue;
        const pm = isPublish && PROGRESS_LINE.exec(line);
        if (pm) {
          const pct = Math.min(100, parseInt(pm[1], 10));
          if (pct !== lastPct) {
            lastPct = pct;
            const eta = PROGRESS_ETA.exec(line), size = PROGRESS_SIZE.exec(line);
            sendProgress({
              phase: 'update', pct, t: Date.now(),
              eta: eta ? parseFloat(eta[1]) : null,
              files: size ? parseInt(size[1], 10) : null,
              bytes: size ? parseInt(size[2], 10) : null,
            });
            if (pct === 100) log(line.trim(), kind);
          }
        } else {
          log(line.trimEnd(), kind);
        }
      }
      if (isLogin) {
        if (!sentEmail && /email/i.test(text)) { child.stdin.write((a.email || '') + '\n'); sentEmail = true; }
        else if (sentEmail && !sentPass && /password/i.test(text)) { child.stdin.write((a.password || '') + '\n'); sentPass = true; }
      }
    };
    child.stdout.on('data', (d) => onData(d, 'out'));
    child.stderr.on('data', (d) => onData(d, 'err'));
    if (!isLogin && !interactive) child.stdin.end();

    child.on('close', (code) => {
      log(code === 0 ? 'Done.' : `Finished with exit code ${code}.`, code === 0 ? 'ok' : 'err');
      if (isPublish) sendProgress({ phase: 'end', ok: code === 0 });
      finish({ code, output: output.trim() });
    });
    child.on('error', (e) => {
      if (isPublish) sendProgress({ phase: 'end', ok: false });
      finish({ code: -1, error: e.message });
    });
  });
}
ipcMain.handle('run', (_e, a) => run(a));
ipcMain.handle('stop', () => { if (child) child.kill(); });
ipcMain.handle('send-input', (_e, text) => {
  if (child && child.stdin && !child.stdin.destroyed) { child.stdin.write(String(text) + '\n'); return true; }
  return false;
});

/* ---- build step (runs your own command, e.g. "npm run build") ---- */
ipcMain.handle('build', (_e, { cmd, cwd }) => new Promise((resolve) => {
  if (child) return resolve({ code: -1, error: 'Another command is still running.' });
  if (!cmd || /[\r\n]/.test(cmd) || cmd.length > 500) return resolve({ code: -1, error: 'Invalid build command.' });
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return resolve({ code: -1, error: 'Build folder not found: ' + cwd });
  log(`> ${cmd}   (in ${cwd})`, 'cmd');
  child = spawn(cmd, { shell: true, cwd, windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  child.stdin.end();
  const timer = setTimeout(() => { log('Build timed out after 10 minutes.', 'err'); child && child.kill(); }, 600000);
  const onData = (buf, kind) => {
    for (const line of buf.toString().replace(ANSI, '').split(/\r|\n/)) if (line.trim()) log(line.trimEnd(), kind);
  };
  child.stdout.on('data', (d) => onData(d, 'out'));
  child.stderr.on('data', (d) => onData(d, 'err'));
  child.on('close', (code) => {
    clearTimeout(timer); child = null;
    log(code === 0 ? 'Build finished.' : `Build failed (exit code ${code}).`, code === 0 ? 'ok' : 'err');
    resolve({ code });
  });
  child.on('error', (e) => { clearTimeout(timer); child = null; resolve({ code: -1, error: e.message }); });
}));

/* ======================= files: checks, drop, backups ======================= */
ipcMain.handle('precheck', (_e, { folder, exclude }) => {
  try { return F.precheck(folder, exclude); } catch (e) { return { issues: [{ level: 'error', code: 'ERR', msg: e.message }], count: 0, total: 0, suggest: [] }; }
});

function managedFolder(name) {
  const base = path.join(app.getPath('documents'), 'Surge Sites');
  const safe = F.safeName(name);
  let dir = path.join(base, safe), n = 2;
  while (fs.existsSync(dir) && fs.readdirSync(dir).length) dir = path.join(base, `${safe}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const backupDirFor = (name) => path.join(app.getPath('documents'), 'Surge Backups', F.safeName(name));
const undoDirFor = (id, name) => path.join(app.getPath('userData'), 'undo', F.safeName(id || name));

ipcMain.handle('drop', async (_e, { paths, folder, name, id }) => {
  try {
    paths = (paths || []).filter((p) => p && fs.existsSync(p));
    if (!paths.length) return { error: 'Nothing usable was dropped.' };

    const single = paths.length === 1 && fs.statSync(paths[0]).isDirectory();
    let dest = folder && fs.existsSync(folder) ? folder : '';
    let items;

    if (single) {
      if (!dest) return { action: 'set', folder: paths[0], message: `Site folder set to ${paths[0]}` };
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Use this folder for the site', 'Copy its contents into current folder', 'Cancel'],
        defaultId: 0, cancelId: 2, title: 'Folder dropped',
        message: 'What should I do with this folder?',
        detail: `Dropped:\n${paths[0]}\n\nCurrent site folder:\n${dest}`,
      });
      if (r.response === 2) return { action: 'cancel' };
      if (r.response === 0) return { action: 'set', folder: paths[0], message: `Site folder set to ${paths[0]}` };
      items = fs.readdirSync(paths[0]).map((n) => ({ src: path.join(paths[0], n), rel: n }));
    } else {
      if (!dest) dest = managedFolder(name);
      items = paths.map((p) => ({ src: p, rel: path.basename(p) }));
    }

    const res = F.performDrop({ items, dest, backupRoot: backupDirFor(name), undoDir: undoDirFor(id, name), label: name });
    const bits = [];
    if (res.created) bits.push(`${res.created} new`);
    if (res.replaced) bits.push(`${res.replaced} replaced`);
    if (res.same) bits.push(`${res.same} unchanged`);
    let message = bits.length ? `Dropped files: ${bits.join(', ')}.` : 'Nothing to copy.';
    if (res.zip) message += ` Old versions backed up to ${res.zip}`;
    return { action: 'copied', folder: dest, ...res, message };
  } catch (e) {
    return { error: 'Drop failed: ' + e.message };
  }
});
ipcMain.handle('undo-drop', (_e, { id, name, folder }) => {
  try {
    if (!folder || !fs.existsSync(folder)) return { error: 'Site folder not found.' };
    return F.undoDrop({ dest: folder, undoDir: undoDirFor(id, name) });
  } catch (e) { return { error: 'Undo failed: ' + e.message }; }
});
ipcMain.handle('create-404', (_e, folder) => {
  try {
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { error: 'Folder not found.' };
    const f = path.join(folder, '404.html');
    if (fs.existsSync(f)) return { exists: true };
    fs.writeFileSync(f, '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Page not found</title>\n<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f5f7;color:#1b1f24}main{text-align:center;padding:24px}h1{font-size:64px;margin:0}a{color:#2f6fed}</style>\n</head>\n<body>\n<main>\n<h1>404</h1>\n<p>Sorry, that page could not be found.</p>\n<p><a href="/">Back to the home page</a></p>\n</main>\n</body>\n</html>\n');
    return { created: f };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('open-backups', (_e, name) => {
  const dir = backupDirFor(name);
  fs.promises.mkdir(dir, { recursive: true }).then(() => openFolder(dir)).catch(() => {});
  return true;   // answer immediately; Explorer opens on its own
});


// Opening Explorer through shell.openPath can block the app's UI thread on Windows
// (OneDrive-redirected Documents, slow shells...), so launch it as a separate process.
function openFolder(p) {
  if (process.platform === 'win32') {
    try {
      const c = spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' });
      c.on('error', () => { shell.openPath(p); });
      c.unref();
      return;
    } catch {}
  }
  shell.openPath(p);
}

/* ======================= misc dialogs / opening things ======================= */
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open-url', (_e, url) => {
  if (/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(url) || /^http:\/\/127\.0\.0\.1:\d+(\/[^\s]*)?$/.test(url)) shell.openExternal(url);
});
ipcMain.handle('open-path', (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return false;
    if (fs.statSync(p).isDirectory()) openFolder(p); else shell.openPath(p);
    return true;
  } catch { return false; }
});
ipcMain.handle('export-json', async (_e, { name, text }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name || 'surge-sites.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, String(text));
  return { path: r.filePath };
});
ipcMain.handle('import-json', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  if (fs.statSync(r.filePaths[0]).size > 5 * 1024 * 1024) return { error: 'That file is too large.' };
  return { text: fs.readFileSync(r.filePaths[0], 'utf8') };
});
ipcMain.handle('save-png', async (_e, { name, dataUrl }) => {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return { error: 'Invalid image.' };
  const r = await dialog.showSaveDialog(win, { defaultPath: name || 'qr.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, Buffer.from(m[1], 'base64'));
  return { path: r.filePath };
});

/* ======================= site health check ======================= */
function ping(domain) {
  return new Promise((resolve) => {
    const t = Date.now();
    let done = false;
    const end = (o) => { if (!done) { done = true; resolve(o); } };
    const req = https.request({ host: domain, path: '/', method: 'GET', timeout: 8000, headers: { 'User-Agent': 'SurgePublisher/1.0' } }, (r) => {
      end({ domain, status: r.statusCode, ok: r.statusCode < 400, ms: Date.now() - t });
      req.destroy();
    });
    req.on('timeout', () => { end({ domain, ok: false, status: 0, ms: null, error: 'timeout' }); req.destroy(); });
    req.on('error', (e) => end({ domain, ok: false, status: 0, ms: null, error: e.code || 'error' }));
    req.end();
  });
}
ipcMain.handle('ping', async (_e, domains) => {
  const list = [...new Set((Array.isArray(domains) ? domains : []).filter((d) => typeof d === 'string' && SAFE_DOMAIN.test(d)))].slice(0, 100);
  return Promise.all(list.map(ping));
});

/* ======================= local preview server ======================= */
const previews = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.map': 'application/json',
};
function startPreview(folder, spa) {
  return new Promise((resolve, reject) => {
    const root = path.resolve(folder);
    const existing = previews.get(root);
    if (existing) return resolve(`http://127.0.0.1:${existing.port}/`);
    const server = http.createServer((req, res) => {
      let rel;
      try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
      let file = path.join(root, rel);
      const inside = (p) => p === root || p.startsWith(root + path.sep);
      const send = (f, status = 200) => {
        res.writeHead(status, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(f).pipe(res);
      };
      if (!inside(path.resolve(file))) { res.writeHead(403); return res.end('Forbidden'); }
      try {
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(file);
      } catch {}
      const spaFile = path.join(root, '200.html'), idx = path.join(root, 'index.html'), nf = path.join(root, '404.html');
      if (spa && !path.extname(rel)) { const f = fs.existsSync(spaFile) ? spaFile : idx; if (fs.existsSync(f)) return send(f); }
      if (fs.existsSync(nf)) return send(nf, 404);
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      previews.set(root, { server, port });
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}
function stopAllPreviews() { for (const { server } of previews.values()) { try { server.close(); } catch {} } previews.clear(); }
ipcMain.handle('preview-start', async (_e, { folder, spa }) => {
  try {
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { error: 'Folder not found.' };
    return { url: await startPreview(folder, !!spa) };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('preview-stop', (_e, folder) => {
  const root = path.resolve(folder || '');
  const p = previews.get(root);
  if (p) { try { p.server.close(); } catch {} previews.delete(root); }
  return true;
});

/* ======================= folder watching ======================= */
const watchers = new Map();
const IGNORED = /(^|[\\/])(\.git|node_modules|\.DS_Store|Thumbs\.db)([\\/]|$)/;
ipcMain.handle('watch-sync', (_e, folders) => {
  folders = Array.isArray(folders) ? folders : [];
  for (const [f, w] of watchers) if (!folders.includes(f)) { w.close(); watchers.delete(f); }
  const active = [];
  for (const f of folders) {
    try {
      if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) continue;
      if (path.parse(f).root === f) { log(`Not watching drive root ${f}; choose a project folder.`, 'err'); continue; }
      if (!watchers.has(f)) {
        const w = fs.watch(f, { recursive: true }, (_evt, name) => {
          if (name && IGNORED.test(String(name))) return;
          sendToUI('fs-change', f);
        });
        w.on('error', () => { w.close(); watchers.delete(f); });
        watchers.set(f, w);
      }
      active.push(f);
    } catch (e) { log(`Could not watch ${f}: ${e.message}`, 'err'); }
  }
  return active;
});
