'use strict';

// Electron must be required before any project module so `require('electron')` resolves to the API, not the npm path stub.
const { app, BrowserWindow } = require('electron');

const { createWindow } = require('./main/window');
const { createTray } = require('./main/tray');
const { registerIpcHandlers } = require('./main/ipc-handlers');
const { startBackendWithRetry, killBackendByName } = require('./main/backend-process');

let mainWindow;

app.whenReady().then(() => {
  registerIpcHandlers();
  mainWindow = createWindow();
  createTray(mainWindow);
  startBackendWithRetry();

  if (process.argv.includes('--hidden')) {
    mainWindow.hide();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killBackendByName('VolumeMaster-Headless.exe');
});

try {
  require('electron-reloader')(module);
} catch {}
