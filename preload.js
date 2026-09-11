'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
};
const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('deck', {
  // sessions
  start: invoke('session:start'),
  kill: invoke('session:kill'),
  input: (id, data) => ipcRenderer.send('session:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  onData: on('session:data'),
  onExit: on('session:exit'),
  onFocusTab: on('focus-tab'),
  tmuxList: invoke('tmux:list'),
  tmuxKill: invoke('tmux:kill'),
  onPrompt: on('prompt:ask'),
  answerPrompt: (rid, value) => ipcRenderer.send('prompt:answer', { rid, value }),

  // hosts & config
  hosts: invoke('hosts:list'),
  addHost: invoke('hosts:add'),
  removeHost: invoke('hosts:remove'),
  testHost: invoke('hosts:test'),
  getConfig: invoke('config:get'),
  setConfig: invoke('config:set'),

  // files
  list: invoke('fs:list'),
  recent: invoke('fs:recent'),
  fetch: invoke('fs:fetch'),
  readText: invoke('fs:readText'),
  openExternal: invoke('fs:openExternal'),
  showInFolder: invoke('fs:showInFolder'),
  saveAs: invoke('fs:saveAs'),
  upload: invoke('fs:upload'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFile: invoke('dialog:pickFile'),
  pickDir: invoke('dialog:pickDir'),

  // clipboard
  clipRead: invoke('clip:read'),
  clipImage: invoke('clip:image'),
  clipWrite: (text) => ipcRenderer.send('clip:write', text),

  // misc
  notify: (o) => ipcRenderer.send('notify', o),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  devtools: () => ipcRenderer.send('devtools'),
});
