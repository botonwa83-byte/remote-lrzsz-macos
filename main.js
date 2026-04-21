const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os');

let mainWindow;
// Map<sessionId, { conn: Client, stream: Channel }>
const sshSessions = new Map();

// ─── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Build application menu
  const template = [
    {
      label: 'RemoteTool',
      submenu: [
        { label: 'About RemoteTool', role: 'about' },
        { type: 'separator' },
        { label: 'Hide RemoteTool', role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Developer Tools', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Actual Size', role: 'resetZoom' },
        { label: 'Zoom In', role: 'zoomIn' },
        { label: 'Zoom Out', role: 'zoomOut' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', role: 'minimize' },
        { label: 'Zoom', role: 'zoom' },
        { type: 'separator' },
        { label: 'Bring All to Front', role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── SSH: Connect ──────────────────────────────────────────────────────────

ipcMain.handle('ssh-connect', (event, config) => {
  const { sessionId, host, port = 22, username, password, privateKeyPath, passphrase } = config;

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.shell(
        { term: 'xterm-256color', cols: 220, rows: 50 },
        (err, stream) => {
          if (err) { conn.end(); return reject(err.message); }

          sshSessions.set(sessionId, { conn, stream });

          stream.on('data', (data) => {
            mainWindow?.webContents.send('ssh-data', {
              sessionId,
              data: Array.from(data),
            });
          });

          stream.stderr.on('data', (data) => {
            mainWindow?.webContents.send('ssh-data', {
              sessionId,
              data: Array.from(data),
            });
          });

          stream.on('close', () => {
            mainWindow?.webContents.send('ssh-closed', { sessionId });
            sshSessions.delete(sessionId);
          });

          resolve({ ok: true });
        }
      );
    });

    conn.on('error', (err) => reject(err.message));
    conn.on('keyboard-interactive', (_n, _i, _il, prompts, finish) => {
      // Simple keyboard-interactive: return password for first prompt
      finish(prompts.map(() => password || ''));
    });

    // Build auth config
    const cfg = { host, port, username, readyTimeout: 15000 };
    if (privateKeyPath) {
      try {
        cfg.privateKey = fs.readFileSync(privateKeyPath);
        if (passphrase) cfg.passphrase = passphrase;
      } catch (e) {
        return reject(`Cannot read private key: ${e.message}`);
      }
    } else {
      cfg.password = password;
      cfg.tryKeyboard = true;
    }

    conn.connect(cfg);
  });
});

// ─── SSH: Write data ────────────────────────────────────────────────────────

ipcMain.on('ssh-write', (event, { sessionId, data }) => {
  const session = sshSessions.get(sessionId);
  if (!session) return;
  session.stream.write(Buffer.from(data));
});

// ─── SSH: Resize terminal ──────────────────────────────────────────────────

ipcMain.on('ssh-resize', (event, { sessionId, cols, rows }) => {
  const session = sshSessions.get(sessionId);
  if (!session) return;
  try { session.stream.setWindow(rows, cols, 0, 0); } catch (_) {}
});

// ─── SSH: Disconnect ───────────────────────────────────────────────────────

ipcMain.on('ssh-disconnect', (event, { sessionId }) => {
  const session = sshSessions.get(sessionId);
  if (!session) return;
  try { session.conn.end(); } catch (_) {}
  sshSessions.delete(sessionId);
});

// ─── File dialogs ──────────────────────────────────────────────────────────

ipcMain.handle('show-save-dialog', async (event, opts = {}) => {
  return dialog.showSaveDialog(mainWindow, {
    title: 'Save Received File',
    defaultPath: path.join(os.homedir(), 'Downloads', opts.filename || 'received-file'),
    ...opts,
  });
});

ipcMain.handle('show-open-dialog', async (event, opts = {}) => {
  return dialog.showOpenDialog(mainWindow, {
    title: 'Select File to Send',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    ...opts,
  });
});

// ─── File I/O ──────────────────────────────────────────────────────────────

ipcMain.handle('write-file', async (event, { filePath, data }) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(data));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('read-file', async (event, { filePath }) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, data: Array.from(buf), name: path.basename(filePath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('reveal-file', async (event, { filePath }) => {
  shell.showItemInFolder(filePath);
});

// ─── Saved connections (persist to ~/.remotetool/connections.json) ─────────

const configDir = path.join(os.homedir(), '.remotetool');
const configFile = path.join(configDir, 'connections.json');

function loadConnections() {
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(configFile)) return [];
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch { return []; }
}

function saveConnections(list) {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(list, null, 2), 'utf8');
}

ipcMain.handle('get-connections', () => loadConnections());

ipcMain.handle('save-connection', (event, conn) => {
  const list = loadConnections();
  const idx = list.findIndex((c) => c.id === conn.id);
  if (idx >= 0) list[idx] = conn; else list.push(conn);
  saveConnections(list);
  return list;
});

ipcMain.handle('delete-connection', (event, id) => {
  const list = loadConnections().filter((c) => c.id !== id);
  saveConnections(list);
  return list;
});
