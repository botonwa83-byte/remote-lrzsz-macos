const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  connectSSH:    cfg            => ipcRenderer.invoke('ssh-connect', cfg),
  writeSSH:      (sid, data)    => ipcRenderer.send('ssh-write',    { sessionId: sid, data }),
  resizeSSH:     (sid, c, r)    => ipcRenderer.send('ssh-resize',   { sessionId: sid, cols: c, rows: r }),
  disconnectSSH: sid            => ipcRenderer.send('ssh-disconnect',{ sessionId: sid }),

  onSSHData:   cb => ipcRenderer.on('ssh-data',   (_, d) => cb(d)),
  onSSHClosed: cb => ipcRenderer.on('ssh-closed', (_, d) => cb(d)),
  offAll:      () => { ipcRenderer.removeAllListeners('ssh-data'); ipcRenderer.removeAllListeners('ssh-closed'); },

  showSaveDialog: o  => ipcRenderer.invoke('show-save-dialog', o),
  showOpenDialog: o  => ipcRenderer.invoke('show-open-dialog', o),
  writeFile:   (p,d) => ipcRenderer.invoke('write-file',  { filePath: p, data: d }),
  readFile:    p     => ipcRenderer.invoke('read-file',   { filePath: p }),
  revealFile:  p     => ipcRenderer.invoke('reveal-file', { filePath: p }),

  getSshpassStatus: () => ipcRenderer.invoke('get-sshpass-status'),

  getConnections:   ()  => ipcRenderer.invoke('get-connections'),
  saveConnection:   c   => ipcRenderer.invoke('save-connection', c),
  deleteConnection: id  => ipcRenderer.invoke('delete-connection', id),
});
