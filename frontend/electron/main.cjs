const { app, BrowserWindow, Menu, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;

function settingsPath() {
  return path.join(app.getPath('userData'), 'lan-server.json');
}

function normaliseLocalUrl(input) {
  const raw = String(input || '').trim();
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password ||
      (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error('Enter only a LAN server address such as http://192.168.1.50:5050');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = host.split('.').map(Number);
  const isPrivateIp = ipv4.length === 4 && host.split('.').every(x => /^\d+$/.test(x)) &&
    ipv4.every(x => x >= 0 && x <= 255) && (
      ipv4[0] === 10 || (ipv4[0] === 192 && ipv4[1] === 168) ||
      (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      ipv4[0] === 127);
  const isLanHostname = host === 'localhost' ||
    /^[a-z0-9][a-z0-9-]*$/i.test(host) ||
    /^[a-z0-9][a-z0-9.-]*\.local$/i.test(host);
  if (!isPrivateIp && !isLanHostname) {
    throw new Error('Use Desktop 1’s private LAN IP or local computer name, not a public website.');
  }
  return u.origin;
}

function getSavedUrl() {
  try {
    return normaliseLocalUrl(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).server);
  } catch {
    return null;
  }
}

function openSetup() {
  mainWindow.loadFile(path.join(__dirname, 'lan-setup.html'));
}

function openServer(server) {
  mainWindow.loadURL(server);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 640,
    autoHideMenuBar: true, backgroundColor: '#06111b',
    icon: path.join(__dirname, 'lesbad-icon.png'),
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'lan-preload.cjs')
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    const allowed = getSavedUrl();
    if (!allowed || !target.startsWith(allowed + '/')) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && String(input.key).toLowerCase() === 'l') {
      event.preventDefault();
      openSetup();
    }
  });
  mainWindow.webContents.on('did-fail-load',
    (_event, code, _message, _targetUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) openSetup();
    });
  const server = getSavedUrl();
  if (server) openServer(server);
  else openSetup();
}

app.whenReady().then(() => {
  ipcMain.handle('lesbad:get-server', () => getSavedUrl() || 'http://127.0.0.1:5050');
  ipcMain.handle('lesbad:set-server', async (_event, input) => {
    let server;
    try { server = normaliseLocalUrl(input); }
    catch (e) { return { ok: false, error: e.message }; }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let response;
      try {
        response = await net.fetch(server + '/api/health', { signal: controller.signal });
      } finally { clearTimeout(timer); }
      if (!response.ok || !(await response.json()).ok) {
        return { ok: false, error: 'The address responded, but it is not a LESBAD API server.' };
      }
    } catch {
      return { ok: false, error: 'Cannot reach Desktop 1. Check Wi-Fi, IP address, firewall and server window.' };
    }
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ server }, null, 2), { mode: 0o600 });
    openServer(server);
    return { ok: true };
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
