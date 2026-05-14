/**
 * main.js — RemoteTool v6
 * ssh2@0.8.9 纯 JS，无原生模块
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── 日志（同时输出到终端和文件）──────────────────────────────────────────────
const LOG_DIR  = path.join(os.homedir(), '.remotetool');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');
function log(...a) {
  const s = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  process.stdout.write(s);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, s);
  } catch (_) {}
}
process.on('uncaughtException',  e => log('FATAL uncaughtException',  e.stack || e));
process.on('unhandledRejection', e => log('FATAL unhandledRejection:', e));

log('=== RemoteTool start ===');
log('Node', process.version, 'Electron', process.versions.electron);

// ── ssh2 ──────────────────────────────────────────────────────────────────────
let SSHClient;
try {
  SSHClient = require('ssh2').Client;
  log('ssh2 loaded OK');
} catch (e) {
  log('ssh2 load FAILED:', e.message);
}

const sessions = new Map();
let mainWin;

// ── BrowserWindow ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
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
  const htmlPath = path.join(__dirname, 'index.html');
  log('loadFile:', htmlPath, 'exists:', fs.existsSync(htmlPath));
  mainWin.loadFile(htmlPath);

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'RemoteTool', submenu: [
      { label: 'About', role: 'about' }, { type: 'separator' },
      { label: 'Hide',  role: 'hide'  }, { label: 'Quit', role: 'quit' },
    ]},
    { label: 'Edit', submenu: [
      { label: 'Copy', role: 'copy' }, { label: 'Paste', role: 'paste' },
      { label: 'Select All', role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { label: 'Toggle DevTools', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: 'Actual Size', role: 'resetZoom' },
      { label: 'Zoom In',  role: 'zoomIn'  },
      { label: 'Zoom Out', role: 'zoomOut' },
    ]},
    { label: 'Window', submenu: [
      { label: 'Minimize', role: 'minimize' }, { label: 'Zoom', role: 'zoom' },
    ]},
  ]));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── SSH Connect ───────────────────────────────────────────────────────────────
ipcMain.handle('ssh-connect', (event, cfg) => {
  const { sessionId, host, port, username, password, privateKeyPath, passphrase } = cfg;
  log(`ssh-connect called: ${username}@${host}:${port} sid=${sessionId}`);

  if (!SSHClient) {
    log('ERROR: SSHClient not loaded');
    return Promise.reject('ssh2 模块未能加载，请检查 npm install ssh2@0.8.9');
  }

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();

    conn.on('ready', () => {
      log(`[${sessionId}] READY → opening shell`);
      conn.shell({ term: 'xterm-256color', cols: 200, rows: 50 }, (err, stream) => {
        if (err) { conn.end(); return reject('shell: ' + err.message); }
        sessions.set(sessionId, { conn, stream });
        stream.on('data', data => {
          mainWin?.webContents.send('ssh-data', { sessionId, data: Array.from(data) });
        });
        stream.stderr.on('data', data => {
          mainWin?.webContents.send('ssh-data', { sessionId, data: Array.from(data) });
        });
        stream.on('close', () => {
          log(`[${sessionId}] stream closed`);
          mainWin?.webContents.send('ssh-closed', { sessionId });
          sessions.delete(sessionId);
        });
        resolve({ ok: true });
      });
    });

    conn.on('error', err => {
      log(`[${sessionId}] ERROR:`, err.message);
      reject(err.message);
    });

    // keyboard-interactive 支持（堡垒机常用）
    conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      log(`[${sessionId}] keyboard-interactive prompts:`, prompts.map(p => p.prompt).join(', '));
      finish(prompts.map(() => password || ''));
    });

    // 服务器 banner（堡垒机登录提示）
    conn.on('banner', msg => {
      mainWin?.webContents.send('ssh-data', {
        sessionId, data: Array.from(Buffer.from('\r\n' + msg + '\r\n')),
      });
    });

    const connCfg = {
      host, port: Number(port) || 22, username,
      readyTimeout: 30000,
      keepaliveInterval: 15000,
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
          'diffie-hellman-group1-sha1',
        ],
        cipher: [
          'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
          'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
          'aes128-cbc', 'aes256-cbc', '3des-cbc',
        ],
        serverHostKey: [
          'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521', 'ssh-ed25519',
        ],
        hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1', 'hmac-md5'],
      },
    };

    if (privateKeyPath) {
      try { connCfg.privateKey = fs.readFileSync(privateKeyPath); }
      catch (e) { return reject('读取私钥失败: ' + e.message); }
      if (passphrase) connCfg.passphrase = passphrase;
    } else {
      connCfg.password    = password;
      connCfg.tryKeyboard = true;
    }

    log(`[${sessionId}] calling conn.connect()...`);
    conn.connect(connCfg);
  });
});

ipcMain.on('ssh-write', (_, { sessionId, data }) => {
  const s = sessions.get(sessionId);
  if (s) try { s.stream.write(Buffer.from(data)); } catch (e) { log('write err', e.message); }
});
ipcMain.on('ssh-resize', (_, { sessionId, cols, rows }) => {
  const s = sessions.get(sessionId);
  if (s) try { s.stream.setWindow(rows, cols, 0, 0); } catch (_) {}
});
ipcMain.on('ssh-disconnect', (_, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.conn.end(); } catch (_) {}
  sessions.delete(sessionId);
});

ipcMain.handle('get-sshpass-status', () => ({ sshpassAvailable: false }));

// ── File I/O ──────────────────────────────────────────────────────────────────
ipcMain.handle('show-save-dialog', async (_, o = {}) =>
  dialog.showSaveDialog(mainWin, { title: '保存文件', defaultPath: path.join(os.homedir(), 'Downloads', o.filename || 'file'), ...o }));
ipcMain.handle('show-open-dialog', async (_, o = {}) =>
  dialog.showOpenDialog(mainWin, { title: '选择文件', defaultPath: os.homedir(), properties: ['openFile'], ...o }));
ipcMain.handle('write-file', async (_, { filePath, data }) => {
  try { fs.writeFileSync(filePath, Buffer.from(data)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('read-file', async (_, { filePath }) => {
  try { const b = fs.readFileSync(filePath); return { ok: true, data: Array.from(b), name: path.basename(filePath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('reveal-file', async (_, { filePath }) => shell.showItemInFolder(filePath));

// ── Saved connections ─────────────────────────────────────────────────────────
const CF = path.join(LOG_DIR, 'connections.json');
const loadC = () => { try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR,{recursive:true}); return fs.existsSync(CF) ? JSON.parse(fs.readFileSync(CF,'utf8')) : []; } catch { return []; } };
const saveC = l => { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR,{recursive:true}); fs.writeFileSync(CF, JSON.stringify(l,null,2)); };
ipcMain.handle('get-connections',   ()      => loadC());
ipcMain.handle('save-connection',   (_, c)  => { const l=loadC(); const i=l.findIndex(x=>x.id===c.id); i>=0?l[i]=c:l.push(c); saveC(l); return l; });
ipcMain.handle('delete-connection', (_, id) => { const l=loadC().filter(c=>c.id!==id); saveC(l); return l; });
