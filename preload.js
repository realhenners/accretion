const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Only these channels can be used from the pages.
const IN = ['init', 'role', 'displays', 'origin', 'settings', 'state', 'input', 'take-screenshot', 'frame', 'shot-frame',
            'probe-result', 'meal', 'spit', 'toast', 'nearest-result', 'paused', 'scope', 'holes', 'stats', 'card', 'worm', 'steal', 'dream', 'draw-model', 'horizon', 'update'];
const OUT = ['hit', 'input', 'state', 'menu', 'screenshot', 'next-frame', 'stats', 'log', 'probe', 'eat', 'release',
             'set-settings', 'reset-settings', 'set-hole', 'drop-files', 'nearest', 'rename', 'pet-event', 'share-card', 'drop-text', 'steal', 'nudge', 'spit-one', 'model-picture', 'drop-image-data', 'drop-image-url', 'journal', 'show-tour', 'tour-done', 'path', 'reload-plugins', 'open-folder', 'rename-prompt', 'rename-close', 'settings-compact', 'update-install'];
const INVOKE = ['get-settings', 'get-holes', 'accent', 'max-hz', 'look-keys', 'shortcuts', 'achievements', 'share-code', 'import-code', 'portrait', 'stomach', 'breed', 'gallery', 'profile', 'monitors', 'export-all', 'import-all', 'journal-get', 'self-test', 'plugins', 'crash-reports', 'about', 'update-check', 'update-state'];

contextBridge.exposeInMainWorld('app', {
  on: (ch, cb) => { if (IN.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => cb(...a)); },
  send: (ch, ...a) => { if (OUT.includes(ch)) ipcRenderer.send(ch, ...a); },
  invoke: (ch, ...a) => INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('no such call')),
  // Where a file dropped on a hole lives on disk (only read for its icon, name and size; never touched).
  pathOf: file => webUtils.getPathForFile(file),
});
