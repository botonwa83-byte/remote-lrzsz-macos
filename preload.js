const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── SSH ────────────────────────────────────────────────────────────────
  connectSSH:    (cfg)                => ipcRenderer.invoke('ssh-connect', cfg),
  writeSSH:      (sessionId, data)    => ipcRenderer.send('ssh-write', { sessionId, data }),
  resizeSSH:     (sessionId, c, r)    => ipcRenderer.send('ssh-resize', { sessionId, cols: c, rows: r }),
  disconnectSSH: (sessionId)          => ipcRenderer.send('ssh-disconnect', { sessionId }),

  onSSHData:   (cb) => ipcRenderer.on('ssh-data',   (_, d) => cb(d)),
  onSSHClosed: (cb) => ipcRenderer.on('ssh-closed', (_, d) => cb(d)),

  offSSHData:   () => ipcRenderer.removeAllListeners('ssh-data'),
  offSSHClosed: () => ipcRenderer.removeAllListeners('ssh-closed'),

  // ── File dialogs ───────────────────────────────────────────────────────
  showSaveDialog: (opts) => ipcRenderer.invoke('show-save-dialog', opts),
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  writeFile:      (fp, data) => ipcRenderer.invoke('write-file', { filePath: fp, data }),
  readFile:       (fp)       => ipcRenderer.invoke('read-file',  { filePath: fp }),
  revealFile:     (fp)       => ipcRenderer.invoke('reveal-file',{ filePath: fp }),

  // ── Saved connections ──────────────────────────────────────────────────
  getConnections:    ()     => ipcRenderer.invoke('get-connections'),
  saveConnection:    (conn) => ipcRenderer.invoke('save-connection', conn),
  deleteConnection:  (id)   => ipcRenderer.invoke('delete-connection', id),
});
