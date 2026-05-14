'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const sessions = new Map();   // sessionId → { term, fitAddon, pane, connected, zsentry }
let activeId = null;
let connections = [];
let editingId  = null;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = s => document.querySelector(s);
const connList    = $('#conn-list');
const tabBar      = $('#tab-bar');
const termCont    = $('#terminal-container');
const welcome     = $('#welcome');
const stDot       = $('#st-dot');
const stText      = $('#st-text');
const stSize      = $('#st-size');
const modal       = $('#conn-modal');
const trOverlay   = $('#transfer-overlay');
const toast       = $('#toast');

// ── Utils ─────────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(2) + ' MB';

function showToast(msg, type = 'info', ms = 3500) {
  toast.textContent = msg;
  toast.className = `show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.className = ''; }, ms);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    connections = await window.electronAPI.getConnections();
  } catch (e) {
    console.error('getConnections failed:', e);
    connections = [];
  }
  renderConnList();
  bindEvents();

  window.electronAPI.onSSHData(({ sessionId, data }) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    try {
      s.zsentry.consume(new Uint8Array(data));
    } catch (_) {
      s.term.write(new Uint8Array(data));
    }
  });

  window.electronAPI.onSSHClosed(({ sessionId }) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.connected = false;
    s.term.writeln('\r\n\x1b[33m[连接已断开]\x1b[0m');
    setTabStatus(sessionId, 'disconnected');
    if (sessionId === activeId) updateStatus();
  });
}

// ── Connection list ───────────────────────────────────────────────────────────
function renderConnList() {
  connList.innerHTML = '';
  if (!connections.length) {
    connList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">暂无连接<br>点击 + 添加</div>';
    return;
  }
  connections.forEach(c => {
    const isConn = [...sessions.values()].some(s => s.connId === c.id && s.connected);
    const el = document.createElement('div');
    el.className = 'conn-item' + (isConn ? ' connected' : '');
    el.dataset.id = c.id;
    el.innerHTML = `
      <div class="conn-dot"></div>
      <div class="conn-info">
        <div class="conn-name">${c.name}</div>
        <div class="conn-host">${c.username}@${c.host}:${c.port||22}</div>
      </div>
      <div class="conn-actions">
        <button class="conn-btn" data-action="edit" title="编辑">✏️</button>
        <button class="conn-btn danger" data-action="delete" title="删除">🗑</button>
      </div>`;
    el.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'edit')   { openModal(c); return; }
      if (a === 'delete') { delConn(c.id); return; }
      openSession(c);
    });
    connList.appendChild(el);
  });
}

async function delConn(id) {
  connections = await window.electronAPI.deleteConnection(id);
  renderConnList();
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(c = null) {
  editingId = c?.id || null;
  $('#modal-title').textContent = c ? '编辑连接' : '新建连接';
  $('#f-name').value        = c?.name        || '';
  $('#f-host').value        = c?.host        || '';
  $('#f-port').value        = c?.port        || 22;
  $('#f-user').value        = c?.username    || '';
  $('#f-pass').value        = c?.password    || '';
  $('#f-key').value         = c?.privateKeyPath || '';
  $('#f-passphrase').value  = c?.passphrase  || '';
  setAuthTab(c?.authType || 'password');
  modal.classList.add('open');
  setTimeout(() => $('#f-host').focus(), 80);
}

function closeModal() { modal.classList.remove('open'); }

function setAuthTab(t) {
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.auth === t));
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.toggle('active', p.id === `auth-${t}`));
}

async function saveAndConnect() {
  const host = $('#f-host').value.trim();
  const user = $('#f-user').value.trim();
  if (!host || !user) { showToast('主机和用户名不能为空', 'error'); return; }

  const authType = document.querySelector('.auth-tab.active').dataset.auth;
  const c = {
    id:             editingId || uid(),
    name:           $('#f-name').value.trim() || host,
    host, port: parseInt($('#f-port').value) || 22,
    username:       user, authType,
    password:       authType === 'password' ? $('#f-pass').value : '',
    privateKeyPath: authType === 'key'      ? $('#f-key').value.trim() : '',
    passphrase:     authType === 'key'      ? $('#f-passphrase').value : '',
  };

  const btn = $('#modal-save-btn');
  btn.disabled = true; btn.textContent = '连接中…';

  connections = await window.electronAPI.saveConnection(c);
  renderConnList();
  closeModal();
  openSession(c);

  btn.disabled = false; btn.textContent = '保存并连接';
}

// ── Session ───────────────────────────────────────────────────────────────────
async function openSession(cfg) {
  const sessionId = uid();

  // Terminal pane
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.id = `pane-${sessionId}`;
  termCont.appendChild(pane);

  const term = new Terminal({
    theme: {
      background:'#0d0d14', foreground:'#c8cad8', cursor:'#6e8efb',
      selectionBackground:'#6e8efb44',
      black:'#1e1e2e', red:'#f87171', green:'#4ade80', yellow:'#fbbf24',
      blue:'#6e8efb', magenta:'#a78bfa', cyan:'#22d3ee', white:'#cdd6f4',
      brightBlack:'#45475a', brightRed:'#f38ba8', brightGreen:'#a6e3a1',
      brightYellow:'#f9e2af', brightBlue:'#89b4fa', brightMagenta:'#cba6f7',
      brightCyan:'#89dceb', brightWhite:'#b4befe',
    },
    fontFamily: "'SF Mono','JetBrains Mono','Fira Code',Menlo,monospace",
    fontSize: 13, lineHeight: 1.35,
    cursorBlink: true, cursorStyle: 'bar',
    scrollback: 5000, allowTransparency: true,
  });

  const fitAddon      = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(pane);
  fitAddon.fit();

  // ZMODEM sentry
  const zsentry = buildZSentry(sessionId, term);

  const sess = { sessionId, connId: cfg.id, label: cfg.name, term, fitAddon, pane, connected: false, zactive: false, ztransfer: null, zsentry };
  sessions.set(sessionId, sess);

  term.onData(d => { if (!sess.zactive) window.electronAPI.writeSSH(sessionId, Array.from(new TextEncoder().encode(d))); });
  term.onBinary(d => { if (!sess.zactive) window.electronAPI.writeSSH(sessionId, Array.from(d.split('').map(c => c.charCodeAt(0)))); });

  const ro = new ResizeObserver(() => {
    fitAddon.fit();
    window.electronAPI.resizeSSH(sessionId, term.cols, term.rows);
    if (activeId === sessionId) updateStatus();
  });
  ro.observe(termCont);
  sess.ro = ro;

  addTab(sessionId, cfg.name);
  activateSession(sessionId);
  welcome.classList.add('hidden');

  term.writeln(`\x1b[36mConnecting to ${cfg.username}@${cfg.host}:${cfg.port||22} …\x1b[0m`);
  setTabStatus(sessionId, 'connecting');

  try {
    await window.electronAPI.connectSSH({
      sessionId,
      host:           cfg.host,
      port:           cfg.port || 22,
      username:       cfg.username,
      password:       cfg.authType === 'password' ? cfg.password      : undefined,
      privateKeyPath: cfg.authType === 'key'      ? cfg.privateKeyPath: undefined,
      passphrase:     cfg.authType === 'key'      ? cfg.passphrase    : undefined,
    });

    sess.connected = true;
    term.writeln('\r\n\x1b[32m[已连接]  rz = 上传文件  |  sz <file> = 下载文件\x1b[0m\r\n');
    setTabStatus(sessionId, 'connected');
    renderConnList();
    if (activeId === sessionId) updateStatus();
    fitAddon.fit();
    window.electronAPI.resizeSSH(sessionId, term.cols, term.rows);

  } catch (err) {
    const msg = String(err);
    term.writeln('\r\n\x1b[31m┌─ 连接失败 ───────────────────────────────────────────┐\x1b[0m');
    msg.split('\n').forEach(l => l.trim() && term.writeln(`\x1b[31m│  ${l}\x1b[0m`));
    term.writeln('\x1b[31m└──────────────────────────────────────────────────────┘\x1b[0m');
    term.writeln('\x1b[33m  日志: ~/.remotetool/debug.log\x1b[0m\r\n');
    setTabStatus(sessionId, 'error');
    showToast('连接失败，详情见终端', 'error', 5000);
  }
}

function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  window.electronAPI.disconnectSSH(sessionId);
  s.ro?.disconnect();
  s.term.dispose();
  s.pane.remove();
  sessions.delete(sessionId);
  removeTab(sessionId);
  if (activeId === sessionId) {
    const ids = [...sessions.keys()];
    ids.length ? activateSession(ids[ids.length - 1]) : (() => { activeId = null; welcome.classList.remove('hidden'); updateStatus(); })();
  }
  renderConnList();
}

function activateSession(sessionId) {
  activeId = sessionId;
  document.querySelectorAll('.term-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.session === sessionId));
  const s = sessions.get(sessionId);
  if (s) { s.pane.classList.add('active'); s.fitAddon.fit(); s.term.focus(); }
  welcome.classList.toggle('hidden', !!sessionId);
  updateStatus();
}

// ── ZMODEM ────────────────────────────────────────────────────────────────────
function buildZSentry(sessionId, term) {
  // If Zmodem not loaded, return a passthrough stub
  if (typeof Zmodem === 'undefined') {
    console.warn('Zmodem not loaded — lrzsz disabled, SSH still works');
    return {
      consume: (bytes) => term.write(bytes),
    };
  }
  const sess = () => sessions.get(sessionId);
  return new Zmodem.Sentry({
    to_terminal: oct => term.write(new Uint8Array(oct)),
    sender:      oct => window.electronAPI.writeSSH(sessionId, Array.from(oct)),
    on_retract:  ()  => { const s=sess(); if(s){s.zactive=false;s.ztransfer=null;} hideTransfer(); },
    async on_detect(det) {
      const s = sess(); if (!s) return;
      s.zactive = true; s.ztransfer = det;
      const zs = det.confirm();
      if (zs.type === 'send') await handleRZ(sessionId, zs);
      else                    await handleSZ(sessionId, zs);
    },
  });
}

async function handleRZ(sessionId, zs) {
  const s = sessions.get(sessionId);
  showToast('rz 已触发，请选择要上传的文件…');
  const r = await window.electronAPI.showOpenDialog({ properties: ['openFile','multiSelections'] });
  if (r.canceled || !r.filePaths.length) { zs.abort(); if(s){s.zactive=false;} hideTransfer(); return; }
  
  const files = [];
  for (const fp of r.filePaths) {
    const res = await window.electronAPI.readFile(fp);
    if (res.ok) files.push({ name: res.name, data: new Uint8Array(res.data) });
  }
  
  if (!files.length) { zs.abort(); if(s){s.zactive=false;} hideTransfer(); return; }
  
  let idx = 0;
  for (const f of files) {
    idx++;
    showTransfer('upload', f.name, f.data.length, idx, files.length);
    const t0 = Date.now(); let sent = 0;
    
    await new Promise((resolve, reject) => {
      zs.send_offer({ name: f.name, size: f.data.length, mtime: new Date() }, xfer => {
        if (!xfer) { resolve(); return; }
        if (s) s.ztransfer = xfer;
        
        const CHUNK = 8192;
        let off = 0;
        
        xfer.accept().then(() => {
          function sendNextChunk() {
            if (off >= f.data.length) {
              xfer.end().then(resolve).catch(reject);
              return;
            }
            
            const remaining = f.data.length - off;
            const toSend = Math.min(CHUNK, remaining);
            const sl = f.data.slice(off, off + toSend);
            off += toSend;
            sent += toSend;
            
            updateTransfer(sent, f.data.length, t0);
            xfer.send(sl);
            
            queueMicrotask(sendNextChunk);
          }
          
          sendNextChunk();
        }).catch(reject);
        
        xfer.on('error', (e) => {
          reject(e);
        });
      });
    });
  }
  
  await zs.close();
  if (s) { s.zactive = false; s.ztransfer = null; }
  hideTransfer();
  showToast(`✅ 上传完成 (${files.length} 个文件)`, 'success');
}

async function handleSZ(sessionId, zs) {
  const s = sessions.get(sessionId);
  zs.on('session_end', () => { if(s){s.zactive=false;s.ztransfer=null;} hideTransfer(); showToast('✅ 下载完成','success'); });
  zs.on('offer', xfer => {
    const { name: filename = 'file', size: total = 0 } = xfer.get_details();
    showTransfer('download', filename, total, 1, 1);
    if (s) s.ztransfer = xfer;
    const chunks = []; let rx = 0; const t0 = Date.now();
    xfer.on('input', p => { chunks.push(new Uint8Array(p)); rx += p.length; updateTransfer(rx, total, t0); });
    xfer.accept().then(async () => {
      const merged = new Uint8Array(chunks.reduce((a,c)=>a+c.length,0));
      let off=0; for(const c of chunks){merged.set(c,off);off+=c.length;}
      const dr = await window.electronAPI.showSaveDialog({ filename });
      if (!dr.canceled && dr.filePath) {
        const w = await window.electronAPI.writeFile(dr.filePath, Array.from(merged));
        if (w.ok) { showToast(`✅ 已保存: ${filename}`, 'success'); window.electronAPI.revealFile(dr.filePath); }
        else showToast('保存失败: ' + w.error, 'error');
      }
    }).catch(e => showToast('接收失败: ' + e, 'error'));
  });
  zs.start();
}

// ── Transfer UI ───────────────────────────────────────────────────────────────
function showTransfer(dir, name, total, cur, tot) {
  $('#tr-icon').textContent  = dir === 'upload' ? '📤' : '📥';
  $('#tr-title').textContent = `${dir==='upload'?'上传':'下载'} ${cur}/${tot}`;
  $('#tr-filename').textContent = name;
  $('#tr-fill').style.width  = '0%';
  $('#tr-bytes').textContent = '0 B';
  $('#tr-pct').textContent   = '0%';
  $('#tr-speed').textContent = '-';
  trOverlay.style.display = 'flex';
  requestAnimationFrame(() => trOverlay.classList.add('show'));
  const st = $('#status-transfer');
  st.textContent = `${dir==='upload'?'↑':'↓'} ${name}`;
  st.classList.remove('hidden');
}
function hideTransfer() {
  trOverlay.classList.remove('show');
  setTimeout(() => { trOverlay.style.display = 'none'; }, 300);
  $('#status-transfer').classList.add('hidden');
}
function updateTransfer(rx, total, t0) {
  const pct = total > 0 ? Math.min(100, rx/total*100) : 0;
  const spd = (Date.now()-t0)/1000 > 0 ? rx/((Date.now()-t0)/1000) : 0;
  $('#tr-fill').style.width  = pct.toFixed(1) + '%';
  $('#tr-bytes').textContent = `${fmtBytes(rx)} / ${fmtBytes(total)}`;
  $('#tr-pct').textContent   = pct.toFixed(1) + '%';
  $('#tr-speed').textContent = fmtBytes(spd) + '/s';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function addTab(sessionId, label) {
  const t = document.createElement('div');
  t.className = 'tab'; t.dataset.session = sessionId;
  t.innerHTML = `<div class="tab-status"></div><div class="tab-label">${label}</div><div class="tab-close">✕</div>`;
  t.addEventListener('click', e => {
    if (e.target.classList.contains('tab-close')) { closeSession(sessionId); return; }
    activateSession(sessionId);
  });
  tabBar.appendChild(t);
}
function removeTab(id) { tabBar.querySelector(`[data-session="${id}"]`)?.remove(); }
function setTabStatus(id, s) {
  const t = tabBar.querySelector(`[data-session="${id}"]`);
  if (!t) return;
  t.classList.remove('connected','error','connecting');
  if (s === 'connected')  t.classList.add('connected');
  if (s === 'error')      t.classList.add('error');
}

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatus() {
  const s = sessions.get(activeId);
  if (!s) { stDot.className='status-dot'; stText.textContent='未连接'; stSize.textContent='-'; return; }
  stDot.className = s.connected ? 'status-dot green' : 'status-dot';
  stText.textContent = s.connected ? s.label : `${s.label} (已断开)`;
  stSize.textContent = `${s.term.cols}×${s.term.rows}`;
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  $('#btn-new-conn').addEventListener('click', () => openModal());
  $('#modal-save-btn').addEventListener('click', saveAndConnect);
  $('#modal-cancel-btn').addEventListener('click', closeModal);
  $('#modal-close-btn').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  document.querySelectorAll('.auth-tab').forEach(b => b.addEventListener('click', () => setAuthTab(b.dataset.auth)));

  $('#btn-browse-key').addEventListener('click', async () => {
    const r = await window.electronAPI.showOpenDialog({ title: '选择私钥' });
    if (!r.canceled && r.filePaths[0]) $('#f-key').value = r.filePaths[0];
  });

  document.querySelectorAll('.modal input').forEach(inp =>
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveAndConnect(); })
  );

  $('#tr-close-btn').addEventListener('click', hideTransfer);
  $('#tr-cancel-btn').addEventListener('click', () => {
    const s = sessions.get(activeId);
    if (s?.ztransfer) try { s.ztransfer.abort?.(); } catch (_) {}
    hideTransfer(); showToast('传输已取消');
  });

  document.addEventListener('keydown', e => {
    if (e.metaKey && e.key === 'w') { e.preventDefault(); if (activeId) closeSession(activeId); }
    if (e.metaKey && e.key === 'n') { e.preventDefault(); openModal(); }
    if (e.metaKey && (e.key===']'||e.key==='[')) {
      e.preventDefault();
      const ks = [...sessions.keys()], i = ks.indexOf(activeId);
      const nx = e.key===']' ? (i+1)%ks.length : (i-1+ks.length)%ks.length;
      if (ks[nx]) activateSession(ks[nx]);
    }
  });
}

window.addEventListener('DOMContentLoaded', init);
