/**
 * renderer.js
 * SSH Terminal with full lrzsz (ZMODEM) support
 * Uses xterm.js for terminal rendering and zmodem.js for file transfer protocol
 */

'use strict';

// ─── State ─────────────────────────────────────────────────────────────────

const sessions = new Map();   // Map<sessionId, SessionState>
let activeSessionId = null;
let connections = [];          // saved connections from disk
let editingConnId = null;      // connection being edited in modal
let transferStartTime = 0;
let transferBytes = 0;

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const connList      = $('#conn-list');
const tabBar        = $('#tab-bar');
const termContainer = $('#terminal-container');
const welcome       = $('#welcome');

const stDot  = $('#st-dot');
const stText = $('#st-text');
const stSize = $('#st-size');

const modal          = $('#conn-modal');
const modalTitle     = $('#modal-title');
const modalSaveBtn   = $('#modal-save-btn');
const modalCancelBtn = $('#modal-cancel-btn');
const modalCloseBtn  = $('#modal-close-btn');

const trOverlay  = $('#transfer-overlay');
const trIcon     = $('#tr-icon');
const trTitle    = $('#tr-title');
const trFilename = $('#tr-filename');
const trFill     = $('#tr-fill');
const trBytes    = $('#tr-bytes');
const trPct      = $('#tr-pct');
const trSpeed    = $('#tr-speed');
const trClose    = $('#tr-close-btn');
const trCancel   = $('#tr-cancel-btn');

const toast = $('#toast');

// ─── Utils ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function showToast(msg, type = 'info', duration = 3000) {
  toast.textContent = msg;
  toast.className = `show ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = ''; }, duration);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtSpeed(bytesPerSec) {
  return fmtBytes(bytesPerSec) + '/s';
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  connections = await window.electronAPI.getConnections();
  renderConnList();
  bindEvents();

  // Global SSH data handler
  window.electronAPI.onSSHData(({ sessionId, data }) => {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    const bytes = new Uint8Array(data);
    // Feed through ZMODEM sentry
    try {
      sess.zsentry.consume(bytes);
    } catch (e) {
      // If sentry throws (e.g. not in a transfer), write raw
      sess.term.write(bytes);
    }
  });

  window.electronAPI.onSSHClosed(({ sessionId }) => {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    sess.connected = false;
    sess.term.writeln('\r\n\x1b[33m[连接已断开]\x1b[0m');
    updateTabStatus(sessionId, 'disconnected');
    if (sessionId === activeSessionId) updateStatusBar();
  });
}

// ─── Connection list ────────────────────────────────────────────────────────

function renderConnList() {
  connList.innerHTML = '';
  if (connections.length === 0) {
    connList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">暂无保存的连接<br>点击 + 添加</div>';
    return;
  }
  connections.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'conn-item';
    item.dataset.id = c.id;

    // Mark connected
    const isConn = [...sessions.values()].some(s => s.connId === c.id && s.connected);
    if (isConn) item.classList.add('connected');

    item.innerHTML = `
      <div class="conn-dot"></div>
      <div class="conn-info">
        <div class="conn-name">${c.name}</div>
        <div class="conn-host">${c.username}@${c.host}:${c.port || 22}</div>
      </div>
      <div class="conn-actions">
        <button class="conn-btn" data-action="edit" title="编辑">✏️</button>
        <button class="conn-btn danger" data-action="delete" title="删除">🗑</button>
      </div>`;

    item.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'edit')   { openEditModal(c); return; }
      if (action === 'delete') { deleteConn(c.id); return; }
      openSession(c);
    });

    connList.appendChild(item);
  });
}

async function deleteConn(id) {
  connections = await window.electronAPI.deleteConnection(id);
  renderConnList();
}

// ─── Modal (new/edit connection) ─────────────────────────────────────────────

function openNewModal() {
  editingConnId = null;
  modalTitle.textContent = '新建连接';
  $('#f-name').value = '';
  $('#f-host').value = '';
  $('#f-port').value = '22';
  $('#f-user').value = '';
  $('#f-pass').value = '';
  $('#f-key').value = '';
  $('#f-passphrase').value = '';
  setAuthTab('password');
  modal.classList.add('open');
  setTimeout(() => $('#f-host').focus(), 100);
}

function openEditModal(c) {
  editingConnId = c.id;
  modalTitle.textContent = '编辑连接';
  $('#f-name').value = c.name || '';
  $('#f-host').value = c.host || '';
  $('#f-port').value = c.port || 22;
  $('#f-user').value = c.username || '';
  $('#f-pass').value = c.password || '';
  $('#f-key').value  = c.privateKeyPath || '';
  $('#f-passphrase').value = c.passphrase || '';
  setAuthTab(c.authType || 'password');
  modal.classList.add('open');
}

function closeModal() {
  modal.classList.remove('open');
}

function setAuthTab(type) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.auth === type));
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.toggle('active', p.id === `auth-${type}`));
}

async function saveAndConnect() {
  const host = $('#f-host').value.trim();
  const user = $('#f-user').value.trim();
  if (!host || !user) { showToast('主机和用户名不能为空', 'error'); return; }

  const authType = document.querySelector('.auth-tab.active').dataset.auth;
  const conn = {
    id:             editingConnId || uid(),
    name:           $('#f-name').value.trim() || host,
    host,
    port:           parseInt($('#f-port').value) || 22,
    username:       user,
    authType,
    password:       authType === 'password' ? $('#f-pass').value : '',
    privateKeyPath: authType === 'key'      ? $('#f-key').value.trim() : '',
    passphrase:     authType === 'key'      ? $('#f-passphrase').value : '',
  };

  modalSaveBtn.disabled = true;
  modalSaveBtn.textContent = '连接中…';

  connections = await window.electronAPI.saveConnection(conn);
  renderConnList();
  closeModal();
  openSession(conn);

  modalSaveBtn.disabled = false;
  modalSaveBtn.textContent = '保存并连接';
}

// ─── Sessions ────────────────────────────────────────────────────────────────

async function openSession(connConfig) {
  const sessionId = uid();

  // Create terminal pane
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.id = `pane-${sessionId}`;
  termContainer.appendChild(pane);

  // Create xterm.js instance
  const term = new Terminal({
    theme: {
      background: '#0d0d14',
      foreground: '#c8cad8',
      cursor:     '#6e8efb',
      selectionBackground: '#6e8efb44',
      black:   '#1e1e2e', red:     '#f87171', green:  '#4ade80', yellow: '#fbbf24',
      blue:    '#6e8efb', magenta: '#a78bfa', cyan:   '#22d3ee', white:  '#cdd6f4',
      brightBlack: '#45475a', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
      brightCyan: '#89dceb', brightWhite: '#b4befe',
    },
    fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    allowTransparency: true,
  });

  const fitAddon     = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(pane);
  fitAddon.fit();

  // ZMODEM sentry — intercepts ZMODEM sequences in the SSH stream
  const zsentry = createZSentry(sessionId, term);

  const sess = {
    sessionId,
    connId:    connConfig.id,
    label:     connConfig.name,
    term,
    fitAddon,
    zsentry,
    pane,
    connected: false,
    zactive:   false,
    ztransfer: null,
  };
  sessions.set(sessionId, sess);

  // Keyboard input → SSH
  term.onData((data) => {
    if (sess.zactive) return;  // block input during ZMODEM
    window.electronAPI.writeSSH(sessionId, Array.from(new TextEncoder().encode(data)));
  });

  // Binary input (paste etc.)
  term.onBinary((data) => {
    if (sess.zactive) return;
    const bytes = Array.from(data.split('').map(c => c.charCodeAt(0)));
    window.electronAPI.writeSSH(sessionId, bytes);
  });

  // Resize
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    window.electronAPI.resizeSSH(sessionId, term.cols, term.rows);
    if (activeSessionId === sessionId) updateStatusBar();
  });
  resizeObserver.observe(termContainer);
  sess.resizeObserver = resizeObserver;

  // Create tab
  addTab(sessionId, connConfig.name);
  activateSession(sessionId);
  welcome.classList.add('hidden');

  term.writeln(`\x1b[36mConnecting to ${connConfig.username}@${connConfig.host}:${connConfig.port || 22}…\x1b[0m`);
  updateTabStatus(sessionId, 'connecting');

  try {
    await window.electronAPI.connectSSH({
      sessionId,
      host:           connConfig.host,
      port:           connConfig.port || 22,
      username:       connConfig.username,
      password:       connConfig.authType === 'password' ? connConfig.password : undefined,
      privateKeyPath: connConfig.authType === 'key'      ? connConfig.privateKeyPath : undefined,
      passphrase:     connConfig.authType === 'key'      ? connConfig.passphrase : undefined,
    });

    sess.connected = true;
    term.writeln('\x1b[32m[已连接] 输入 rz 接收文件，sz <filename> 发送文件\x1b[0m\r\n');
    updateTabStatus(sessionId, 'connected');
    renderConnList();
    if (activeSessionId === sessionId) updateStatusBar();
    fitAddon.fit();
    window.electronAPI.resizeSSH(sessionId, term.cols, term.rows);

  } catch (err) {
    term.writeln(`\r\n\x1b[31m[连接失败] ${err}\x1b[0m`);
    updateTabStatus(sessionId, 'error');
    showToast(`连接失败: ${err}`, 'error', 5000);
  }
}

function closeSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  window.electronAPI.disconnectSSH(sessionId);
  sess.resizeObserver?.disconnect();
  sess.term.dispose();
  sess.pane.remove();
  sessions.delete(sessionId);
  removeTab(sessionId);

  if (activeSessionId === sessionId) {
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) activateSession(remaining[remaining.length - 1]);
    else {
      activeSessionId = null;
      welcome.classList.remove('hidden');
      updateStatusBar();
    }
  }
  renderConnList();
}

function activateSession(sessionId) {
  activeSessionId = sessionId;

  // Hide all panes, show active
  document.querySelectorAll('.term-pane').forEach(p => p.classList.remove('active'));
  const sess = sessions.get(sessionId);
  if (sess) {
    sess.pane.classList.add('active');
    sess.fitAddon.fit();
    sess.term.focus();
  }

  // Update tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.session === sessionId));

  welcome.classList.toggle('hidden', !!sessionId);
  updateStatusBar();
}

// ─── ZMODEM (lrzsz) implementation ──────────────────────────────────────────

function createZSentry(sessionId, term) {
  const sess = () => sessions.get(sessionId);

  return new Zmodem.Sentry({
    // Normal terminal output (when NOT in ZMODEM)
    to_terminal(octets) {
      term.write(new Uint8Array(octets));
    },

    // Send bytes from client → server (ZMODEM protocol frames)
    sender(octets) {
      window.electronAPI.writeSSH(sessionId, Array.from(octets));
    },

    on_retract() {
      // Server cancelled / completed ZMODEM
      const s = sess();
      if (s) { s.zactive = false; s.ztransfer = null; }
      hideTransferOverlay();
    },

    // ZMODEM session detected
    async on_detect(detection) {
      const s = sess();
      if (!s) return;
      s.zactive = true;
      s.ztransfer = detection;

      const zsession = detection.confirm();

      if (zsession.type === 'send') {
        // Server wants to RECEIVE file(s) from us (user typed `rz`)
        await handleRZSession(sessionId, zsession);
      } else {
        // Server wants to SEND file(s) to us (user typed `sz filename`)
        await handleSZSession(sessionId, zsession);
      }
    },
  });
}

// rz: we SEND file(s) to the server
async function handleRZSession(sessionId, zsession) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  showToast('rz 已触发，请选择要上传的文件…', 'info', 3000);

  const result = await window.electronAPI.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
  if (result.canceled || !result.filePaths.length) {
    zsession.abort();
    sess.zactive = false;
    hideTransferOverlay();
    showToast('文件上传已取消', 'info');
    return;
  }

  // Read all selected files
  const files = [];
  for (const fp of result.filePaths) {
    const res = await window.electronAPI.readFile(fp);
    if (!res.ok) { showToast(`读取文件失败: ${res.error}`, 'error'); continue; }
    files.push({ name: res.name, data: new Uint8Array(res.data) });
  }

  if (!files.length) { zsession.abort(); sess.zactive = false; hideTransferOverlay(); return; }

  let fileIdx = 0;
  for (const file of files) {
    fileIdx++;
    showTransferOverlay('upload', file.name, file.data.length, fileIdx, files.length);
    transferStartTime = Date.now();
    transferBytes = 0;

    try {
      await new Promise((resolve, reject) => {
        zsession.send_offer(
          { name: file.name, size: file.data.length, mtime: new Date() },
          (xfer) => {
            if (!xfer) { resolve(); return; }  // offer rejected by server
            sess.ztransfer = xfer;

            const CHUNK = 8192;
            let offset = 0;

            function sendChunk() {
              if (offset >= file.data.length) {
                xfer.end().then(resolve).catch(reject);
                return;
              }
              const slice = file.data.slice(offset, offset + CHUNK);
              offset += slice.length;
              transferBytes = offset;
              updateTransferProgress(offset, file.data.length, transferStartTime);

              xfer.send(slice);
              // yield to allow UI update
              setTimeout(sendChunk, 0);
            }
            sendChunk();
          }
        );
      });
    } catch (e) {
      showToast(`上传失败: ${e}`, 'error');
    }
  }

  await zsession.close();
  sess.zactive = false;
  sess.ztransfer = null;
  hideTransferOverlay();
  showToast(`✅ 上传完成 (${files.length} 个文件)`, 'success');
}

// sz: server SENDS file(s) to us
async function handleSZSession(sessionId, zsession) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  zsession.on('session_end', () => {
    sess.zactive = false;
    sess.ztransfer = null;
    hideTransferOverlay();
    showToast('✅ 下载完成', 'success');
  });

  zsession.on('offer', (xfer) => {
    const filename = xfer.get_details().name || 'received-file';
    const totalSize = xfer.get_details().size || 0;
    showTransferOverlay('download', filename, totalSize, 1, 1);
    transferStartTime = Date.now();
    transferBytes = 0;

    const chunks = [];
    sess.ztransfer = xfer;

    xfer.on('input', (payload) => {
      chunks.push(new Uint8Array(payload));
      transferBytes += payload.length;
      updateTransferProgress(transferBytes, totalSize, transferStartTime);
    });

    xfer.accept().then(async () => {
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }

      const dlResult = await window.electronAPI.showSaveDialog({ filename });
      if (!dlResult.canceled && dlResult.filePath) {
        const wr = await window.electronAPI.writeFile(dlResult.filePath, Array.from(merged));
        if (wr.ok) {
          showToast(`✅ 已保存: ${filename}`, 'success');
          await window.electronAPI.revealFile({ filePath: dlResult.filePath });
        } else {
          showToast(`保存失败: ${wr.error}`, 'error');
        }
      }
    }).catch((e) => { showToast(`接收失败: ${e}`, 'error'); });
  });

  zsession.start();
}

// ─── Transfer overlay ────────────────────────────────────────────────────────

function showTransferOverlay(direction, filename, totalBytes, current, total) {
  trIcon.textContent    = direction === 'upload' ? '📤' : '📥';
  trTitle.textContent   = direction === 'upload' ? `上传 ${current}/${total}` : `下载 ${current}/${total}`;
  trFilename.textContent = filename;
  trFill.style.width    = '0%';
  trBytes.textContent   = '0 B';
  trPct.textContent     = '0%';
  trSpeed.textContent   = '-';
  trOverlay.style.display = 'flex';
  requestAnimationFrame(() => trOverlay.classList.add('show'));
  $('#status-transfer').textContent = `${direction === 'upload' ? '↑' : '↓'} ${filename}`;
  $('#status-transfer').classList.remove('hidden');
}

function hideTransferOverlay() {
  trOverlay.classList.remove('show');
  setTimeout(() => { trOverlay.style.display = 'none'; }, 300);
  $('#status-transfer').classList.add('hidden');
}

function updateTransferProgress(received, total, startTime) {
  const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
  const elapsed = (Date.now() - startTime) / 1000;
  const speed = elapsed > 0 ? received / elapsed : 0;

  trFill.style.width    = pct.toFixed(1) + '%';
  trBytes.textContent   = `${fmtBytes(received)} / ${fmtBytes(total)}`;
  trPct.textContent     = pct.toFixed(1) + '%';
  trSpeed.textContent   = fmtSpeed(speed);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function addTab(sessionId, label) {
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.session = sessionId;
  tab.innerHTML = `
    <div class="tab-status"></div>
    <div class="tab-label">${label}</div>
    <div class="tab-close">✕</div>`;

  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) { closeSession(sessionId); return; }
    activateSession(sessionId);
  });

  tabBar.appendChild(tab);
}

function removeTab(sessionId) {
  const tab = tabBar.querySelector(`[data-session="${sessionId}"]`);
  tab?.remove();
}

function updateTabStatus(sessionId, status) {
  const tab = tabBar.querySelector(`[data-session="${sessionId}"]`);
  if (!tab) return;
  tab.classList.remove('connected', 'error', 'connecting');
  if (status === 'connected')   tab.classList.add('connected');
  if (status === 'error')       tab.classList.add('error');
}

// ─── Status bar ──────────────────────────────────────────────────────────────

function updateStatusBar() {
  const sess = sessions.get(activeSessionId);
  if (!sess) {
    stDot.className = 'status-dot';
    stText.textContent = '未连接';
    stSize.textContent = '-';
    return;
  }
  if (sess.connected) {
    stDot.className = 'status-dot green';
    stText.textContent = sess.label;
  } else {
    stDot.className = 'status-dot';
    stText.textContent = `${sess.label} (已断开)`;
  }
  stSize.textContent = `${sess.term.cols}×${sess.term.rows}`;
}

// ─── Bind events ─────────────────────────────────────────────────────────────

function bindEvents() {
  // New connection button
  $('#btn-new-conn').addEventListener('click', openNewModal);

  // Modal events
  modalSaveBtn.addEventListener('click', saveAndConnect);
  modalCancelBtn.addEventListener('click', closeModal);
  modalCloseBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // Auth tabs
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => setAuthTab(tab.dataset.auth));
  });

  // Browse private key
  $('#btn-browse-key').addEventListener('click', async () => {
    const r = await window.electronAPI.showOpenDialog({
      title: '选择私钥文件',
      defaultPath: '~/.ssh',
      filters: [{ name: '私钥', extensions: ['*'] }],
    });
    if (!r.canceled && r.filePaths[0]) $('#f-key').value = r.filePaths[0];
  });

  // Enter key in modal
  document.querySelectorAll('.modal input').forEach(inp => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAndConnect(); });
  });

  // Transfer overlay close/cancel
  trClose.addEventListener('click', hideTransferOverlay);
  trCancel.addEventListener('click', () => {
    const sess = sessions.get(activeSessionId);
    if (sess?.ztransfer) {
      try { sess.ztransfer.abort?.(); } catch (_) {}
    }
    hideTransferOverlay();
    showToast('传输已取消', 'info');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // ⌘W - close active tab
    if (e.metaKey && e.key === 'w') { e.preventDefault(); if (activeSessionId) closeSession(activeSessionId); }
    // ⌘N - new connection
    if (e.metaKey && e.key === 'n') { e.preventDefault(); openNewModal(); }
    // ⌘] and ⌘[ - cycle tabs
    if (e.metaKey && (e.key === ']' || e.key === '[')) {
      e.preventDefault();
      const keys = [...sessions.keys()];
      const idx = keys.indexOf(activeSessionId);
      const next = e.key === ']' ? (idx + 1) % keys.length : (idx - 1 + keys.length) % keys.length;
      if (keys[next]) activateSession(keys[next]);
    }
  });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);
